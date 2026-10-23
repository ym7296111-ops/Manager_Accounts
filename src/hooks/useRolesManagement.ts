import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { PostgrestError } from '@supabase/supabase-js';
import type { TranslationKey } from '@/i18n/I18nContext';
import { getSupabase } from '@/lib/supabase';

/**
 * Roles & Permissions data layer (screen 2 of the settings screens).
 *
 * * ONE TanStack Query cache entry keyed `['roles-permissions']` is the single
 *   source of truth. The whole RBAC matrix (roles x permissions catalog with
 *   grants, actor holdings and assignee counts) arrives in ONE PostgREST round
 *   trip through the `role_permission_matrix` security_invoker view — so empty
 *   roles and orphan permissions are always visible, never N+1, never partial.
 * * NO Realtime on this screen (administrative changes are rare): plain
 *   fetching plus targeted cache invalidation after every successful save.
 * * Bulk saves go through the SECURITY DEFINER RPC
 *   `admin_set_role_permissions(target_role_id, permission_slugs)` — the only
 *   sanctioned write path (direct writes on `role_permissions` are revoked and
 *   trigger-blocked at the database). The function is atomic (diff-based) and
 *   re-runs the lockout guards server-side.
 * * Lockout guards are synchronous pure functions evaluated BEFORE any network
 *   call: Self-Demotion Guard (capability-based across every role the actor
 *   holds) and the `super_admin`-keeps-`*` invariant. Failures are normalized
 *   to locale-independent codes that map onto the bilingual dictionary.
 */

/* ------------------------------------------------------------------ types */

/** Normalized, locale-independent failure codes for the whole screen. */
export type RolesManagementErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'not-found'
  | 'noop'
  | 'in-flight'
  | 'self-demotion'
  | 'last-admin-lockout'
  | 'system-role-locked'
  | 'rate-limited'
  | 'network'
  | 'unknown';

/** Reasons a toggle/save is blocked synchronously, before any request. */
export type SaveBlocker = Extract<
  RolesManagementErrorCode,
  'self-demotion' | 'last-admin-lockout' | 'system-role-locked' | 'noop' | 'forbidden' | 'not-found'
>;

/** Why a single checkbox is protected (rendered with `aria-disabled`). */
export type ProtectedReason = Extract<
  RolesManagementErrorCode,
  'self-demotion' | 'system-role-locked'
>;

/** One permission leaf of the catalog (mirrors `public.permissions`). */
export interface PermissionItem {
  readonly id: string;
  readonly slug: string;
  readonly module: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly description: string | null;
}

/** Logical group: `module` ← its permissions (the catalog tree, level 2). */
export interface PermissionGroup {
  readonly module: string;
  readonly permissions: readonly PermissionItem[];
}

/** Domain view model for one row of `public.roles`. */
export interface ManagedRole {
  readonly id: string;
  readonly slug: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly isSystem: boolean;
  /** How many users would be affected by edits to this role. */
  readonly assignedUserCount: number;
  /** Baseline grant ids currently stored in `role_permissions`. */
  readonly permissionIds: readonly string[];
  /** True when the signed-in actor holds this role through `user_roles`. */
  readonly heldByActor: boolean;
}

/** Editable state for one role's matrix — the diff is derived, never stored. */
export interface RolePermissionDraft {
  readonly roleId: string;
  readonly baselineIds: ReadonlySet<string>;
  readonly selectedIds: ReadonlySet<string>;
  /** `selectedIds − baselineIds`, sorted for stable rendering. */
  readonly grantedIds: readonly string[];
  /** `baselineIds − selectedIds`, sorted for stable rendering. */
  readonly revokedIds: readonly string[];
  readonly isDirty: boolean;
}

/** Master-checkbox state of one group (drives native `indeterminate`). */
export type GroupToggleState = 'none' | 'some' | 'all';

/** Summary of a bulk group toggle, used for the polite live announcement. */
export interface GroupToggleSummary {
  readonly added: number;
  readonly removed: number;
  readonly keptProtected: number;
}

