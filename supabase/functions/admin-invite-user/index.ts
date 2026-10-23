// Service-only bridge: creates an Auth account on an administrator's behalf and
// returns a one-time temporary password that is never stored anywhere.
//
// SIBLING FUNCTION — read before changing either one:
//   admin-invite-user  (this file) — creates a NEW account, reveals a password.
//   admin-set-password            — sets a password on an EXISTING account.
// They are deliberately separate: only this one calls auth.admin.createUser,
// and only that one can collide with an existing email.
//
// Never returns the service key and never accepts an executor id from the
// browser: the actor is always resolved from the verified JWT, and the
// owner/super_admin authority check lives in the SQL RPC (admin_invite_user).
//
// Order of operations matters. The Auth account is created FIRST so that
// handle_new_user() inserts the profile; the RPC then approves, activates and
// grants the role. If the RPC fails the freshly created account is deleted
// again — an invited user must never be left behind as a pending account that
// nobody can see or approve.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { generateTempPassword } from '../_shared/temp-password.ts';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const respond = (status: number, body: object) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

/** Roles an invitation may grant. Mirrors the allow-list in admin_invite_user. */
const INVITE_ROLES = new Set(['viewer', 'editor', 'admin', 'executive']);

/* RFC-5322 is not worth a regex; this is the pragmatic shape check the rest of
   the codebase uses. GoTrue is the real authority on address validity. */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return respond(405, { error: 'method_not_allowed' });

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) return respond(503, { error: 'unavailable' });

  const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return respond(401, { error: 'unauthorized' });
  const verifier = createClient(url, anonKey, { auth: { persistSession: false } });
  const {
    data: { user },
    error: authError,
  } = await verifier.auth.getUser(token);
  if (authError || !user) return respond(401, { error: 'unauthorized' });

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return respond(400, { error: 'invalid_action' });
  }
  if (!payload || typeof payload !== 'object') return respond(400, { error: 'invalid_action' });
  const { email, fullName, targetRole } = payload as Record<string, unknown>;

  if (typeof email !== 'string' || !EMAIL_PATTERN.test(email.trim()))
    return respond(400, { error: 'invalid_email' });
  if (typeof targetRole !== 'string' || !INVITE_ROLES.has(targetRole))
    return respond(400, { error: 'invalid_role' });

  /* Optional display name. handle_new_user() falls back to the local part of
     the address when metadata carries no full_name, so this stays optional. */
  const name = typeof fullName === 'string' && fullName.trim() !== '' ? fullName.trim() : undefined;
  const normalizedEmail = email.trim().toLowerCase();

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const tempPassword = generateTempPassword();

  // ---- 1. create the Auth account (fires handle_new_user) ----
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: normalizedEmail,
    password: tempPassword,
    email_confirm: true,
    user_metadata: name === undefined ? {} : { full_name: name },
  });
  if (createError || !created?.user) {
    const message = (createError?.message ?? '').toLowerCase();
    if (message.includes('already registered') || message.includes('already been registered'))
      return respond(409, { error: 'email_exists' });
    return respond(502, { error: 'unavailable' });
  }
  const userId = created.user.id;

  // ---- 2. approve, activate and grant the role ----
  const { error } = await admin.rpc('admin_invite_user', {
    p_user_id: userId,
    p_target_role: targetRole,
    p_executor_id: user.id,
  });
  if (error) {
    /* Roll the orphaned account back. Best effort: if this fails the account
       stays pending and an owner can still reject it from the approval queue,
       which is recoverable; silently swallowing the RPC failure is not. */
    await admin.auth.admin.deleteUser(userId);
    const code = error.code ?? '';
    const message = (error.message ?? '').toLowerCase();
    if (code === '42501' || message.includes('owner_protection'))
      return respond(403, { error: 'permission_denied' });
    if (code === 'P0002') return respond(404, { error: 'user_not_found' });
    if (message.includes('invalid_role')) return respond(400, { error: 'invalid_role' });
    return respond(400, { error: 'invalid_action' });
  }

  /* The password leaves this function exactly once, in this body. Nothing
     above wrote it to a table, an audit row or a log line. */
  return respond(200, { ok: true, userId, tempPassword });
});
