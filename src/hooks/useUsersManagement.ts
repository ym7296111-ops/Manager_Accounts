import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PostgrestError } from '@supabase/supabase-js';
import { useAuth } from '@/context/AuthContext';
import { useAuthCapabilities, WILDCARD_CAPABILITY } from '@/hooks/useAuthCapabilities';
import type { TranslationKey } from '@/i18n/I18nContext';
import { getSupabase } from '@/lib/supabase';

/**
 * Users Management data layer.
 *
 * * One TanStack Query cache entry keyed `['users']` is the single source of
 *   truth for the screen; rows are fetched from PostgREST in ONE round trip
 *   with the roles embedded (no N+1).
 * * Supabase Realtime on `public.profiles` is an invalidation signal ONLY:
 *   events never mutate client state directly, they schedule a refetch of
 *   the authoritative rows. A short coalescing window folds event bursts
 *   into a single request, so the visible order is never rebuilt from deltas.
 * * Status changes go through the SECURITY DEFINER RPC
 *   `admin_set_user_status` — the only sanctioned write path (direct UPDATE
 *   on `profiles.status` is revoked at the database). Synchronous lockout
 *   guards run before any network call and every failure is normalized to a
 *   locale-independent code that maps onto the bilingual dictionary.
 */

/* ------------------------------------------------------------------ types */

/** Target state for a user account. Mirrors `public.user_status`. */
export type UserStatus = 'invited' | 'active' | 'suspended';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** A role assigned to a user, flattened from the `roles` embed. */
export interface ManagedUserRole {
  readonly slug: string;
  readonly nameAr: string;
  readonly nameEn: string;
}

/** Domain view model for one row of the users-management screen. */
export interface ManagedUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string | null;
  readonly status: UserStatus;
  readonly approvalStatus: ApprovalStatus;
  readonly roles: readonly ManagedUserRole[];
  /**
   * TRUE when the user holds a protected system role (the machine flag
   * `is_super_admin = TRUE` on the held role row). Phase 3A: derived from the
   * machine flag only — the role's NAME is never consulted, so renaming the
   * role cannot spoof or hide this fact.
   */
  readonly isSuperAdmin: boolean;
  /**
   * Phase 2 protected-user indicator (`is_protected` on the wire contract):
   * TRUE when the user holds a role flagged `is_super_admin = TRUE` in the
   * database — regardless of the role's name. Phase 3A feeds the protected-
   * user indicator (lock chip, disabled actions, tooltip) from this field.
   */
  readonly isProtected: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Normalized, locale-independent failure codes for the whole screen. */
export type UserManagementErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'self-lockout'
  | 'owner-protection'
  | 'last-admin-lockout'
  | 'noop'
  | 'in-flight'
  | 'not-found'
  | 'rate-limited'
  | 'network'
  | 'unknown';

/** Reasons a status change is blocked synchronously, before any request. */
export type StatusChangeBlocker = Extract<
  UserManagementErrorCode,
  'self-lockout' | 'owner-protection' | 'last-admin-lockout' | 'noop' | 'forbidden' | 'not-found'
>;

/**
 * Result of `setUserStatus` — a discriminated union; nothing is thrown.
 * A failure may carry a `messageKey` that is more specific than the code's
 * generic {@link USERS_ERROR_KEYS} entry (P1 — `approve-user` wire codes that
 * have no faithful screen-wide code); resolve it with {@link failureMessageKey}.
 */
export type SetUserStatusResult =
  | { readonly ok: true; readonly userId: string; readonly status: UserStatus }
  | {
      readonly ok: false;
      readonly userId: string;
      readonly code: UserManagementErrorCode;
      readonly messageKey?: TranslationKey;
    };

/** Health of the realtime invalidation channel, for the UI indicator. */
export type RealtimeState = 'connecting' | 'live' | 'offline';

/** Codes for role-change failures. Mirrors the server error taxonomy of
 * `admin_set_user_roles` (permission_denied → forbidden, owner_protection →
 * owner-protection, user_not_found → not-found) plus network failures. */
export type ChangeUserRoleErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'owner-protection'
  | 'not-found'
  | 'invalid-role'
  | 'in-flight'
  | 'rate-limited'
  | 'network'
  | 'unknown';

/**
 * Result of `changeUserRole` — a discriminated union; nothing is thrown.
 * A failure carries the normalized code and, optionally, a specific
 * `messageKey` for cases that need a dedicated bilingual message.
 */
export type ChangeUserRoleResult =
  | { readonly ok: true; readonly userId: string; readonly roles: readonly string[] }
  | {
      readonly ok: false;
      readonly userId: string;
      readonly code: ChangeUserRoleErrorCode;
      readonly messageKey?: TranslationKey;
    };

/* ---------------------------------------------- admin invite / password set */

/** Roles an invitation may grant. Mirrors the allow-list in `admin_invite_user`
 * and the `INVITE_ROLES` set in the `admin-invite-user` Edge Function; the SQL
 * RPC is authoritative and re-validates whatever is sent. `owner` and any
 * `is_super_admin` role are deliberately absent (decision D2/D5). */