/** Everything the pure lockout guards need about the actor and the target. */
export interface RoleGuardContext {
  /** Role currently being edited. */
  readonly roleId: string;
  /** Slug of the edited role (`super_admin` invariant). */
  readonly roleSlug: string;
  /** Ids of every role the actor holds. */
  readonly actorRoleIds: ReadonlySet<string>;
  /** Baseline permission slugs per role id (source of truth before the edit). */
  readonly baselineSlugsByRole: ReadonlyMap<string, ReadonlySet<string>>;
}

/** Pre-network save guard input. */
export interface SaveBlockerContext extends RoleGuardContext {
  /** Slugs currently selected in the draft for the edited role. */
  readonly selectedSlugs: ReadonlySet<string>;
  readonly isDirty: boolean;
  readonly actorIsSuperAdmin: boolean;
}

/** Result of `save` — a discriminated union; nothing is thrown. */
export type SaveRolePermissionsResult =
  | {
      readonly ok: true;
      readonly roleId: string;
      readonly granted: readonly string[];
      readonly revoked: readonly string[];
    }
  | { readonly ok: false; readonly roleId: string; readonly code: RolesManagementErrorCode };

/** Parsed payload of the single-round-trip matrix query. */
export interface RolesMatrix {
  readonly roles: readonly ManagedRole[];
  readonly groups: readonly PermissionGroup[];
  readonly permissionsById: ReadonlyMap<string, PermissionItem>;
  readonly baselineSlugsByRole: ReadonlyMap<string, ReadonlySet<string>>;
  readonly actorRoleIds: ReadonlySet<string>;
  readonly actorIsSuperAdmin: boolean;
}

/* -------------------------------------------------------- dictionary keys */

/** Every failure code → its bilingual dictionary key. */
export const ROLES_ERROR_KEYS: Record<RolesManagementErrorCode, TranslationKey> = {
  unavailable: 'roles.error.unavailable',
  forbidden: 'roles.error.forbidden',
  'not-found': 'roles.error.notFound',
  noop: 'roles.error.noop',
  'in-flight': 'roles.error.inFlight',
  'self-demotion': 'roles.error.selfDemotion',
  'last-admin-lockout': 'roles.error.lastAdmin',
  'system-role-locked': 'roles.error.systemRole',
  'rate-limited': 'roles.error.rateLimited',
  network: 'roles.error.network',
  unknown: 'roles.error.unknown',
};

/** Every synchronous blocker → the explanation shown next to the control. */
export const ROLES_BLOCKER_KEYS: Record<SaveBlocker, TranslationKey> = {
  'self-demotion': 'roles.block.selfDemotion',
  'last-admin-lockout': 'roles.block.lastAdmin',
  'system-role-locked': 'roles.block.systemRole',
  noop: 'roles.block.noop',
  forbidden: 'roles.block.forbidden',
  'not-found': 'roles.block.notFound',
};

/** Protected-checkbox explanations, keyed by reason. */
export const ROLES_PROTECTED_KEYS: Record<ProtectedReason, TranslationKey> = {
  'self-demotion': 'roles.block.selfDemotion',
  'system-role-locked': 'roles.block.systemRole',
};

/* ------------------------------------------------------------- constants */

/** The single cache key for the screen. */
export const ROLES_QUERY_KEY = ['roles-permissions'] as const;

/** System role that grants `*` (and therefore `is_admin()` on the server). */
export const SUPER_ADMIN_SLUG = 'super_admin';

/** Wildcard permission that grants every capability. */
export const WILDCARD_SLUG = '*';

/**
 * Capabilities the guards protect: losing either one — through ANY role the
 * actor holds — is a self-demotion. `*` is treated as granting both.
 */
export const CRITICAL_SLUGS = ['*', 'roles.manage'] as const;

/** Deterministic display order of the logical groups (unknown modules last). */
export const MODULE_RANK: Readonly<Record<string, number>> = {
  system: 0,
  dashboard: 1,
  workspace: 2,
  app: 3,
};

/** Cartesian catalog guard: roles x permissions must fit in one response. */
const MATRIX_MAX_ROWS = 5000;

