-- Executive dashboard read model (single read-only RPC).
--
-- The `executive` role holds exactly one capability (`dashboard:read`), and
-- every table behind the dashboard indicators is protected by row level
-- security that requires `is_admin()` (the wildcard) or a specific
-- owner/super_admin role. A browser-side query would therefore return numbers
-- that look plausible but are silently narrowed to the caller's own rows
-- (for `profiles` that is exactly one row). The dashboard must never display
-- such figures, so all aggregates are computed inside ONE SECURITY DEFINER
-- function with an explicit capability gate and a fixed, aggregate-only
-- response shape:
--
--   * no row-level payloads, no e-mail addresses, no passwords;
--   * `audit_logs.metadata` is never returned raw (only the event name and
--     the already-sanitized `role_slugs` array);
--   * `password_reset_requests` contributes a COUNT only — `new_password`
--     and `email` are never selected.
--
-- Authorization (D2): executive + admin + owner. `dashboard:read` is granted
-- to `admin` below; `owner` already holds every permission explicitly and
-- `super_admin` holds the wildcard, so `has_permission('dashboard:read')`
-- passes for all three. `viewer` / `editor` keep `dashboard.view` (the legacy
-- seeded slug) and are refused with 42501.
--
-- Time semantics (D3): "signed in today" means
-- `auth.users.last_sign_in_at >= today 00:00 UTC` for active, approved
-- profiles. The window for daily signups is also bucketed in UTC, and the
-- response echoes `timezone: "UTC"` so the UI can state it.

-- ---------------------------------------------------------------------------
-- 1) Indexes used by the aggregates
-- ---------------------------------------------------------------------------
create index if not exists audit_logs_created_at_idx
  on public.audit_logs (created_at desc);

create index if not exists profiles_created_at_idx
  on public.profiles (created_at);

create index if not exists profiles_pending_approval_idx
  on public.profiles (approval_status)
  where approval_status = 'pending';

-- ---------------------------------------------------------------------------
-- 2) D2: the general administrator also sees the executive indicators
-- ---------------------------------------------------------------------------
-- `executive` already owns the capability, `owner` was granted every permission
-- explicitly, and `super_admin` matches through the wildcard. `admin` needs the
-- explicit grant; viewer/editor deliberately do NOT receive it.
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
  from public.roles as r
  join public.permissions as p on p.slug = 'dashboard:read'
 where r.slug = 'admin'
on conflict (role_id, permission_id) do nothing;

