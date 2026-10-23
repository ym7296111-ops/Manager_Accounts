-- Executive dashboard: honor the configured project time zone.
--
-- `get_executive_dashboard` (20261023000000, later patched in place by the
-- 20261026000000 reset-queue predicate rewrite) pinned every calendar window
-- to UTC: "signed in today" and the daily-signup buckets were computed on UTC
-- days even when the project runs on another zone, so the numbers a Riyadh or
-- Cairo operator saw at 01:30 local were still yesterday's. The project time
-- zone already exists as a first-class, audited setting
-- (`app_settings.appearance.default_timezone`, seeded 'Europe/Paris', written
-- through `admin_update_appearance_settings` with IANA validation) — this
-- migration makes the dashboard read it, exactly like the backup scheduler
-- (20261001160000) already does:
--
--   * the setting is read live on every call (an admin changing the zone sees
--     the next snapshot move with it — nothing is cached in the function);
--   * a missing, blank or invalid IANA name falls back to 'UTC', and the
--     response `timezone` field always echoes the zone that was APPLIED, so
--     a fallback is loud in the payload rather than silent;
--   * day boundaries are computed as LOCAL CALENDAR midnights
--     (`local_date::timestamp at time zone zone`), not `timestamptz + 1 day`,
--     so zones with DST (for example Africa/Cairo) keep exact 23/25-hour
--     days instead of drifting by an hour twice a year.
--
-- Everything else is preserved verbatim from the published definition:
-- capability gates, aggregate-only shape, masked labels, and the
-- 20261026000000 reset-queue predicate
-- (`pending_approval` / `awaiting_password`). Forward-only.

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
  v_timezone text;
  v_today date;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_window_start timestamptz;
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

  -- (d) Project time zone from appearance settings, with a UTC fallback for a
  --     missing/blank/invalid value. Mirrors the read idiom in
  --     `generate_scheduled_backup_requests`: trim, probe validity against the
  --     engine, and fall back instead of failing the whole dashboard.
  begin
    select nullif(btrim(coalesce(s.value #>> '{}', '')), '')
      into v_timezone
      from public.app_settings as s
     where s.key = 'appearance.default_timezone';

    if v_timezone is null then
      v_timezone := 'UTC';
    else
      -- Engine-level validity probe; unknown zones raise below.
      perform (now() at time zone v_timezone);
    end if;
  exception when others then
    v_timezone := 'UTC';
  end;

  -- Local calendar boundaries in the project time zone. Adding days to the
  -- LOCAL date (not to the timestamptz) keeps DST transition days exact.
  v_today := (now() at time zone v_timezone)::date;
  v_day_start := v_today::timestamp at time zone v_timezone;
  v_day_end := (v_today + 1)::timestamp at time zone v_timezone;
  v_window_start := (v_today - (v_window - 1))::timestamp at time zone v_timezone;

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
   where status in ('pending_approval'::public.password_reset_request_status, 'awaiting_password'::public.password_reset_request_status);

  -- "Signed in today" in the PROJECT time zone: the sign-in instant falls on
  -- the same local calendar day as now(). Only approved + active accounts
  -- count, matching the definition shown next to the card.
  select count(*)::int
    into v_signed_in_today
    from auth.users as u
    join public.profiles as p on p.id = u.id
   where u.last_sign_in_at >= v_day_start
     and u.last_sign_in_at < v_day_end
     and p.status = 'active'
     and p.approval_status = 'approved';

  -- Daily signups, oldest → newest, zero-filled. Bucketed by LOCAL calendar
  -- day in the project time zone, so the series always has exactly
  -- `v_window` points ending at the local "today".
  with days as (
    select generate_series(
      v_today - (v_window - 1),
      v_today,
      interval '1 day'
    )::date as day
  ),
  counts as (
    select (p.created_at at time zone v_timezone)::date as day,
           count(*)::int as n
      from public.profiles as p
     where p.created_at >= v_window_start
       and p.created_at < v_day_end
     group by 1
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'day', to_char(days.day, 'YYYY-MM-DD'),
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

  -- Last 10 administrative events, as ABSOLUTE instants: `occurred_at` keeps
  -- the stored timestamptz and the response-level `timezone` field tells the
  -- UI in which zone to render it — the instant itself never shifts here.
  -- Labels are resolved server-side and e-mail addresses are masked with the
  -- same pattern `audit_logs` already applies; raw metadata never leaves the
  -- database.
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
  'Read-only executive dashboard snapshot: KPIs, project-timezone daily signups, role distribution and the last 10 administrative audit events. The project time zone is read live from app_settings (appearance.default_timezone) with a UTC fallback for a missing/invalid value, and echoed back in the response. SECURITY DEFINER with an explicit dashboard:read gate (42501 otherwise); never returns row-level PII, passwords or raw audit metadata.';

-- `create or replace` keeps the 20261023000000 grants; restated so this
-- migration alone describes the function's exposure.
revoke all on function public.get_executive_dashboard(integer) from public, anon;
grant execute on function public.get_executive_dashboard(integer) to authenticated, service_role;

notify pgrst, 'reload schema';