/** v1 writes one role per save; in-flight saves are rejected, not queued. */
const SAVE_IN_FLIGHT = 'roles-save';

/* ------------------------------------------------------------ error model */

/** Internal error carrying a normalized code; raw Supabase errors never leave this module. */
export class RolesManagementError extends Error {
  readonly code: RolesManagementErrorCode;

  constructor(code: RolesManagementErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'RolesManagementError';
    this.code = code;
  }
}

function mapPostgrestError(error: PostgrestError): RolesManagementError {
  const message = error.message.toLowerCase();

  if (error.code === '42501') {
    return new RolesManagementError('forbidden');
  }
  if (error.code === 'P0002') {
    return new RolesManagementError('not-found');
  }
  /* Custom SQLSTATEs raised by admin_set_role_permissions. */
  if (error.code === 'RBA01' || message.includes('self-demotion')) {
    return new RolesManagementError('self-demotion');
  }
  if (error.code === 'RBA02' || message.includes('last-admin-lockout')) {
    return new RolesManagementError('last-admin-lockout');
  }
  if (error.code === 'RBA03' || message.includes('system-role-locked')) {
    return new RolesManagementError('system-role-locked');
  }
  /* Missing view/RPC → the migration has not been applied in this environment. */
  if (error.code === 'PGRST202' || error.code === 'PGRST205') {
    return new RolesManagementError('unavailable');
  }
  if (error.code === 'PGRST301' || message.includes('jwt')) {
    return new RolesManagementError('forbidden');
  }
  if (message.includes('rate limit') || message.includes('too many')) {
    return new RolesManagementError('rate-limited');
  }
  if (message.includes('failed to fetch') || message.includes('network')) {
    return new RolesManagementError('network');
  }
  return new RolesManagementError('unknown');
}

function toErrorCode(caught: unknown): RolesManagementErrorCode {
  if (caught instanceof RolesManagementError) {
    return caught.code;
  }
  if (caught instanceof TypeError) {
    return 'network';
  }
  return 'unknown';
}

/* ------------------------------------------------------- runtime parsing */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
}

/* ---------------------------------------------------------- pure helpers */

/** Compare two catalog leaves deterministically (stable across refetches). */
function comparePermissions(a: PermissionItem, b: PermissionItem): number {
  return a.slug.localeCompare(b.slug) || a.id.localeCompare(b.id);
}

/**
 * Group the flat permission catalog by `module`, in deterministic order:
 * known modules first (MODULE_RANK), unknown ones alphabetically after.
 */
export function groupPermissionsByModule(permissions: Iterable<PermissionItem>): PermissionGroup[] {
  const byModule = new Map<string, PermissionItem[]>();
  for (const permission of permissions) {
    const bucket = byModule.get(permission.module);
    if (bucket === undefined) {
      byModule.set(permission.module, [permission]);
    } else {
      bucket.push(permission);
    }
  }

  const modules = [...byModule.keys()].sort((a, b) => {
    const rankA = MODULE_RANK[a] ?? Number.MAX_SAFE_INTEGER;
    const rankB = MODULE_RANK[b] ?? Number.MAX_SAFE_INTEGER;
    return rankA - rankB || a.localeCompare(b);
  });

  return modules.map((module) => ({
    module,
    permissions: (byModule.get(module) ?? []).slice().sort(comparePermissions),
  }));
}

/** `none` / `some` (native indeterminate) / `all` over the group's leaves. */
export function computeGroupState(
  group: PermissionGroup,
  selectedIds: ReadonlySet<string>,
): GroupToggleState {
  if (group.permissions.length === 0) {
    return 'none';
  }
  let selected = 0;
  for (const permission of group.permissions) {
    if (selectedIds.has(permission.id)) {
      selected += 1;
    }
  }
  if (selected === 0) {
    return 'none';
  }
  return selected === group.permissions.length ? 'all' : 'some';
}

