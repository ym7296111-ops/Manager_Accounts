// Service-only bridge: never return the service key or accept an actor ID from the browser.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
  const { userId, action, targetRole } = payload as Record<string, unknown>;
  if (
    typeof userId !== 'string' ||
    !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(userId) ||
    (action !== 'approve' && action !== 'reject')
  )
    return respond(400, { error: 'invalid_action' });
  /* Optional target role for approvals. The RPC re-validates it exists and is
     not a protected role (owner / is_super_admin can never be granted here). */
  let role = 'viewer';
  if (targetRole !== undefined && targetRole !== null) {
    if (typeof targetRole !== 'string' || !/^[a-z][a-z0-9_]{0,29}$/.test(targetRole))
      return respond(400, { error: 'invalid_role' });
    role = targetRole;
  }
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const { error } = await admin.rpc('admin_approve_user', {
    p_user_id: userId,
    p_action: action,
    p_executor_id: user.id,
    p_target_role: role,
  });
  if (error)
    return respond(error.code === '42501' ? 403 : error.code === 'P0002' ? 404 : 400, {
      error:
        error.code === '42501'
          ? 'permission_denied'
          : error.code === 'P0002'
            ? 'not_found'
            : error.message?.includes('invalid_role')
              ? 'invalid_role'
              : 'invalid_transition',
    });
  return respond(200, { ok: true });
});
