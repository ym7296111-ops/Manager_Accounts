// Service-only bridge for the manual password reset approval flow.
//
// The visitor submits only an email. On approval, this function GENERATES a
// one-time temporary password (same policy as the invite / admin-set-password
// flows), writes it straight to GoTrue, and returns it exactly once so the UI
// can reveal it in PasswordRevealDialog. It is never passed to SQL, stored, or
// written to logs. For backward compatibility a caller may still send
// `p_new_password`; when present (and valid) it is used instead of generating.
//
// Approve: reserve request → auth.admin.updateUserById → finalize queue/audit.
// A failed GoTrue write releases the reservation for a safe retry. Reject goes
// straight to finalize and never receives or reads a password.
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
const MIN_PASSWORD_LENGTH = 8;

/** Map a SQLSTATE/message pair raised by the RPCs onto the wire taxonomy. */
const rpcFailure = (error: { code?: string; message?: string }): Response => {
  const code = error.code ?? '';
  const message = (error.message ?? '').toLowerCase();
  if (code === '42501' || message.includes('permission_denied'))
    return respond(403, {
      error: message.includes('owner_protection') ? 'owner_protection' : 'permission_denied',
    });
  if (code === 'P0002')
    return respond(404, {
      error: message.includes('user_not_found') ? 'user_not_found' : 'not_found',
    });
  if (code === '22023' && message.includes('invalid_transition'))
    return respond(409, { error: 'invalid_transition' });
  if (code === '22023') return respond(400, { error: 'invalid_action' });
  return respond(400, { error: 'unknown' });
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
  const { requestId, action, p_new_password: newPassword } = payload as Record<string, unknown>;
  if (
    typeof requestId !== 'string' ||
    !UUID_PATTERN.test(requestId) ||
    (action !== 'approve' && action !== 'reject')
  )
    return respond(400, { error: 'invalid_action' });
  /* Backward compatibility only: an explicit password is honoured when sent,
     otherwise one is generated below. An explicitly sent-but-invalid value is
     still refused rather than silently replaced. */
  if (
    action === 'approve' &&
    newPassword !== undefined &&
    newPassword !== null &&
    (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH)
  )
    return respond(422, { error: 'password_rejected' });
  const tempPassword =
    action === 'approve'
      ? typeof newPassword === 'string' && newPassword.length >= MIN_PASSWORD_LENGTH
        ? newPassword
        : generateTempPassword()
      : null;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  if (action === 'reject') {
    const { error } = await admin.rpc('admin_finalize_password_reset_request', {
      p_request_id: requestId,
      p_action: action,
      p_executor_id: user.id,
    });
    if (error) return rpcFailure(error);
    return respond(200, { ok: true, status: 'rejected' });
  }

  // The SQL preparation RPC only authorizes and reserves the request. It does
  // not accept `p_new_password` and cannot return secret data.
  const { data, error } = await admin.rpc('admin_approve_password_reset_request', {
    p_request_id: requestId,
    p_executor_id: user.id,
  });
  if (error) return rpcFailure(error);
  const claim = (data ?? {}) as Record<string, unknown>;
  const authUserId = typeof claim['auth_user_id'] === 'string' ? claim['auth_user_id'] : '';
  if (!UUID_PATTERN.test(authUserId)) return respond(500, { error: 'claim_invalid' });

  const { error: updateError } = await admin.auth.admin.updateUserById(authUserId, {
    password: tempPassword as string,
  });
  if (updateError) {
    const message = (updateError.message ?? '').toLowerCase();
    const refused = message.includes('password');
    await admin.rpc('admin_release_password_reset_request', {
      p_request_id: requestId,
      p_executor_id: user.id,
    });
    return respond(refused ? 422 : 502, {
      error: refused ? 'password_rejected' : 'password_update_failed',
    });
  }

  const { error: finalizeError } = await admin.rpc('admin_finalize_password_reset_request', {
    p_request_id: requestId,
    p_action: 'approve',
    p_executor_id: user.id,
  });
  if (finalizeError) {
    // The credential has already changed. Releasing keeps the request
    // retryable, and the next approval simply generates a fresh value.
    await admin.rpc('admin_release_password_reset_request', {
      p_request_id: requestId,
      p_executor_id: user.id,
    });
    return rpcFailure(finalizeError);
  }
  /* The generated password leaves this function exactly once, in this body. */
  return respond(200, { ok: true, status: 'approved', tempPassword });
});