/** Derive the draft (diff included) from a baseline role + a selection. */
export function buildDraft(
  role: ManagedRole,
  selectedIds: ReadonlySet<string>,
): RolePermissionDraft {
  const baselineIds = new Set(role.permissionIds);
  const granted: string[] = [];
  const revoked: string[] = [];
  for (const id of selectedIds) {
    if (!baselineIds.has(id)) {
      granted.push(id);
    }
  }
  for (const id of baselineIds) {
    if (!selectedIds.has(id)) {
      revoked.push(id);
    }
  }
  granted.sort();
  revoked.sort();
  return {
    roleId: role.id,
    baselineIds,
    selectedIds,
    grantedIds: granted,
    revokedIds: revoked,
    isDirty: granted.length > 0 || revoked.length > 0,
  };
}

/* ----------------------------------------------------------- lockout math */

/**
 * Capability semantics mirror `public.has_permission`: holding `*` grants
 * every capability, so `*` counts as both `*` and `roles.manage`.
 */
function hasCapability(slugs: ReadonlySet<string>, capability: string): boolean {
  return slugs.has(capability) || slugs.has(WILDCARD_SLUG);
}

/** Union of slugs the actor would hold if the edited role had `editedSlugs`. */
function actorEffectiveSlugs(
  context: RoleGuardContext,
  editedSlugs: ReadonlySet<string>,
): Set<string> {
  const union = new Set<string>();
  for (const roleId of context.actorRoleIds) {
    const source =
      roleId === context.roleId ? editedSlugs : context.baselineSlugsByRole.get(roleId);
    if (source === undefined) {
      continue;
    }
    for (const slug of source) {
      union.add(slug);
    }
  }
  return union;
}

/** Would the actor lose any critical capability (vs. the stored baseline)? */
function wouldDemoteActor(context: RoleGuardContext, editedSlugs: ReadonlySet<string>): boolean {
  const before = actorEffectiveSlugs(
    context,
    context.baselineSlugsByRole.get(context.roleId) ?? new Set(),
  );
  const after = actorEffectiveSlugs(context, editedSlugs);
  for (const capability of CRITICAL_SLUGS) {
    if (hasCapability(before, capability) && !hasCapability(after, capability)) {
      return true;
    }
  }
  return false;
}

/**
 * Why unchecking `permissionSlug` (currently selected in `currentSlugs`) is
 * protected — or `null` when the toggle is free. Checking anything is always
 * safe, so unselected permissions are never protected.
 *
 * * `system-role-locked` — `super_admin` must keep `*` (database invariant).
 * * `self-demotion`     — the actor would lose a critical capability through
 *   ALL of their roles (capability-based, not membership-based).
 */
export function getPermissionProtection(
  permissionSlug: string,
  currentSlugs: ReadonlySet<string>,
  context: RoleGuardContext,
): ProtectedReason | null {
  if (!currentSlugs.has(permissionSlug)) {
    return null;
  }
  if (context.roleSlug === SUPER_ADMIN_SLUG && permissionSlug === WILDCARD_SLUG) {
    return 'system-role-locked';
  }
  if (permissionSlug !== WILDCARD_SLUG && permissionSlug !== 'roles.manage') {
    return null;
  }

  const without = new Set(currentSlugs);
  without.delete(permissionSlug);
  return wouldDemoteActor(context, without) ? 'self-demotion' : null;
}

/**
 * Synchronous save guard — evaluated BEFORE any network call:
 *
 * * `not-found`          — the edited role vanished from the cache.
 * * `forbidden`          — the actor is not a super admin (403 gate).
 * * `noop`               — nothing changed yet.
 * * `system-role-locked` — the draft strips `*` from `super_admin`.
 * * `self-demotion`      — the draft would strip a critical capability from
 *   the actor (catches COMBINATIONS of individually-safe toggles).
 */
export function getSaveBlocker(context: SaveBlockerContext): SaveBlocker | null {
  if (context.roleSlug === '') {
    return 'not-found';
  }
  if (!context.actorIsSuperAdmin) {
    return 'forbidden';
  }
  if (!context.isDirty) {
    return 'noop';
  }
  if (context.roleSlug === SUPER_ADMIN_SLUG && !context.selectedSlugs.has(WILDCARD_SLUG)) {
    return 'system-role-locked';
  }
  if (wouldDemoteActor(context, context.selectedSlugs)) {
    return 'self-demotion';
  }
  return null;
}