export const INVITE_ROLES = ['viewer', 'editor', 'admin', 'executive'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

/**
 * Pragmatic address-shape guard for the synchronous pre-flight check. GoTrue is
 * the real authority on validity; this only stops an obviously malformed value
 * from costing a round trip.
 */
const INVITE_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Failure codes for {@link UsersManagementApi.inviteUser}. The four server-side
 * codes mirror the `admin-invite-user` wire taxonomy (`email_exists`,
 * `invalid_role`, `permission_denied`, `unavailable`); `invalid-email` is added
 * because the same guard runs synchronously before any request, and the rest
 * are the screen-wide transport codes used by every other action here.
 */
export type InviteErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'email-exists'
  | 'invalid-role'
  | 'invalid-email'
  | 'in-flight'
  | 'rate-limited'
  | 'network'
  | 'unknown';

/**
 * Result of `inviteUser` — a discriminated union; nothing is thrown.
 *
 * On success it carries the ONE-TIME temporary password (decision D1). It is
 * returned in memory only: never cached, never written to storage, and the
 * caller is expected to hand it to `PasswordRevealDialog` and drop it.
 */
export type InviteResult =
  | { readonly ok: true; readonly userId: string; readonly tempPassword: string }
  | {
      readonly ok: false;
      readonly code: InviteErrorCode;
      readonly messageKey?: TranslationKey;
    };

/** Failure codes for {@link UsersManagementApi.resetUserPassword}. The first
 * three mirror the `admin-set-password` wire taxonomy (`owner_protection`,
 * `permission_denied`, `user_not_found`). */
export type PasswordResetErrorCode =
  | 'unavailable'
  | 'forbidden'
  | 'owner-protection'
  | 'not-found'
  | 'in-flight'
  | 'rate-limited'
  | 'network'
  | 'unknown';

/**
 * Result of `resetUserPassword` — a discriminated union; nothing is thrown.
 *
 * `auditRecorded` reports whether the audit row was written. The Edge Function
 * writes the credential to GoTrue BEFORE the audit row, so a `false` here means
 * the password is live but the trail is missing — the UI says so rather than
 * implying the whole operation failed.
 */
export type PasswordResetResult =
  | {
      readonly ok: true;
      readonly userId: string;
      readonly tempPassword: string;
      readonly auditRecorded: boolean;
    }
  | {
      readonly ok: false;
      readonly userId: string;
      readonly code: PasswordResetErrorCode;
      readonly messageKey?: TranslationKey;
    };

/* -------------------------------------------------------- dictionary keys */

/** Every failure code → its bilingual dictionary key. */
export const USERS_ERROR_KEYS: Record<UserManagementErrorCode, TranslationKey> = {
  unavailable: 'users.error.unavailable',
  forbidden: 'users.error.forbidden',
  'self-lockout': 'users.block.self',
  'owner-protection': 'users.protected.ownerTooltip',
  'last-admin-lockout': 'users.block.lastAdmin',
  noop: 'users.error.noop',
  'in-flight': 'users.error.inFlight',
  'not-found': 'users.error.notFound',
  'rate-limited': 'users.error.rateLimited',
  network: 'users.error.network',
  unknown: 'users.error.unknown',
};

/**
 * The message to show for a failed result: its specific `messageKey` when the
 * failure carries one (P1 approval wire codes), otherwise the generic
 * {@link USERS_ERROR_KEYS} entry for its code.
 */
export function failureMessageKey(failure: {
  readonly code: UserManagementErrorCode;
  readonly messageKey?: TranslationKey;
}): TranslationKey {
  return failure.messageKey ?? USERS_ERROR_KEYS[failure.code];
}

/** Map a `ChangeUserRoleResult` failure onto a bilingual translation key. */
export function failureMessageKeyForRoleChange(failure: {
  readonly code: ChangeUserRoleErrorCode;
  readonly messageKey?: TranslationKey;
}): TranslationKey {
  return failure.messageKey ?? USERS_ROLE_CHANGE_ERROR_KEYS[failure.code];
}

/** Every invitation failure code → its bilingual dictionary key. */
export const USERS_INVITE_ERROR_KEYS: Record<InviteErrorCode, TranslationKey> = {
  unavailable: 'users.error.unavailable',
  forbidden: 'users.invite.error.forbidden',
  'email-exists': 'users.invite.error.emailExists',
  'invalid-role': 'users.invite.error.invalidRole',
  'invalid-email': 'users.invite.error.invalidEmail',
  'in-flight': 'users.error.inFlight',
  'rate-limited': 'users.error.rateLimited',
  network: 'users.error.network',
  unknown: 'users.error.unknown',
};

/** Map an `InviteResult` failure onto a bilingual translation key. */
export function inviteFailureMessageKey(failure: {
  readonly code: InviteErrorCode;
  readonly messageKey?: TranslationKey;
}): TranslationKey {
  return failure.messageKey ?? USERS_INVITE_ERROR_KEYS[failure.code];
}

/** Every admin password-reset failure code → its bilingual dictionary key. */
export const USERS_PASSWORD_RESET_ERROR_KEYS: Record<PasswordResetErrorCode, TranslationKey> = {
  unavailable: 'users.error.unavailable',
  forbidden: 'users.password.error.forbidden',
  'owner-protection': 'users.password.error.ownerProtection',
  'not-found': 'users.error.notFound',
  'in-flight': 'users.error.inFlight',
  'rate-limited': 'users.error.rateLimited',
  network: 'users.error.network',
  unknown: 'users.error.unknown',
};

/** Map a `PasswordResetResult` failure onto a bilingual translation key. */
export function passwordResetFailureMessageKey(failure: {
  readonly code: PasswordResetErrorCode;
  readonly messageKey?: TranslationKey;
}): TranslationKey {
  return failure.messageKey ?? USERS_PASSWORD_RESET_ERROR_KEYS[failure.code];
}

/**
 * `admin-invite-user` wire code → normalized code. Mirrors
 * {@link APPROVAL_WIRE_CODES}: the body carries `{ error: '<code>' }`, and
 * anything unrecognized falls back to the transport classifier instead of
 * collapsing every failure onto one message.
 */
const INVITE_WIRE_CODES: Readonly<Record<string, InviteErrorCode>> = {
  email_exists: 'email-exists',
  invalid_role: 'invalid-role',
  invalid_email: 'invalid-email',
  permission_denied: 'forbidden',
  unavailable: 'unavailable',
};

/** `admin-set-password` wire code → normalized code. */
const PASSWORD_RESET_WIRE_CODES: Readonly<Record<string, PasswordResetErrorCode>> = {
  owner_protection: 'owner-protection',
  permission_denied: 'forbidden',
  user_not_found: 'not-found',
  unavailable: 'unavailable',
  password_update_failed: 'unavailable',
};

/** Classify an `admin-invite-user` failure by its response body code. */
async function mapInviteInvokeError(caught: unknown): Promise<{
  readonly code: InviteErrorCode;
  readonly messageKey?: TranslationKey;
}> {
  const parsed = await readApprovalErrorCode(caught);
  if (parsed === null) {
    return { code: toInviteErrorCode(caught) };
  }
  return { code: INVITE_WIRE_CODES[parsed.code] ?? 'unknown' };
}

/** Classify an `admin-set-password` failure by its response body code. */
async function mapPasswordResetInvokeError(caught: unknown): Promise<{
  readonly code: PasswordResetErrorCode;
  readonly messageKey?: TranslationKey;
}> {
  const parsed = await readApprovalErrorCode(caught);
  if (parsed === null) {
    return { code: toPasswordResetErrorCode(caught) };
  }
  return { code: PASSWORD_RESET_WIRE_CODES[parsed.code] ?? 'unknown' };
}

/**
 * Narrow the screen-wide classifier onto the invitation code set.
 * {@link UserManagementErrorCode} is deliberately wider (it carries `noop`,
 * `self-lockout`, `last-admin-lockout`, …) and none of those describe an
 * invite, so anything outside the overlap collapses to `unknown` rather than
 * being cast through. Mirrors {@link toChangeUserRoleErrorCode}.
 */
function toInviteErrorCode(caught: unknown): InviteErrorCode {
  const code = toErrorCode(caught);
  if (
    code === 'unavailable' ||
    code === 'forbidden' ||
    code === 'rate-limited' ||
    code === 'network' ||
    code === 'unknown'
  ) {
    return code;
  }
  return 'unknown';
}

/** Narrow the screen-wide classifier onto the password-reset code set. */
function toPasswordResetErrorCode(caught: unknown): PasswordResetErrorCode {
  const code = toErrorCode(caught);
  if (
    code === 'unavailable' ||
    code === 'forbidden' ||
    code === 'owner-protection' ||
    code === 'not-found' ||
    code === 'rate-limited' ||
    code === 'network' ||
    code === 'unknown'
  ) {
    return code;
  }
  return 'unknown';
}

/** Every synchronous blocker → the explanation shown next to the control. */
export const USERS_BLOCKER_KEYS: Record<StatusChangeBlocker, TranslationKey> = {
  'self-lockout': 'users.block.self',
  'owner-protection': 'users.protected.ownerTooltip',
  'last-admin-lockout': 'users.block.lastAdmin',
  noop: 'users.error.noop',
  forbidden: 'users.error.forbidden',
  'not-found': 'users.error.notFound',
};

/** Map role-change error codes onto the bilingual dictionary. */
export const USERS_ROLE_CHANGE_ERROR_KEYS: Record<ChangeUserRoleErrorCode, TranslationKey> = {
  unavailable: 'users.role.error.unavailable',
  forbidden: 'users.role.error.forbidden',
  'owner-protection': 'users.role.error.ownerProtected',
  'not-found': 'users.role.error.notFound',
  'invalid-role': 'users.error.invalidRole',
  'in-flight': 'users.role.error.inFlight',
  'rate-limited': 'users.error.rateLimited',
  network: 'users.error.network',
  unknown: 'users.error.unknown',
};

/* ------------------------------------------------------------- constants */

/** The single cache key for the screen. */
export const USERS_QUERY_KEY = ['users'] as const;

/**
 * Cache key for the actor's own access facts (roles/approval), fetched from a
 * dedicated self-scoped request. Kept OUT of the filtered rows cache on
 * purpose: `actorCanApprove` must not depend on which approval filter happens
 * to be loaded (the owner is 'approved', so their row never appears under the
 * 'pending' filter). The key still hangs under `USERS_QUERY_KEY` so the shared
 * invalidation/refresh paths keep it fresh.
 */
export function usersActorAccessQueryKey(actorId: string | null) {
  return [...USERS_QUERY_KEY, 'actor-access', actorId ?? 'anonymous'] as const;
}

/** v1 reads the full list in one request; the cap matches PostgREST's default max-rows. */
const USERS_MAX_ROWS = 1000;

/** Realtime channel is one per screen; events are folded for this long. */
const REALTIME_CHANNEL = 'users-management-profiles';
const REALTIME_COALESCE_MS = 250;

/** PostgREST embed: `user_roles!user_id(roles(...))` — roles in the same round
 *  trip. `is_super_admin` feeds the protected-user indicator (`isProtected`).
 *
 *  The `!user_id` relationship hint is REQUIRED: `user_roles` carries TWO
 *  foreign keys to `profiles` (`user_id` and `granted_by`), and PostgREST
 *  refuses to guess between them (HTTP 300 / `PGRST201` — "Could not embed
 *  because more than one relationship was found"). Without the hint the whole
 *  request fails and the users list renders empty. The response key stays
 *  `user_roles`, so parsing is unaffected. */
export const PROFILE_COLUMNS =
  'id, email, full_name, status, approval_status, created_at, updated_at, user_roles!user_id(roles(slug, name_ar, name_en, is_super_admin))';

const EMPTY_USERS: readonly ManagedUser[] = [];

/* ------------------------------------------------------------ error model */

/** Internal error carrying a normalized code; raw Supabase errors never leave this module. */
export class UserManagementError extends Error {
  readonly code: UserManagementErrorCode;

  constructor(code: UserManagementErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'UserManagementError';
    this.code = code;
  }
}

function mapPostgrestError(error: {
  readonly code: string;
  readonly message: string;
}): UserManagementError {
  const message = error.message.toLowerCase();

  if (message.includes('owner_protection')) {
    return new UserManagementError('owner-protection');
  }
  if (error.code === '42501') {
    return new UserManagementError('forbidden');
  }
  if (error.code === 'P0002') {
    return new UserManagementError('not-found');
  }
  if (error.code === 'RBA02' || message.includes('last-admin-lockout')) {
    return new UserManagementError('last-admin-lockout');
  }
  if (error.code === 'PGRST301' || message.includes('jwt')) {
    return new UserManagementError('forbidden');
  }
  if (message.includes('rate limit') || message.includes('too many')) {
    return new UserManagementError('rate-limited');
  }
  if (message.includes('failed to fetch') || message.includes('network')) {
    return new UserManagementError('network');
  }
  return new UserManagementError('unknown');
}

/**
 * Classify a PostgREST error from `admin_set_user_roles` into a
 * `ChangeUserRoleErrorCode`. The database raises:
 *   - 42501 / 'owner_protection'  → caller lacks authority or target is
 *     the original owner.
 *   - P0002                       → target user not found.
 *   - 'invalid_role'              → one of the requested slugs is not a
 *     grantable role.
 */
export function mapRoleChangePostgrestError(error: PostgrestError): ChangeUserRoleErrorCode {
  if (error.code === '42501') return 'forbidden';
  if (error.message.toLowerCase().includes('owner_protection')) return 'owner-protection';
  if (error.code === 'P0002') return 'not-found';
  if (error.message.toLowerCase().includes('invalid_role')) return 'invalid-role';
  if (error.code === 'PGRST301' || error.message.toLowerCase().includes('jwt')) return 'forbidden';
  if (
    error.message.toLowerCase().includes('rate limit') ||
    error.message.toLowerCase().includes('too many')
  )
    return 'rate-limited';
  if (
    error.message.toLowerCase().includes('failed to fetch') ||
    error.message.toLowerCase().includes('network')
  )
    return 'network';
  return 'unknown';
}

function toErrorCode(caught: unknown): UserManagementErrorCode {
  if (caught instanceof UserManagementError) {
    return caught.code;
  }
  if (caught instanceof TypeError) {
    return 'network';
  }
  return 'unknown';
}

function toChangeUserRoleErrorCode(caught: unknown): ChangeUserRoleErrorCode {
  if (caught instanceof UserManagementError) {
    const code = caught.code;
    if (
      code === 'unavailable' ||
      code === 'forbidden' ||
      code === 'not-found' ||
      code === 'network' ||
      code === 'unknown' ||
      code === 'rate-limited' ||
      code === 'in-flight'
    ) {
      return code;
    }
    return 'unknown';
  }
  if (caught instanceof TypeError) {
    return 'network';
  }
  if (
    caught instanceof Error &&
    'code' in caught &&
    (caught as { code: string }).code === 'P0002'
  ) {
    return 'not-found';
  }
  return 'unknown';
}

/* ------------------------------------------- approval error classification */

/**
 * P1 — approval failures arrive from the `approve-user` Edge Function as a
 * machine code in the response body (`{ error: 'permission_denied' }` in
 * production, or `{ error: { code } }`), not as PostgREST errors. Each wire
 * code maps onto an existing {@link UserManagementErrorCode} so the visible
 * message is specific instead of a blanket `forbidden`. Three codes reuse the
 * existing {@link USERS_ERROR_KEYS} dictionary as-is; the two approval-only
 * codes carry a dedicated `messageKey` instead, because no screen-wide code
 * says the same thing (`noop` = "already applied", `owner-protection` = the
 * protected-owner tooltip) and adding codes would mean editing
 * {@link USERS_ERROR_KEYS}:
 *
 * | wire code          | code             | message key                              |
 * | ------------------ | ---------------- | ---------------------------------------- |
 * | permission_denied  | forbidden        | users.error.forbidden                    |
 * | not_found          | not-found        | users.error.notFound                     |
 * | invalid_transition | noop             | users.errors.approvalInvalidTransition   |
 * | invalid_role       | owner-protection | users.errors.approvalInvalidRole         |
 * | unknown            | unknown          | users.error.unknown                      |
 *
 * Unrecognized bodies fall through the existing {@link mapPostgrestError}
 * classifier (SQLSTATE + message sniffing) rather than collapsing to one
 * message. The dictionaries and classifiers are reused as-is — never rebuilt.
 */
interface ApprovalFailure {
  readonly code: UserManagementErrorCode;
  readonly messageKey?: TranslationKey;
}

const APPROVAL_WIRE_CODES: Readonly<Record<string, UserManagementErrorCode | ApprovalFailure>> = {
  permission_denied: 'forbidden',
  not_found: 'not-found',
  invalid_transition: { code: 'noop', messageKey: 'users.errors.approvalInvalidTransition' },
  invalid_role: { code: 'owner-protection', messageKey: 'users.errors.approvalInvalidRole' },
  unknown: 'unknown',
};

/** Best-effort read of `body.error.code` (or the bare `body.error` string). */
async function readApprovalErrorCode(
  caught: unknown,
): Promise<{ readonly code: string; readonly message: string } | null> {
  const context: unknown = isRecord(caught) ? caught['context'] : undefined;
  const json: unknown = isRecord(context) ? context['json'] : undefined;
  if (typeof json !== 'function') {
    return null;
  }
  try {
    const body: unknown = await (json as () => Promise<unknown>).call(context);
    if (!isRecord(body)) {
      return null;
    }
    const rawError: unknown = body['error'];
    const code: string =
      typeof rawError === 'string'
        ? rawError
        : isRecord(rawError) && typeof rawError['code'] === 'string'
          ? rawError['code']
          : typeof body['code'] === 'string'
            ? body['code']
            : '';
    const message: string = typeof body['message'] === 'string' ? body['message'] : code;
    return code === '' && message === '' ? null : { code, message };
  } catch {
    return null;
  }
}

/** P1: classify an `approve-user` failure by its body code (see table above). */
async function mapApprovalInvokeError(caught: unknown): Promise<ApprovalFailure> {
  const parsed = await readApprovalErrorCode(caught);
  if (parsed === null) {
    return { code: toErrorCode(caught) };
  }
  const wire = APPROVAL_WIRE_CODES[parsed.code];
  if (wire !== undefined) {
    return typeof wire === 'string' ? { code: wire } : wire;
  }
  /* Unknown wire code: reuse the existing PostgREST classifier (SQLSTATE and
     message sniffing) instead of inventing a second mapping. */
  return { code: mapPostgrestError({ code: parsed.code, message: parsed.message }).code };
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

/**
 * Narrow a wire status into the closed `UserStatus` union.
 * The DB enum is authoritative; anything unexpected is presented as
 * `suspended` (the most restrictive state) so no unsafe action is offered.
 */
function parseStatus(value: unknown): UserStatus {
  switch (value) {
    case 'invited':
    case 'active':
    case 'suspended':
      return value;
    default:
      return 'suspended';
  }
}

function parseRole(value: unknown): ManagedUserRole | null {
  if (!isRecord(value)) {
    return null;
  }
  return {
    slug: asString(value['slug']),
    nameAr: asString(value['name_ar']),
    nameEn: asString(value['name_en']),
  };
}

function parseUserRow(value: unknown): ManagedUser | null {
  if (!isRecord(value)) {
    return null;
  }

  const roles: ManagedUserRole[] = [];
  let isProtected = false;
  const wireRoles = value['user_roles'];
  if (Array.isArray(wireRoles)) {
    for (const entry of wireRoles) {
      if (!isRecord(entry)) {
        continue;
      }
      /* `roles` is a many-to-one embed: an object today, tolerated as a
         single-element array for forward compatibility. */
      const nested = entry['roles'];
      const rawRole: unknown = Array.isArray(nested) ? (nested as readonly unknown[])[0] : nested;
      const role = parseRole(rawRole);
      if (role !== null && role.slug !== '') {
        roles.push(role);
      }
      /* Protected-user indicator: the role row carries the machine flag
         (is_super_admin), independent of the role's name. */
      if (isRecord(rawRole) && rawRole['is_super_admin'] === true) {
        isProtected = true;
      }
    }
  }

  return {
    id: asString(value['id']),
    email: asString(value['email']),
    fullName: asNullableString(value['full_name']),
    status: parseStatus(value['status']),
    approvalStatus:
      value['approval_status'] === 'pending' || value['approval_status'] === 'rejected'
        ? value['approval_status']
        : 'approved',
    roles,
    /* Phase 3A: both flags answer the same machine fact (the `is_super_admin`
       flag on a held role row) — role NAMES are never consulted here. */
    isSuperAdmin: isProtected,
    isProtected,
    createdAt: asString(value['created_at']),
    updatedAt: asString(value['updated_at']),
  };
}

function parseUsers(data: unknown): ManagedUser[] {
  if (!Array.isArray(data)) {
    return [];
  }
  const users: ManagedUser[] = [];
  for (const row of data) {
    const user = parseUserRow(row);
    if (user !== null && user.id !== '') {
      users.push(user);
    }
  }
  /* Deterministic order (created_at, id) keeps refetches from "destroying
     the order" the user is already reading. */
  users.sort((a, b) => {
    const byDate = a.createdAt.localeCompare(b.createdAt);
    return byDate !== 0 ? byDate : a.id.localeCompare(b.id);
  });
  return users;
}

/* ---------------------------------------------------------- pure guards */

/** True when the user is active AND holds the `super_admin` system role. */
export function isActiveSuperAdmin(user: ManagedUser): boolean {
  return user.status === 'active' && user.isSuperAdmin;
}

/** The status the screen's toggle would apply to this row. */
export function nextStatusFor(user: ManagedUser): UserStatus {
  return user.status === 'active' ? 'suspended' : 'active';
}

export interface StatusChangeContext {
  readonly target: ManagedUser | undefined;
  readonly actorId: string | null;
  readonly actorIsSuperAdmin: boolean;
  readonly nextStatus: UserStatus;
  readonly activeSuperAdmins: readonly ManagedUser[];
}

/**
 * Synchronous lockout guards — evaluated BEFORE any network call:
 *
 * * `self-lockout`       — never touch your own row (the RPC also refuses it).
 * * `last-admin-lockout` — never suspend the last active super admin, or the
 *   system loses every administrator (total mutual lockout).
 * * `noop`               — the requested status is already applied.
 * * `forbidden`          — the actor is not a super admin.
 */
export function getStatusChangeBlocker(context: StatusChangeContext): StatusChangeBlocker | null {
  const { target, actorId, actorIsSuperAdmin, nextStatus, activeSuperAdmins } = context;

  if (target === undefined) {
    return 'not-found';
  }
  if (!actorIsSuperAdmin) {
    return 'forbidden';
  }
  if (target.roles.some((role) => role.slug === 'owner')) {
    return 'owner-protection';
  }
  if (actorId !== null && target.id === actorId) {
    return 'self-lockout';
  }
  if (target.status === nextStatus) {
    return 'noop';
  }
  if (
    nextStatus !== 'active' &&
    isActiveSuperAdmin(target) &&
    activeSuperAdmins.length === 1 &&
    activeSuperAdmins[0]?.id === target.id
  ) {
    return 'last-admin-lockout';
  }
  return null;
}

/* ---------------------------------------------------------------- fetch */

interface QueryResult {
  readonly data: unknown;
  readonly error: PostgrestError | null;
}

interface RpcResult {
  readonly error: PostgrestError | null;
}

async function fetchUsers(
  approvalFilter: ApprovalStatus | 'all' = 'all',
  canAdministerUsers = false,
  canApproveUsers = false,
): Promise<ManagedUser[]> {
  const client = getSupabase();
  if (client === null) {
    throw new UserManagementError('unavailable');
  }

  try {
    if (!canAdministerUsers) {
      if (!canApproveUsers) return [];
      const response: { data?: unknown; error: unknown } = await client.functions.invoke(
        'admin-user-capabilities',
        { body: { action: 'approval-queue' } },
      );
      if (response.error) {
        const failure = await mapApprovalInvokeError(response.error);
        throw new UserManagementError(failure.code, failure.messageKey);
      }
      const payload = isRecord(response.data) ? response.data['data'] : response.data;
      return parseUsers(payload);
    }

    /* Full administrators retain the single embedded profiles query. */
    let request = client.from('profiles').select(PROFILE_COLUMNS);
    if (approvalFilter !== 'all') request = request.eq('approval_status', approvalFilter);
    const { data, error } = (await request
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(0, USERS_MAX_ROWS - 1)) as QueryResult;

    if (error !== null) {
      throw mapPostgrestError(error);
    }
    return parseUsers(data);
  } catch (caught) {
    if (caught instanceof UserManagementError) {
      throw caught;
    }
    throw new UserManagementError(toErrorCode(caught));
  }
}

/** The actor's own approval facts, resolved independently of any row filter. */
export interface ActorAccess {
  readonly canAdministerUsers: boolean;
}

const NO_ACTOR_ACCESS: ActorAccess = { canAdministerUsers: false };

/**
 * Resolve role-based administrative authority from the actor's own profile.
 * This remains separate from the delegated users.approve capability and gates
 * invitations, full account controls and approval role selection.
 */
async function fetchActorAccess(actorId: string): Promise<ActorAccess> {
  const client = getSupabase();
  if (client === null) {
    return NO_ACTOR_ACCESS;
  }
  try {
    const { data, error } = (await client
      .from('profiles')
      .select('status, approval_status, user_roles!user_id(roles(slug))')
      .eq('id', actorId)
      .maybeSingle()) as { data: unknown; error: PostgrestError | null };
    if (error !== null || !isRecord(data)) {
      return NO_ACTOR_ACCESS;
    }
    const status = parseStatus(data['status']);
    const approvalStatus: ApprovalStatus =
      data['approval_status'] === 'pending' || data['approval_status'] === 'rejected'
        ? data['approval_status']
        : 'approved';
    const roleSlugs: string[] = [];
    const wireRoles = data['user_roles'];
    if (Array.isArray(wireRoles)) {
      for (const entry of wireRoles) {
        if (!isRecord(entry)) {
          continue;
        }
        const nested = entry['roles'];
        const rawRole: unknown = Array.isArray(nested) ? (nested as readonly unknown[])[0] : nested;
        const role = parseRole(rawRole);
        if (role !== null && role.slug !== '') {
          roleSlugs.push(role.slug);
        }
      }
    }
    return {
      canAdministerUsers:
        status === 'active' &&
        approvalStatus === 'approved' &&
        roleSlugs.some((slug) => slug === 'owner' || slug === 'super_admin'),
    };
  } catch {
    return NO_ACTOR_ACCESS;
  }
}

/* ----------------------------------------------------------------- hook */

export interface UsersManagementApi {
  readonly users: readonly ManagedUser[];
  readonly approvalFilter: ApprovalStatus | 'all';
  readonly setApprovalFilter: (value: ApprovalStatus | 'all') => void;
  /** Approve a pending signup, granting `targetRole` (defaults to `viewer`). */
  readonly approveUser: (userId: string, targetRole?: string) => Promise<SetUserStatusResult>;
  readonly rejectUser: (userId: string) => Promise<SetUserStatusResult>;
  /**
   * Change the roles assigned to an existing approved user. Resolved server-side
   * by `admin_set_user_roles(p_user_id, p_role_slugs)` — the only sanctioned
   * write path for role assignments (direct writes on `user_roles` are revoked
   * and trigger-blocked at the database). The actor must hold the `*`
   * capability (`is_admin()`); the original owner's roles cannot be changed.
   */
  readonly changeUserRole: (userId: string, roleSlugs: string[]) => Promise<ChangeUserRoleResult>;
  /**
   * Invite a new user: creates the Auth account, approves and activates it, and
   * grants one of {@link INVITE_ROLES} in a single server transaction. On
   * success it returns a ONE-TIME temporary password (decision D1) that the
   * caller must show once and never store.
   */
  readonly inviteUser: (input: {
    readonly email: string;
    readonly fullName?: string;
    readonly targetRole: InviteRole;
  }) => Promise<InviteResult>;
  /**
   * Set a new password on an existing approved, active, non-protected account
   * and return it for one-time display. The original owner is never eligible
   * (decision D6, enforced in SQL by `is_original_owner()`).
   */
  readonly resetUserPassword: (userId: string) => Promise<PasswordResetResult>;
  readonly actorId: string | null;
  /**
   * TRUE when the actor may administer users. Phase 3A resolves this from the
   * capability channel first (`hasCapability('*')` — the UI mirror of the
   * server's `is_admin()` check inside `admin_set_user_status`); while the
   * channel is silent it falls back to the rows cache, so the lockout guards
   * keep their synchronous, name-free answer.
   */
  readonly actorIsSuperAdmin: boolean;
  /** Effective users.approve capability (wildcard role holders also satisfy it). */
  readonly actorCanApprove: boolean;
  /** Role-only authority for invitations and admin-set-password. */
  readonly actorCanInvite: boolean;
  readonly activeSuperAdmins: readonly ManagedUser[];
  readonly isInitialLoading: boolean;
  readonly isRefreshing: boolean;
  readonly fetchError: UserManagementErrorCode | null;
  readonly lastSyncedAt: number | null;
  readonly realtimeState: RealtimeState;
  readonly pendingUserId: string | null;
  readonly refresh: () => void;
  readonly setUserStatus: (userId: string, nextStatus: UserStatus) => Promise<SetUserStatusResult>;
}

export function useUsersManagement(): UsersManagementApi {
  const queryClient = useQueryClient();
  const { session } = useAuth();
  const actorId = session?.user.id ?? null;

  const [approvalFilter, setApprovalFilter] = useState<ApprovalStatus | 'all'>('all');
  const [realtimeState, setRealtimeState] = useState<RealtimeState>('connecting');
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);
  const inFlightRef = useRef<Set<string>>(new Set());
  const roleChangeInFlightRef = useRef<Set<string>>(new Set());
  /* An invite has no target id yet, so its in-flight guard is a single flag
     rather than a per-user set: two invitations must never race, because the
     second would collide with the first on `email_exists` at best. */
  const inviteInFlightRef = useRef<boolean>(false);
  const passwordResetInFlightRef = useRef<Set<string>>(new Set());
  const realtimeStateRef = useRef<RealtimeState>('connecting');
  const capabilitiesChannel = useAuthCapabilities();
  const hasAuthoritativeCapabilities = capabilitiesChannel.isAuthoritative;
  const canAdministerUsers =
    hasAuthoritativeCapabilities && capabilitiesChannel.hasCapability(WILDCARD_CAPABILITY);
  const canApproveUsersForQueue =
    hasAuthoritativeCapabilities && capabilitiesChannel.hasCapability('users.approve');

  const usersQueryKey = canAdministerUsers
    ? approvalFilter === 'all'
      ? USERS_QUERY_KEY
      : [...USERS_QUERY_KEY, approvalFilter]
    : [...USERS_QUERY_KEY, 'approval-queue'];
  const query = useQuery({
    queryKey: usersQueryKey,
    enabled: actorId !== null && hasAuthoritativeCapabilities,
    queryFn: () => fetchUsers(approvalFilter, canAdministerUsers, canApproveUsersForQueue),
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    /* Never carry full-admin rows across a capability downgrade. */
    /* Auto-retry with backoff for transient network failures only. */
    retry: (failureCount, error) =>
      error instanceof UserManagementError && error.code === 'network' && failureCount < 2,
  });

  const users = query.data ?? EMPTY_USERS;

  const activeSuperAdmins = useMemo(() => users.filter(isActiveSuperAdmin), [users]);

  /* Capability gates mirror the database: wildcard for full administration,
     users.approve for the limited approval queue. */
  const wildcardViaCapabilities = hasAuthoritativeCapabilities ? canAdministerUsers : null;

  const cachedActorIsSuperAdmin = useMemo(
    () =>
      [...users, ...(queryClient.getQueryData<ManagedUser[]>(USERS_QUERY_KEY) ?? [])].some(
        (user) => user.id === actorId && user.isSuperAdmin,
      ),
    [users, actorId, queryClient],
  );

  const actorIsSuperAdmin = wildcardViaCapabilities ?? cachedActorIsSuperAdmin;

  /* Approval authority is resolved from the actor's OWN profile row through a
     dedicated query (see usersActorAccessQueryKey) — never from the filtered
     rows cache. Under the 'pending' filter the owner's own row is absent, and
     deriving the flag from the visible rows hid every approve/reject button on
     a cold load of that tab. The server re-checks the same gate regardless. */
  const actorAccessQuery = useQuery({
    queryKey: usersActorAccessQueryKey(actorId),
    enabled: actorId !== null,
    queryFn: () => fetchActorAccess(actorId as string),
    staleTime: 60_000,
    retry: false,
  });
  const actorCanApprove = canApproveUsersForQueue;
  /* Invitations and admin-set-password intentionally remain role-only. */
  const actorCanInvite = actorAccessQuery.data?.canAdministerUsers ?? false;

  /* Realtime: a pure invalidation signal. Events are coalesced so a burst of
     changes produces one refetch; state is never rebuilt from payloads. */
  useEffect(() => {
    const client = getSupabase();
    if (client === null) {
      return;
    }

    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleInvalidation = () => {
      if (disposed) {
        return;
      }
      if (timer !== null) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = null;
        void queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
      }, REALTIME_COALESCE_MS);
    };

    const channel = client
      .channel(REALTIME_CHANNEL)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'profiles' },
        scheduleInvalidation,
      )
      .subscribe((status) => {
        if (disposed) {
          return;
        }
        /* realtime-js reports a stringly-typed channel status. */
        const channelStatus: string = String(status);
        const next: RealtimeState =
          channelStatus === 'SUBSCRIBED'
            ? 'live'
            : channelStatus === 'TIMED_OUT' ||
                channelStatus === 'CHANNEL_ERROR' ||
                channelStatus === 'CLOSED'
              ? 'offline'
              : 'connecting';
        realtimeStateRef.current = next;
        setRealtimeState(next);
      });

    return () => {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
      }
      void client.removeChannel(channel);
    };
  }, [queryClient]);

  /* Fallback ladder: when the live feed is down, returning to the tab
     refetches immediately (events may have been missed while away). */
  useEffect(() => {
    const client = getSupabase();
    if (client === null || typeof document === 'undefined') {
      return;
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && realtimeStateRef.current !== 'live') {
        void queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [queryClient]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
  }, [queryClient]);

  const setUserStatus = useCallback(
    async (userId: string, nextStatus: UserStatus): Promise<SetUserStatusResult> => {
      const client = getSupabase();
      if (client === null) {
        return { ok: false, userId, code: 'unavailable' };
      }
      if (inFlightRef.current.has(userId)) {
        return { ok: false, userId, code: 'in-flight' };
      }

      /* Guards re-run server-state-derived checks from the cache, so a stale
         UI can never reach the RPC (the database refuses them again anyway). */
      const cached = queryClient.getQueryData<ManagedUser[]>(USERS_QUERY_KEY) ?? [];
      const target = cached.find((user) => user.id === userId);
      const actorIsAdmin =
        wildcardViaCapabilities ?? cached.some((user) => user.id === actorId && user.isSuperAdmin);
      const blocker = getStatusChangeBlocker({
        target,
        actorId,
        actorIsSuperAdmin: actorIsAdmin,
        nextStatus,
        activeSuperAdmins: cached.filter(isActiveSuperAdmin),
      });
      if (blocker !== null) {
        return { ok: false, userId, code: blocker };
      }

      inFlightRef.current.add(userId);
      setPendingUserId(userId);
      try {
        const { error } = (await client.rpc('admin_set_user_status', {
          p_user_id: userId,
          p_status: nextStatus,
        })) as RpcResult;

        if (error !== null) {
          return { ok: false, userId, code: mapPostgrestError(error).code };
        }

        /* Server always wins: refetch the authoritative rows. */
        await queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
        return { ok: true, userId, status: nextStatus };
      } catch (caught) {
        return { ok: false, userId, code: toErrorCode(caught) };
      } finally {
        inFlightRef.current.delete(userId);
        setPendingUserId(null);
      }
    },
    [actorId, queryClient, wildcardViaCapabilities],
  );

  const changeUserRole = useCallback(
    async (userId: string, roleSlugs: string[]): Promise<ChangeUserRoleResult> => {
      const client = getSupabase();
      if (client === null) {
        return { ok: false, userId, code: 'unavailable' };
      }
      if (roleChangeInFlightRef.current.has(userId)) {
        return { ok: false, userId, code: 'in-flight' };
      }

      const cached = queryClient.getQueryData<ManagedUser[]>(USERS_QUERY_KEY) ?? [];
      const target = cached.find((user) => user.id === userId);
      if (target === undefined || target.isProtected) {
        return {
          ok: false,
          userId,
          code: target === undefined ? 'not-found' : 'owner-protection',
          messageKey: target === undefined ? undefined : 'users.role.error.ownerProtected',
        };
      }

      roleChangeInFlightRef.current.add(userId);
      try {
        const { error } = (await client.rpc('admin_set_user_roles', {
          p_user_id: userId,
          p_role_slugs: roleSlugs,
        })) as unknown as { error: PostgrestError | null };

        if (error !== null) {
          return {
            ok: false,
            userId,
            code: mapRoleChangePostgrestError(error),
          };
        }

        await queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
        return { ok: true, userId, roles: roleSlugs };
      } catch (caught) {
        return { ok: false, userId, code: toChangeUserRoleErrorCode(caught) };
      } finally {
        roleChangeInFlightRef.current.delete(userId);
      }
    },
    [queryClient],
  );

  const changeApproval = useCallback(
    async (
      userId: string,
      action: 'approve' | 'reject',
      targetRole?: string,
    ): Promise<SetUserStatusResult> => {
      const client = getSupabase();
      if (!client || !actorId) return { ok: false, userId, code: 'unavailable' };
      if (inFlightRef.current.has(userId)) return { ok: false, userId, code: 'in-flight' };
      // UI gate is advisory; the service-only RPC re-checks the actor and target.
      if (!actorCanApprove) return { ok: false, userId, code: 'forbidden' };
      const target = users.find((user) => user.id === userId);
      if (
        !target ||
        target.approvalStatus !== 'pending' ||
        target.isProtected ||
        actorId === userId
      )
        return { ok: false, userId, code: 'forbidden' };
      inFlightRef.current.add(userId);
      setPendingUserId(userId);
      try {
        const body: Record<string, unknown> = { userId, action };
        /* Approvals grant the chosen non-protected role in the same server
           transaction; rejections ignore it (and the RPC validates it). */
        if (action === 'approve') body['targetRole'] = targetRole ?? 'viewer';
        const response: { error: unknown } = await client.functions.invoke('approve-user', {
          body,
        });
        /* P1: classify by the machine code in the response body — a distinct,
           specific message per wire code instead of a blanket "forbidden". */
        if (response.error)
          return { ok: false, userId, ...(await mapApprovalInvokeError(response.error)) };
        await queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
        return { ok: true, userId, status: target.status };
      } catch (caught) {
        return { ok: false, userId, code: toErrorCode(caught) };
      } finally {
        inFlightRef.current.delete(userId);
        setPendingUserId(null);
      }
    },
    [actorId, actorCanApprove, queryClient, users],
  );
  const approveUser = useCallback(
    (userId: string, targetRole?: string) => changeApproval(userId, 'approve', targetRole),
    [changeApproval],
  );
  const rejectUser = useCallback(
    (userId: string) => changeApproval(userId, 'reject'),
    [changeApproval],
  );

  /**
   * Invite a new user: the Edge Function creates the Auth account and returns a
   * one-time temporary password; the RPC approves, activates and grants the
   * role in one transaction.
   *
   * Same shape as {@link changeApproval} — a result object with a normalized
   * error code, nothing thrown. The UI gates are advisory; `admin_invite_user`
   * re-checks the executor and the role allow-list server-side.
   *
   * The returned password is NEVER cached or persisted (decision D1). The
   * query cache is invalidated so the new row appears, but the credential
   * itself lives only in the caller's state until the dialog closes.
   */
  const inviteUser = useCallback(
    async (input: {
      readonly email: string;
      readonly fullName?: string;
      readonly targetRole: InviteRole;
    }): Promise<InviteResult> => {
      const client = getSupabase();
      if (!client || !actorId) return { ok: false, code: 'unavailable' };
      if (inviteInFlightRef.current) return { ok: false, code: 'in-flight' };
      if (!actorCanInvite) return { ok: false, code: 'forbidden' };

      const email = input.email.trim().toLowerCase();
      if (!INVITE_EMAIL_PATTERN.test(email)) return { ok: false, code: 'invalid-email' };
      const fullName = input.fullName?.trim();

      inviteInFlightRef.current = true;
      try {
        const body: Record<string, unknown> = { email, targetRole: input.targetRole };
        if (fullName !== undefined && fullName !== '') body['fullName'] = fullName;
        const response: { data?: unknown; error: unknown } = await client.functions.invoke(
          'admin-invite-user',
          { body },
        );
        if (response.error) return { ok: false, ...(await mapInviteInvokeError(response.error)) };

        const data: unknown = response.data;
        const userId = isRecord(data) ? asString(data['userId']) : '';
        const tempPassword = isRecord(data) ? asString(data['tempPassword']) : '';
        /* A 200 without a password would leave an account nobody can enter:
           treat it as a failure rather than reporting success. */
        if (userId === '' || tempPassword === '') return { ok: false, code: 'unknown' };

        await queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
        return { ok: true, userId, tempPassword };
      } catch (caught) {
        return { ok: false, code: toInviteErrorCode(caught) };
      } finally {
        inviteInFlightRef.current = false;
      }
    },
    [actorCanInvite, actorId, queryClient],
  );

  /**
   * Set a new password on an existing account and return it for one-time
   * display (decision D1).
   *
   * Three phases server-side: a read-only authority gate, the GoTrue credential
   * write, then the audit row. `auditRecorded: false` means the password IS
   * live but the trail is missing — surfaced, not swallowed.
   *
   * Owner protection is enforced by `is_original_owner()` in SQL (decision D6);
   * the UI check below only hides the control.
   */
  const resetUserPassword = useCallback(
    async (userId: string): Promise<PasswordResetResult> => {
      const client = getSupabase();
      if (!client || !actorId) return { ok: false, userId, code: 'unavailable' };
      if (passwordResetInFlightRef.current.has(userId))
        return { ok: false, userId, code: 'in-flight' };
      if (!actorCanInvite) return { ok: false, userId, code: 'forbidden' };

      const target = users.find((user) => user.id === userId);
      /* Advisory only: the RPC re-checks approval, status and owner protection. */
      if (
        !target ||
        target.approvalStatus !== 'approved' ||
        target.status !== 'active' ||
        target.isProtected
      )
        return { ok: false, userId, code: 'owner-protection' };

      passwordResetInFlightRef.current.add(userId);
      setPendingUserId(userId);
      try {
        const response: { data?: unknown; error: unknown } = await client.functions.invoke(
          'admin-set-password',
          { body: { userId } },
        );
        if (response.error)
          return { ok: false, userId, ...(await mapPasswordResetInvokeError(response.error)) };

        const data: unknown = response.data;
        const tempPassword = isRecord(data) ? asString(data['tempPassword']) : '';
        if (tempPassword === '') return { ok: false, userId, code: 'unknown' };
        return {
          ok: true,
          userId,
          tempPassword,
          auditRecorded: isRecord(data) ? data['auditRecorded'] !== false : true,
        };
      } catch (caught) {
        return { ok: false, userId, code: toPasswordResetErrorCode(caught) };
      } finally {
        passwordResetInFlightRef.current.delete(userId);
        setPendingUserId(null);
      }
    },
    [actorCanInvite, actorId, users],
  );

  return {
    users,
    approvalFilter,
    setApprovalFilter,
    approveUser,
    rejectUser,
    changeUserRole,
    inviteUser,
    resetUserPassword,
    actorId,
    actorIsSuperAdmin,
    actorCanApprove,
    actorCanInvite,
    activeSuperAdmins,
    isInitialLoading: query.isPending,
    isRefreshing: query.isFetching && !query.isPending,
    fetchError:
      query.error === null
        ? null
        : query.error instanceof UserManagementError
          ? query.error.code
          : 'unknown',
    lastSyncedAt: query.dataUpdatedAt > 0 ? query.dataUpdatedAt : null,
    realtimeState,
    pendingUserId,
    refresh,
    setUserStatus,
  };
}
