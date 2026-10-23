// Service-only bridge for user-scoped capabilities and the limited approval queue.
// The executor is always the identity returned by auth.getUser(verified JWT); no
// executor id or role information is accepted from the browser.
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
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
/*
 * No hardcoded capability allow-list here: which permissions may be delegated
 * is owner-controlled data (`public.permissions.is_delegatable`), and
 * `admin_grant_capability` enforces it. This bridge validates SHAPE only —
 * a bounded slug-shaped string — and stays an executor-identity courier.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,99}$/;

function mapRpcFailure(error: { code?: string; message?: string }): Response {
  const code = error.code ?? '';
  const message = (error.message ?? '').toLowerCase();
  /* Named refusal first: it shares 42501 with generic permission denials. */
  if (message.includes('capability_not_delegatable'))
    return respond(403, { error: 'capability_not_delegatable' });
  if (code === '42501' || message.includes('permission_denied'))
    return respond(403, { error: 'permission_denied' });
  if (code === '23505') return respond(409, { error: 'capability_already_granted' });
  if (code === 'P0002') return respond(404, { error: 'not_found' });
  if (code === '22023') return respond(400, { error: 'invalid_action' });
  return respond(400, { error: 'unknown' });
}

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
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    return respond(400, { error: 'invalid_action' });
  const body = payload as Record<string, unknown>;
  const action = body['action'];
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  if (action === 'approval-queue') {
    const { data, error } = await admin.rpc('get_approval_queue', { p_executor_id: user.id });
    if (error) return mapRpcFailure(error);
    return respond(200, { data: data ?? [] });
  }

  if (action === 'list-all') {
    const { error: gateError } = await admin.rpc('get_user_capabilities', {
      p_user_id: user.id,
      p_executor_id: user.id,
    });
    if (gateError) return mapRpcFailure(gateError);

    const nowIso = new Date().toISOString();
    const [capabilitiesRes, permissionsRes] = await Promise.all([
      admin
        .from('user_capabilities')
        .select('user_id, permission_id, granted_at, expires_at')
        .is('revoked_at', null)
        .or(`expires_at.is.null,expires_at.gt.${nowIso}`),
      admin.from('permissions').select('id, slug'),
    ]);
    if (capabilitiesRes.error) return mapRpcFailure(capabilitiesRes.error);
    if (permissionsRes.error) return mapRpcFailure(permissionsRes.error);

    const slugById = new Map(
      (permissionsRes.data ?? []).map((row) => [String(row.id), String(row.slug)]),
    );
    const data = (capabilitiesRes.data ?? [])
      .map((row) => {
        const permissionSlug = slugById.get(String(row.permission_id)) ?? '';
        return {
          user_id: String(row.user_id),
          permission_slug: permissionSlug,
          granted_at: String(row.granted_at),
          expires_at: typeof row.expires_at === 'string' ? row.expires_at : null,
        };
      })
      .filter((row) => row.user_id !== '' && row.permission_slug !== '');
    return respond(200, { data });
  }

  if (action === 'list') {
    const targetUserId = body['targetUserId'];
    if (typeof targetUserId !== 'string' || !UUID_PATTERN.test(targetUserId))
      return respond(400, { error: 'invalid_action' });
    const { data, error } = await admin.rpc('get_user_capabilities', {
      p_user_id: targetUserId,
      p_executor_id: user.id,
    });
    if (error) return mapRpcFailure(error);
    return respond(200, { data: data ?? [] });
  }

  if (action === 'grant') {
    const targetUserId = body['targetUserId'];
    const permissionSlug = body['permissionSlug'];
    const expiresAt = body['expiresAt'];
    if (
      typeof targetUserId !== 'string' ||
      !UUID_PATTERN.test(targetUserId) ||
      typeof permissionSlug !== 'string' ||
      !SLUG_PATTERN.test(permissionSlug) ||
      (expiresAt !== null &&
        expiresAt !== undefined &&
        (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))))
    )
      return respond(400, { error: 'invalid_action' });
    const { data, error } = await admin.rpc('admin_grant_capability', {
      p_user_id: targetUserId,
      p_permission_slug: permissionSlug,
      p_expires_at: expiresAt ?? null,
      p_executor_id: user.id,
    });
    if (error) return mapRpcFailure(error);
    return respond(200, { ok: true, id: data });
  }

  if (action === 'revoke') {
    const capabilityId = body['capabilityId'];
    if (typeof capabilityId !== 'string' || !UUID_PATTERN.test(capabilityId))
      return respond(400, { error: 'invalid_action' });
    const { error } = await admin.rpc('admin_revoke_capability', {
      p_capability_id: capabilityId,
      p_executor_id: user.id,
    });
    if (error) return mapRpcFailure(error);
    return respond(200, { ok: true });
  }

  return respond(400, { error: 'invalid_action' });
});