/* ------------------------------------------------- matrix wire → domain */

interface ParsedRoleRow {
  readonly id: string;
  readonly slug: string;
  readonly nameAr: string;
  readonly nameEn: string;
  readonly isSystem: boolean;
  readonly assignedUserCount: number;
  readonly heldByActor: boolean;
  readonly grantedIds: string[];
}

/**
 * Parse the `role_permission_matrix` response (cartesian rows) into the
 * screen's domain model. Roles with zero grants and permissions granted to
 * nobody both survive here — that completeness is the point of the view.
 */
export function parseMatrix(data: unknown): RolesMatrix {
  const permissionsById = new Map<string, PermissionItem>();
  const rolesById = new Map<string, ParsedRoleRow>();

  if (Array.isArray(data)) {
    for (const value of data) {
      if (!isRecord(value)) {
        continue;
      }
      const permissionId = asString(value['permission_id']);
      const roleId = asString(value['role_id']);
      if (permissionId === '' || roleId === '') {
        continue;
      }

      if (!permissionsById.has(permissionId)) {
        permissionsById.set(permissionId, {
          id: permissionId,
          slug: asString(value['permission_slug']),
          module: asString(value['permission_module']),
          nameAr: asString(value['permission_name_ar']),
          nameEn: asString(value['permission_name_en']),
          description: asNullableString(value['permission_description']),
        });
      }

      let roleRow = rolesById.get(roleId);
      if (roleRow === undefined) {
        roleRow = {
          id: roleId,
          slug: asString(value['role_slug']),
          nameAr: asString(value['role_name_ar']),
          nameEn: asString(value['role_name_en']),
          isSystem: asBoolean(value['role_is_system']),
          assignedUserCount: asCount(value['assigned_user_count']),
          heldByActor: asBoolean(value['held_by_actor']),
          grantedIds: [],
        };
        rolesById.set(roleId, roleRow);
      }
      if (asBoolean(value['granted'])) {
        roleRow.grantedIds.push(permissionId);
      }
    }
  }

  const baselineSlugsByRole = new Map<string, ReadonlySet<string>>();
  const actorRoleIds = new Set<string>();
  const roles: ManagedRole[] = [];

  for (const row of rolesById.values()) {
    row.grantedIds.sort();
    const slugs = new Set<string>();
    for (const permissionId of row.grantedIds) {
      const permission = permissionsById.get(permissionId);
      if (permission !== undefined) {
        slugs.add(permission.slug);
      }
    }
    baselineSlugsByRole.set(row.id, slugs);
    if (row.heldByActor) {
      actorRoleIds.add(row.id);
    }
    roles.push({
      id: row.id,
      slug: row.slug,
      nameAr: row.nameAr,
      nameEn: row.nameEn,
      isSystem: row.isSystem,
      assignedUserCount: row.assignedUserCount,
      permissionIds: row.grantedIds,
      heldByActor: row.heldByActor,
    });
  }

  /* Deterministic order keeps refetches from reshuffling what is on screen. */
  roles.sort((a, b) => a.slug.localeCompare(b.slug) || a.id.localeCompare(b.id));

  /* `is_admin()` semantics: the actor holds `*` through ANY of their roles. */
  const wildcardId = [...permissionsById.values()].find((p) => p.slug === WILDCARD_SLUG)?.id;
  const actorIsSuperAdmin =
    wildcardId !== undefined &&
    roles.some((role) => role.heldByActor && role.permissionIds.includes(wildcardId));

  return {
    roles,
    groups: groupPermissionsByModule(permissionsById.values()),
    permissionsById,
    baselineSlugsByRole,
    actorRoleIds,
    actorIsSuperAdmin,
  };
}

/* ---------------------------------------------------------------- fetch */

interface QueryResult {
  readonly data: unknown;
  readonly error: PostgrestError | null;
}

