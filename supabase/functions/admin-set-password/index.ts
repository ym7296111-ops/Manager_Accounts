// Service-only bridge: an administrator sets a NEW password on an EXISTING
// account and the value is shown on screen exactly once.
//
// SIBLING FUNCTION — read before changing either one:
//   admin-set-password  (this file) — existing account, admin-initiated,
//                                     no request row, password revealed.
//   admin-reset-password            — the deferred OTP approval flow: a user
//                                     files a password_reset_requests row and
//                                     an admin approves it; it likewise returns
//                                     the generated password exactly once.
// The two call auth.admin.updateUserById for different reasons; do not merge
// them or route one through the other.
//
// Three phases, mirroring the manual-approval flow's shape but with no queue:
//   1. admin_verify_password_reset_authority — read-only gate (authority +
//      target eligibility + original-owner protection). Writes nothing.
//   2. auth.admin.updateUserById — the actual credential write, in GoTrue.
//   3. admin_record_password_reset — the audit trail.
//
// Phase ordering is a deliberate trade: if phase 3 fails the password HAS
// already changed, so the response still carries it (an unrecoverable account
// is worse than a missing audit row) but flags `auditRecorded: false` so the
// operator knows to follow up.
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

const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** Map an RPC refusal onto the wire taxonomy. */
const rpcFailure = (error: { code?: string; message?: string }): Response => {
  const code = error.code ?? '';
  const message = (error.message ?? '').toLowerCase();
  if (code === '42501')
    return respond(403, {
      error: message.includes('owner_protection') ? 'owner_protection' : 'permission_denied',
    });
  if (code === 'P0002') return respond(404, { error: 'user_not_found' });
  return respond(400, { error: 'invalid_action' });
};

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
  const { userId } = payload as Record<string, unknown>;
  if (typeof userId !== 'string' || !UUID_PATTERN.test(userId))
    return respond(400, { error: 'invalid_action' });

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // ---- 1. authorize (read-only) ----
  const { error: gateError } = await admin.rpc('admin_verify_password_reset_authority', {
    p_user_id: userId,
    p_executor_id: user.id,
  });
  if (gateError) return rpcFailure(gateError);

  // ---- 2. write the credential in GoTrue ----
  const tempPassword = generateTempPassword();
  const { error: updateError } = await admin.auth.admin.updateUserById(userId, {
    password: tempPassword,
  });
  if (updateError) {
    /* GoTrue attributes policy refusals to the value itself ("Password should
       be at least …"); anything else is an upstream failure worth retrying.
       Nothing has been audited yet, so a retry is clean. */
    const message = (updateError.message ?? '').toLowerCase();
    if (message.includes('not found')) return respond(404, { error: 'user_not_found' });
    const refused = message.includes('password');
    return respond(refused ? 422 : 502, {
      error: refused ? 'password_rejected' : 'password_update_failed',
    });
  }

  // ---- 3. audit ----
  const { error: recordError } = await admin.rpc('admin_record_password_reset', {
    p_user_id: userId,
    p_executor_id: user.id,
  });
  /* The credential is already live. Withholding it here would leave an account
     whose password nobody knows; the missing audit row is recoverable, that is
     not. Surface the gap instead of hiding it. */
  if (recordError) return respond(200, { ok: true, tempPassword, auditRecorded: false });

  /* The password leaves this function exactly once, in this body. */
  return respond(200, { ok: true, tempPassword, auditRecorded: true });
});
