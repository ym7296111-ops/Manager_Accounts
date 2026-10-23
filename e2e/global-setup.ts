import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { E2EDatabase } from './fixtures/database.types.ts';

export interface E2EFixtures {
  readonly supabaseUrl: string;
  readonly anonKey: string;
  readonly serviceRoleKey: string;
  readonly owner: { readonly id: string; readonly email: string; readonly password: string };
  readonly pending: { readonly id: string; readonly email: string; readonly password: string };
  readonly approved: { readonly id: string; readonly email: string; readonly password: string };
  readonly delegate: { readonly id: string; readonly email: string; readonly password: string };
}

export const fixturesPath = fileURLToPath(new URL('../.auth/fixtures.json', import.meta.url));

type E2EAdminClient = SupabaseClient<E2EDatabase>;

function randomPassword(): string {
  return `E2e-${randomBytes(24).toString('base64url')}!`;
}

export default async function globalSetup(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    throw new Error(
      'E2E requires local Supabase env vars: SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY.',
    );
  }

  const admin = createClient<E2EDatabase>(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: users, error: listError } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1,
  });
  if (listError) throw new Error(`Could not inspect the local Auth database: ${listError.message}`);
  if (users.users.length !== 0) {
    throw new Error(
      'E2E expects an empty local Auth database so the first account becomes owner. Run `supabase db reset --local` first.',
    );
  }

  const runId = randomUUID();
  // Bootstrap uses the same public Auth signup endpoint as a real first visit;
  // the first-owner trigger confirms it and grants the protected owner role.
  const owner = await createFirstOwner(
    supabaseUrl,
    anonKey,
    `owner-${runId}@example.com`,
    randomPassword(),
  );
  const pending = await createAccount(admin, `pending-${runId}@example.com`, randomPassword());
  const approved = await createAccount(admin, `approved-${runId}@example.com`, randomPassword());
  const delegate = await createAccount(admin, `delegate-${runId}@example.com`, randomPassword());

  await assertFirstUserIsOwner(admin, owner.id);
  const { error: approvalError } = await admin.rpc('admin_approve_user', {
    p_user_id: approved.id,
    p_action: 'approve',
    p_executor_id: owner.id,
    p_target_role: 'viewer',
  });
  if (approvalError) {
    throw new Error(
      `Could not prepare the approved password-reset fixture: ${approvalError.message}`,
    );
  }

  const { error: delegateApprovalError } = await admin.rpc('admin_approve_user', {
    p_user_id: delegate.id,
    p_action: 'approve',
    p_executor_id: owner.id,
    p_target_role: 'viewer',
  });
  if (delegateApprovalError) {
    throw new Error(
      `Could not prepare the delegated user fixture: ${delegateApprovalError.message}`,
    );
  }
  for (const permission of ['users.approve', 'password_reset.manage'] as const) {
    const { error } = await admin.rpc('admin_grant_capability', {
      p_user_id: delegate.id,
      p_permission_slug: permission,
      p_expires_at: null,
      p_executor_id: owner.id,
    });
    if (error) {
      throw new Error(`Could not grant delegated E2E capability ${permission}: ${error.message}`);
    }
  }

  const fixtureData: E2EFixtures = {
    supabaseUrl,
    anonKey,
    serviceRoleKey,
    owner,
    pending,
    approved,
    delegate,
  };

  await mkdir(fileURLToPath(new URL('../.auth/', import.meta.url)), { recursive: true });
  await writeFile(fixturesPath, `${JSON.stringify(fixtureData, null, 2)}\n`, { mode: 0o600 });

  // Workers run in separate processes, so they read generated fixtures from
  // the ignored file. Keep the credentials available in this setup process too.
  process.env.E2E_OWNER_EMAIL = owner.email;
  process.env.E2E_OWNER_PASSWORD = owner.password;
  process.env.E2E_PENDING_EMAIL = pending.email;
  process.env.E2E_PENDING_PASSWORD = pending.password;
  process.env.E2E_APPROVED_EMAIL = approved.email;
  process.env.E2E_APPROVED_PASSWORD = approved.password;
}

async function createFirstOwner(
  supabaseUrl: string,
  anonKey: string,
  email: string,
  password: string,
): Promise<{ id: string; email: string; password: string }> {
  const publicClient = createClient<E2EDatabase>(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await publicClient.auth.signUp({
    email,
    password,
    options: { data: { full_name: email.split('@')[0] } },
  });
  if (error || !data.user) {
    throw new Error(
      `Could not bootstrap the first local owner: ${error?.message ?? 'no user returned'}`,
    );
  }
  return { id: data.user.id, email, password };
}

async function createAccount(
  admin: E2EAdminClient,
  email: string,
  password: string,
): Promise<{ id: string; email: string; password: string }> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: email.split('@')[0] },
  });
  if (error || !data.user) {
    throw new Error(
      `Could not create a local E2E Auth account: ${error?.message ?? 'no user returned'}`,
    );
  }
  return { id: data.user.id, email, password };
}

async function assertFirstUserIsOwner(admin: E2EAdminClient, ownerId: string): Promise<void> {
  const [{ data: profile, error: profileError }, { data: assignments, error: rolesError }] =
    await Promise.all([
      admin.from('profiles').select('approval_status,status').eq('id', ownerId).single(),
      admin.from('user_roles').select('role_id').eq('user_id', ownerId),
    ]);
  if (profileError || rolesError) {
    throw new Error(
      `Could not verify the first-owner fixture: ${profileError?.message ?? rolesError?.message}`,
    );
  }

  const roleIds = assignments.map((assignment) => assignment.role_id);
  const { data: roles, error: roleLookupError } = await admin
    .from('roles')
    .select('slug')
    .in('id', roleIds);
  if (roleLookupError) {
    throw new Error(`Could not verify the owner role: ${roleLookupError.message}`);
  }

  const hasOwnerRole = roles.some((role) => role.slug === 'owner');
  if (profile.approval_status !== 'approved' || profile.status !== 'active' || !hasOwnerRole) {
    throw new Error(
      'The first E2E Auth account was not provisioned as the approved, active owner.',
    );
  }
}