interface RpcResult {
  readonly data: unknown;
  readonly error: PostgrestError | null;
}

/** The complete screen payload, in ONE round trip (no N+1, no partial data). */
const MATRIX_COLUMNS = [
  'role_id',
  'role_slug',
  'role_name_ar',
  'role_name_en',
  'role_is_system',
  'permission_id',
  'permission_slug',
  'permission_module',
  'permission_name_ar',
  'permission_name_en',
  'permission_description',
  'granted',
  'held_by_actor',
  'assigned_user_count',
].join(', ');

const EMPTY_MATRIX: RolesMatrix = {
  roles: [],
  groups: [],
  permissionsById: new Map(),
  baselineSlugsByRole: new Map(),
  actorRoleIds: new Set(),
  actorIsSuperAdmin: false,
};

async function fetchMatrix(): Promise<RolesMatrix> {
  const client = getSupabase();
  if (client === null) {
    throw new RolesManagementError('unavailable');
  }

  try {
    const { data, error } = (await client
      .from('role_permission_matrix')
      .select(MATRIX_COLUMNS)
      .range(0, MATRIX_MAX_ROWS - 1)) as QueryResult;

    if (error !== null) {
      throw mapPostgrestError(error);
    }
    return parseMatrix(data);
  } catch (caught) {
    if (caught instanceof RolesManagementError) {
      throw caught;
    }
    throw new RolesManagementError(toErrorCode(caught));
  }
}

/** Slugs of the draft selection, sorted (the RPC consumes slugs, not ids). */
function selectedSlugsFor(
  selectedIds: ReadonlySet<string>,
  permissionsById: ReadonlyMap<string, PermissionItem>,
): Set<string> {
  const slugs = new Set<string>();
  for (const id of selectedIds) {
    const permission = permissionsById.get(id);
    if (permission !== undefined && permission.slug !== '') {
      slugs.add(permission.slug);
    }
  }
  return slugs;
}

function parseRpcSlugs(value: unknown, key: string): string[] {
  if (!isRecord(value) || !Array.isArray(value[key])) {
    return [];
  }
  return (value[key] as readonly unknown[]).filter(
    (entry): entry is string => typeof entry === 'string',
  );
}

/* ----------------------------------------------------------------- hook */

export interface RolesManagementApi {
  readonly roles: readonly ManagedRole[];
  readonly groups: readonly PermissionGroup[];
  readonly permissionsById: ReadonlyMap<string, PermissionItem>;
  readonly actorIsSuperAdmin: boolean;
  readonly isInitialLoading: boolean;
  readonly isRefreshing: boolean;
  readonly fetchError: RolesManagementErrorCode | null;
  readonly lastSyncedAt: number | null;
  readonly refresh: () => void;

  readonly selectedRole: ManagedRole | null;
  readonly selectRole: (roleId: string) => void;
  readonly draft: RolePermissionDraft | null;
  /** Non-null per protected checkbox of the current draft (id → reason). */
  readonly protectedReasons: ReadonlyMap<string, ProtectedReason>;
  /** Why saving is blocked right now (null = savable). */
  readonly saveBlocker: SaveBlocker | null;
  /** Toggle one checkbox; returns the reason when the toggle was refused. */
  readonly togglePermission: (permissionId: string) => ProtectedReason | null;
  /** Bulk-toggle one group (clearing skips protected leaves one by one). */
  readonly toggleGroup: (module: string, checked: boolean) => GroupToggleSummary;
  readonly getGroupState: (module: string) => GroupToggleState;
  readonly resetDraft: () => void;

  readonly isSaving: boolean;
  readonly save: () => Promise<SaveRolePermissionsResult>;
}