-- ---------------------------------------------------------------------------
-- 3) The read model
-- ---------------------------------------------------------------------------
create or replace function public.get_executive_dashboard(
  p_window_days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_window integer := coalesce(p_window_days, 30);
  v_timezone constant text := 'UTC';
  v_day_start timestamptz;
  v_total_users integer;
  v_pending_approvals integer;
  v_suspended_users integer;
  v_pending_password_resets integer;
  v_signed_in_today integer;
  v_daily_signups jsonb;
  v_role_items jsonb;
  v_users_without_role integer;
  v_recent_activity jsonb;
begin
  -- (a) Authenticated, active and approved. `has_permission` alone only checks
  --     profiles.status, so the approval dimension is enforced separately.
  if auth.uid() is null or not coalesce(public.is_active_user(), false) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  -- (b) Capability gate. `has_permission` is wildcard-aware, so owner and
  --     super_admin pass without an explicit dashboard grant.
  if not public.has_permission('dashboard:read') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  -- (c) Bounded parameter: no unbounded scans, no free-form input.
  if v_window < 7 or v_window > 90 then
    raise exception 'invalid_window' using errcode = '22023';
  end if;

  v_day_start := date_trunc('day', now() at time zone v_timezone) at time zone v_timezone;

  select count(*)::int
    into v_total_users
    from public.profiles;

  select count(*)::int
    into v_pending_approvals
    from public.profiles
   where approval_status = 'pending';

  select count(*)::int
    into v_suspended_users
    from public.profiles
   where status = 'suspended';

  select count(*)::int
    into v_pending_password_resets
    from public.password_reset_requests
   where status = 'pending';

  -- "Signed in today" (UTC). Only approved + active accounts count, matching
  -- the definition shown next to the card.
  select count(*)::int
    into v_signed_in_today
    from auth.users as u
    join public.profiles as p on p.id = u.id
   where u.last_sign_in_at >= v_day_start
     and u.last_sign_in_at < v_day_start + interval '1 day'
     and p.status = 'active'
     and p.approval_status = 'approved';

  -- Daily signups, oldest → newest, zero-filled. Bucketed in UTC so the
  -- series always has exactly `v_window` points.
  with days as (
    select generate_series(
      v_day_start - make_interval(days => v_window - 1),
      v_day_start,
      interval '1 day'
    ) as day
  ),
  counts as (
    select date_trunc('day', p.created_at at time zone v_timezone) at time zone v_timezone as day,
           count(*)::int as n
      from public.profiles as p
     where p.created_at >= v_day_start - make_interval(days => v_window - 1)
       and p.created_at < v_day_start + interval '1 day'
     group by 1
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'day', to_char(days.day at time zone v_timezone, 'YYYY-MM-DD'),
               'count', coalesce(counts.n, 0)
             )
             order by days.day
           ),
           '[]'::jsonb
         )
    into v_daily_signups
    from days
    left join counts on counts.day = days.day;

  -- Role distribution. Every user can hold several roles, so the sum of these
  -- counts may exceed `total_users`; the UI states that explicitly.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'slug', r.slug,
               'name_ar', r.name_ar,
               'name_en', r.name_en,
               'user_count', coalesce(members.n, 0)
             )
             order by coalesce(members.n, 0) desc, r.slug
           ),
           '[]'::jsonb
         )
    into v_role_items
    from public.roles as r
    left join (
      select ur.role_id, count(*)::int as n
        from public.user_roles as ur
       group by ur.role_id
    ) as members on members.role_id = r.id;

  select count(*)::int
    into v_users_without_role
    from public.profiles as p
   where not exists (
     select 1 from public.user_roles as ur where ur.user_id = p.id
   );

  -- Last 10 administrative events. Labels are resolved server-side and e-mail
  -- addresses are masked with the same pattern `audit_logs` already applies;
  -- raw metadata never leaves the database.
  select coalesce(
           jsonb_agg(entry order by created_at desc, id desc),
           '[]'::jsonb
         )
    into v_recent_activity
    from (
      select al.created_at,
             al.id,
             jsonb_build_object(
               'id', al.id,
               'occurred_at', al.created_at,
               'action', al.action,
               'event', coalesce(al.metadata ->> 'event', al.action::text),
               'entity', al.entity,
               'actor_kind', case when al.actor_id is null then 'system' else 'user' end,
               'actor_label', coalesce(
                 nullif(btrim(actor.full_name), ''),
                 regexp_replace(
                   coalesce(actor.email, ''),
                   '([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})',
                   '\1***\2',
                   'gi'
                 )
               ),
               'target_label', coalesce(
                 nullif(btrim(target.full_name), ''),
                 nullif(btrim(target_role.name_en), ''),
                 regexp_replace(
                   coalesce(target.email, ''),
                   '([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})',
                   '\1***\2',
                   'gi'
                 )
               ),
               'role_slugs', case
                 when jsonb_typeof(al.metadata -> 'role_slugs') = 'array'
                   then al.metadata -> 'role_slugs'
                 else '[]'::jsonb
               end
             ) as entry
        from public.audit_logs as al
        left join public.profiles as actor on actor.id = al.actor_id
        left join public.profiles as target
          on target.id::text = al.entity_id
         and al.entity in ('user', 'profiles', 'user_roles')
        left join public.roles as target_role
          on target_role.id::text = al.entity_id
         and al.entity = 'role_permissions'
       order by al.created_at desc, al.id desc
       limit 10
    ) as recent;

  return jsonb_build_object(
    'generated_at', now(),
    'timezone', v_timezone,
    'window_days', v_window,
    'kpis', jsonb_build_object(
      'total_users', v_total_users,
      'pending_approvals', v_pending_approvals,
      'suspended_users', v_suspended_users,
      'pending_password_resets', v_pending_password_resets,
      'signed_in_today', v_signed_in_today
    ),
    'daily_signups', v_daily_signups,
    'role_distribution', jsonb_build_object(
      'items', v_role_items,
      'users_without_role', v_users_without_role
    ),
    'recent_activity', v_recent_activity
  );
end;
$$;

comment on function public.get_executive_dashboard(integer) is
  'Read-only executive dashboard snapshot: KPIs, UTC daily signups, role distribution and the last 10 administrative audit events. SECURITY DEFINER with an explicit dashboard:read gate (42501 otherwise); never returns row-level PII, passwords or raw audit metadata.';

-- The browser never receives EXECUTE unless it is an authenticated caller; the
-- function body re-checks the capability for every invocation.
revoke all on function public.get_executive_dashboard(integer) from public, anon;
grant execute on function public.get_executive_dashboard(integer) to authenticated, service_role;

notify pgrst, 'reload schema';