export function useRolesManagement(): RolesManagementApi {
  const queryClient = useQueryClient();
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [isSaving, setIsSaving] = useState(false);
  const inFlightRef = useRef<Set<string>>(new Set());

  const query = useQuery({
    queryKey: ROLES_QUERY_KEY,
    queryFn: fetchMatrix,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    /* Auto-retry with backoff for transient network failures only. */
    retry: (failureCount, error) =>
      error instanceof RolesManagementError && error.code === 'network' && failureCount < 2,
  });

  const matrix = query.data ?? EMPTY_MATRIX;

  const selectedRole = useMemo(
    () => matrix.roles.find((role) => role.id === selectedRoleId) ?? null,
    [matrix.roles, selectedRoleId],
  );

  const draft = useMemo(
    () => (selectedRole === null ? null : buildDraft(selectedRole, selectedIds)),
    [selectedRole, selectedIds],
  );

  const guardContext = useMemo<RoleGuardContext | null>(() => {
    if (selectedRole === null) {
      return null;
    }
    return {
      roleId: selectedRole.id,
      roleSlug: selectedRole.slug,
      actorRoleIds: matrix.actorRoleIds,
      baselineSlugsByRole: matrix.baselineSlugsByRole,
    };
  }, [selectedRole, matrix.actorRoleIds, matrix.baselineSlugsByRole]);

  /** Dynamic protection: re-evaluated against the live draft on every toggle. */
  const protectedReasons = useMemo(() => {
    const reasons = new Map<string, ProtectedReason>();
    if (guardContext === null || draft === null) {
      return reasons;
    }
    const slugs = selectedSlugsFor(draft.selectedIds, matrix.permissionsById);
    for (const id of draft.selectedIds) {
      const permission = matrix.permissionsById.get(id);
      if (permission === undefined) {
        continue;
      }
      const reason = getPermissionProtection(permission.slug, slugs, guardContext);
      if (reason !== null) {
        reasons.set(id, reason);
      }
    }
    return reasons;
  }, [guardContext, draft, matrix.permissionsById]);

  /* Switching roles seeds the draft from the new role's baseline. */
  const selectRole = useCallback(
    (roleId: string) => {
      setSelectedRoleId(roleId);
      const role = matrix.roles.find((entry) => entry.id === roleId);
      setSelectedIds(new Set(role?.permissionIds ?? []));
    },
    [matrix.roles],
  );

  const togglePermission = useCallback(
    (permissionId: string): ProtectedReason | null => {
      const permission = matrix.permissionsById.get(permissionId);
      const role = selectedRole;
      if (permission === undefined || role === null || guardContext === null) {
        return null;
      }

      const currentSlugs = selectedSlugsFor(selectedIds, matrix.permissionsById);
      if (!selectedIds.has(permissionId)) {
        /* Checking is always safe. */
        setSelectedIds((previous) => new Set(previous).add(permissionId));
        return null;
      }

      const reason = getPermissionProtection(permission.slug, currentSlugs, guardContext);
      if (reason !== null) {
        return reason;
      }
      setSelectedIds((previous) => {
        const next = new Set(previous);
        next.delete(permissionId);
        return next;
      });
      return null;
    },
    [matrix.permissionsById, selectedRole, guardContext, selectedIds],
  );

  const toggleGroup = useCallback(
    (module: string, checked: boolean): GroupToggleSummary => {
      const group = matrix.groups.find((entry) => entry.module === module);
      if (group === undefined || guardContext === null) {
        return { added: 0, removed: 0, keptProtected: 0 };
      }

      const next = new Set(selectedIds);
      let added = 0;
      let removed = 0;
      let keptProtected = 0;

      if (checked) {
        for (const permission of group.permissions) {
          if (!next.has(permission.id)) {
            next.add(permission.id);
            added += 1;
          }
        }
      } else {
        /* Remove one leaf at a time, re-evaluating protection after each step:
           a jointly load-bearing pair can never be cleared together. */
        for (const permission of group.permissions) {
          if (!next.has(permission.id)) {
            continue;
          }
          const slugs = selectedSlugsFor(next, matrix.permissionsById);
          const reason = getPermissionProtection(permission.slug, slugs, guardContext);
          if (reason !== null) {
            keptProtected += 1;
            continue;
          }
          next.delete(permission.id);
          removed += 1;
        }
      }

      setSelectedIds(next);
      return { added, removed, keptProtected };
    },
    [matrix.groups, matrix.permissionsById, guardContext, selectedIds],
  );

  const getGroupState = useCallback(
    (module: string): GroupToggleState => {
      const group = matrix.groups.find((entry) => entry.module === module);
      return group === undefined ? 'none' : computeGroupState(group, selectedIds);
    },
    [matrix.groups, selectedIds],
  );

  const resetDraft = useCallback(() => {
    if (selectedRole === null) {
      return;
    }
    setSelectedIds(new Set(selectedRole.permissionIds));
  }, [selectedRole]);

  const saveBlocker = useMemo<SaveBlocker | null>(() => {
    if (guardContext === null) {
      return null;
    }
    return getSaveBlocker({
      ...guardContext,
      selectedSlugs: selectedSlugsFor(selectedIds, matrix.permissionsById),
      isDirty: draft?.isDirty ?? false,
      actorIsSuperAdmin: matrix.actorIsSuperAdmin,
    });
  }, [guardContext, selectedIds, matrix.permissionsById, matrix.actorIsSuperAdmin, draft]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ROLES_QUERY_KEY });
  }, [queryClient]);

  const save = useCallback(async (): Promise<SaveRolePermissionsResult> => {
    const role = selectedRole;
    if (role === null) {
      return { ok: false, roleId: '', code: 'not-found' };
    }
    const client = getSupabase();
    if (client === null) {
      return { ok: false, roleId: role.id, code: 'unavailable' };
    }
    if (inFlightRef.current.has(SAVE_IN_FLIGHT)) {
      return { ok: false, roleId: role.id, code: 'in-flight' };
    }

    /* Guards re-run from the cache, so a stale UI can never reach the RPC
       (the database refuses the very same violations again anyway). */
    const slugs = selectedSlugsFor(selectedIds, matrix.permissionsById);
    const blocker = getSaveBlocker({
      roleId: role.id,
      roleSlug: role.slug,
      actorRoleIds: matrix.actorRoleIds,
      baselineSlugsByRole: matrix.baselineSlugsByRole,
      selectedSlugs: slugs,
      isDirty: draft?.isDirty ?? false,
      actorIsSuperAdmin: matrix.actorIsSuperAdmin,
    });
    if (blocker !== null) {
      return { ok: false, roleId: role.id, code: blocker };
    }

    inFlightRef.current.add(SAVE_IN_FLIGHT);
    setIsSaving(true);
    try {
      const { data, error } = (await client.rpc('admin_set_role_permissions', {
        target_role_id: role.id,
        permission_slugs: [...slugs].sort(),
      })) as RpcResult;

      if (error !== null) {
        return { ok: false, roleId: role.id, code: mapPostgrestError(error).code };
      }

      /* Server always wins: refetch the authoritative rows. */
      await queryClient.invalidateQueries({ queryKey: ROLES_QUERY_KEY });
      return {
        ok: true,
        roleId: role.id,
        granted: parseRpcSlugs(data, 'granted'),
        revoked: parseRpcSlugs(data, 'revoked'),
      };
    } catch (caught) {
      return { ok: false, roleId: role.id, code: toErrorCode(caught) };
    } finally {
      inFlightRef.current.delete(SAVE_IN_FLIGHT);
      setIsSaving(false);
    }
  }, [selectedRole, selectedIds, matrix, draft, queryClient]);

  return {
    roles: matrix.roles,
    groups: matrix.groups,
    permissionsById: matrix.permissionsById,
    actorIsSuperAdmin: matrix.actorIsSuperAdmin,
    isInitialLoading: query.isPending,
    isRefreshing: query.isFetching && !query.isPending,
    fetchError:
      query.error === null
        ? null
        : query.error instanceof RolesManagementError
          ? query.error.code
          : 'unknown',
    lastSyncedAt: query.dataUpdatedAt > 0 ? query.dataUpdatedAt : null,
    refresh,
    selectedRole,
    selectRole,
    draft,
    protectedReasons,
    saveBlocker,
    togglePermission,
    toggleGroup,
    getGroupState,
    resetDraft,
    isSaving,
    save,
  };
}
