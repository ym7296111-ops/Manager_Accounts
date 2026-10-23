-- =============================================================================
-- 20261031000000_user_lifecycle_auto_suspend_and_kpis.sql
--
-- User lifecycle hardening (forward-only):
--   1) `public.admin_set_user_roles(uuid, text[])`:
--      * When `p_role_slugs` resolves to an empty set (all roles removed),
--        automatically sets `public.profiles.status = 'suspended'`.
--      * When `p_role_slugs` assigns at least one role to an account that was
--        suspended with zero roles, automatically restores
--        `public.profiles.status = 'active'`.
--      * Preserves every existing security invariant verbatim: advisory lock,
--        `is_active_user() and is_admin()`, original-owner immutability,
--        uniform super-admin isolation refusal, unknown/protected slug check,
--        capability-based self-demotion guard, and last-admin lockout guards.
--   2) `public.get_executive_dashboard(integer)`:
--      * In `role_distribution`, counts only active + approved accounts
--        (`p.status = 'active' and p.approval_status = 'approved'`).
--      * Appends slice `slug = 'no_role'` representing pending accounts
--        (`approval_status = 'pending'`), excluding rejected accounts.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Auto-suspend / auto-reactivate inside admin_set_user_roles
-- ---------------------------------------------------------------------------
create or replace function public.admin_set_user_roles(
  p_user_id uuid,
  p_role_slugs text[]
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_target_status public.user_status;
  v_next_status public.user_status;
  v_requested_slugs text[];
  v_missing_slugs text[];
  v_desired_ids uuid[];
  v_current_ids uuid[];
  v_grant_ids uuid[];
  v_revoke_ids uuid[];
  v_granted_slugs text[];
  v_revoked_slugs text[];
  v_actor_star_before boolean;
  v_actor_manage_before boolean;
  v_actor_star_after boolean;
  v_actor_manage_after boolean;
  v_target_star_after boolean;
  v_active_super_admin_count bigint;
  v_active_super_admin_count_after bigint;
  v_active_admin_count_after bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('admin_authority_invariant', 0));

  if v_actor is null or not public.is_active_user() or not public.is_admin() then
    raise exception 'admin_set_user_roles: active administrator privileges required'
      using errcode = '42501';
  end if;

  if p_user_id is null then
    raise exception 'admin_set_user_roles: user id is required'
      using errcode = '22023';
  end if;

  if public.is_original_owner(p_user_id) then
    raise log 'owner_protection: roles RPC refused actor=% target=%', v_actor, p_user_id;
    raise exception 'owner_protection: owner roles are immutable' using errcode = '42501';
  end if;

  if not exists (select 1 from public.profiles as p where p.id = p_user_id)
     or exists (
       select 1
         from public.user_roles as ur
         join public.roles as r on r.id = ur.role_id
        where ur.user_id = p_user_id
          and r.is_super_admin
     ) then
    raise exception 'Operation not permitted'
      using errcode = '42501';
  end if;

  lock table public.profiles,
             public.user_roles,
             public.roles,
             public.role_permissions
    in share row exclusive mode;

  select p.status
    into v_target_status
    from public.profiles as p
   where p.id = p_user_id
   for update;

  if not found then
    raise exception 'Operation not permitted'
      using errcode = '42501';
  end if;

  select coalesce(array_agg(distinct btrim(s.slug) order by btrim(s.slug)), '{}'::text[])
    into v_requested_slugs
    from unnest(coalesce(p_role_slugs, '{}'::text[])) as s(slug)
   where s.slug is not null
     and btrim(s.slug) <> '';

  select coalesce(array_agg(s.slug order by s.slug), '{}'::text[])
    into v_missing_slugs
    from unnest(v_requested_slugs) as s(slug)
   where not exists (
     select 1 from public.roles as r where r.slug = s.slug and not r.is_super_admin
   );

  if cardinality(v_missing_slugs) > 0 then
    raise exception 'admin_set_user_roles: unknown role slug(s): %',
      array_to_string(v_missing_slugs, ', ')
      using errcode = 'P0002';
  end if;

  select coalesce(array_agg(r.id order by r.slug), '{}'::uuid[])
    into v_desired_ids
    from public.roles as r
   where r.slug = any (v_requested_slugs);

  select coalesce(array_agg(ur.role_id order by ur.role_id), '{}'::uuid[])
    into v_current_ids
    from public.user_roles as ur
   where ur.user_id = p_user_id;

  select coalesce(array_agg(w.role_id), '{}'::uuid[])
    into v_grant_ids
    from unnest(v_desired_ids) as w(role_id)
   where not (w.role_id = any (v_current_ids));

  select coalesce(array_agg(w.role_id), '{}'::uuid[])
    into v_revoke_ids
    from unnest(v_current_ids) as w(role_id)
   where not (w.role_id = any (v_desired_ids));

  -- Effective target status after role assignment:
  --   * 0 desired roles -> automatically suspend the account;
  --   * >=1 desired role on a role-less suspended account -> restore 'active'.
  if cardinality(v_desired_ids) = 0 then
    v_next_status := 'suspended'::public.user_status;
  elsif v_target_status = 'suspended'::public.user_status and cardinality(v_current_ids) = 0 then
    v_next_status := 'active'::public.user_status;
  else
    v_next_status := v_target_status;
  end if;

  if p_user_id = v_actor then
    select
      coalesce(bool_or(p.slug = '*'), false),
      coalesce(bool_or(p.slug in ('*', 'roles.manage')), false)
      into v_actor_star_before, v_actor_manage_before
      from public.user_roles as ur
      join public.role_permissions as rp on rp.role_id = ur.role_id
      join public.permissions as p on p.id = rp.permission_id
     where ur.user_id = v_actor;

    select
      coalesce(bool_or(p.slug = '*'), false),
      coalesce(bool_or(p.slug in ('*', 'roles.manage')), false)
      into v_actor_star_after, v_actor_manage_after
      from unnest(v_desired_ids) as desired(role_id)
      join public.role_permissions as rp on rp.role_id = desired.role_id
      join public.permissions as p on p.id = rp.permission_id;

    if v_actor_star_before and not v_actor_star_after then
      raise exception 'admin_set_user_roles: self-demotion guard — the caller would lose ''*'''
        using errcode = 'RBA01';
    end if;

    if v_actor_manage_before and not v_actor_manage_after then
      raise exception 'admin_set_user_roles: self-demotion guard — the caller would lose ''roles.manage'''
        using errcode = 'RBA01';
    end if;
  end if;

  select count(distinct p.id)
    into v_active_super_admin_count
    from public.profiles as p
    join public.user_roles as ur on ur.user_id = p.id
    join public.roles as r on r.id = ur.role_id
   where p.status = 'active'
     and r.slug = 'super_admin';

  select count(distinct p.id)
    into v_active_super_admin_count_after
    from public.profiles as p
   where (
       (p.id <> p_user_id and p.status = 'active' and exists (
          select 1
            from public.user_roles as ur
            join public.roles as r on r.id = ur.role_id
           where ur.user_id = p.id
             and r.slug = 'super_admin'
       ))
       or (p.id = p_user_id and v_next_status = 'active' and 'super_admin' = any (v_requested_slugs))
     );

  if v_active_super_admin_count > 0 and v_active_super_admin_count_after = 0 then
    raise exception 'admin_set_user_roles: last-admin-lockout — an active super_admin must remain'
      using errcode = 'RBA02';
  end if;

  select exists (
    select 1
      from unnest(v_desired_ids) as desired(role_id)
      join public.role_permissions as rp on rp.role_id = desired.role_id
      join public.permissions as p on p.id = rp.permission_id
     where p.slug = '*'
  )
    into v_target_star_after;

  select count(distinct p.id)
    into v_active_admin_count_after
    from public.profiles as p
   where (
       (p.id <> p_user_id and p.status = 'active' and exists (
          select 1
            from public.user_roles as ur
            join public.role_permissions as rp on rp.role_id = ur.role_id
            join public.permissions as permission on permission.id = rp.permission_id
           where ur.user_id = p.id
             and permission.slug = '*'
       ))
       or (p.id = p_user_id and v_next_status = 'active' and v_target_star_after)
     );

  if v_active_admin_count_after < 1 then
    raise exception 'admin_set_user_roles: last-admin-lockout — an active administrator must remain'
      using errcode = 'RBA02';
  end if;

  select coalesce(array_agg(r.slug order by r.slug), '{}'::text[])
    into v_granted_slugs
    from public.roles as r
   where r.id = any (v_grant_ids);

  select coalesce(array_agg(r.slug order by r.slug), '{}'::text[])
    into v_revoked_slugs
    from public.roles as r
   where r.id = any (v_revoke_ids);

  if cardinality(v_revoke_ids) > 0 then
    delete from public.user_roles as ur
     where ur.user_id = p_user_id
       and ur.role_id = any (v_revoke_ids);
  end if;

  if cardinality(v_grant_ids) > 0 then
    insert into public.user_roles (user_id, role_id, granted_by)
    select p_user_id, granted.role_id, v_actor
      from unnest(v_grant_ids) as granted(role_id)
    on conflict (user_id, role_id) do nothing;
  end if;

  if v_next_status is distinct from v_target_status then
    update public.profiles
       set status = v_next_status,
           updated_at = now()
     where id = p_user_id;
  end if;

  if cardinality(v_grant_ids) > 0 then
    insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (
      v_actor,
      'role.granted'::public.audit_action,
      'user_roles',
      p_user_id::text,
      jsonb_build_object('role_slugs', to_jsonb(v_granted_slugs))
    );
  end if;

  if cardinality(v_revoke_ids) > 0 then
    insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (
      v_actor,
      'role.revoked'::public.audit_action,
      'user_roles',
      p_user_id::text,
      jsonb_build_object('role_slugs', to_jsonb(v_revoked_slugs))
    );
  end if;

  return jsonb_build_object(
    'user_id', p_user_id,
    'granted', to_jsonb(v_granted_slugs),
    'revoked', to_jsonb(v_revoked_slugs)
  );
end;
$$;

revoke all on function public.admin_set_user_roles(uuid, text[]) from public, anon;
grant execute on function public.admin_set_user_roles(uuid, text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Executive dashboard KPIs: active+approved roles + pending `no_role` slice
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
  if auth.uid() is null or not coalesce(public.is_active_user(), false) then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  if not public.has_permission('dashboard:read') then
    raise exception 'permission_denied' using errcode = '42501';
  end if;

  if v_window < 7 or v_window > 90 then
    raise exception 'invalid_window' using errcode = '22023';
  end if;

  begin
    select nullif(btrim(coalesce(s.value #>> '{}', '')), '')
      into v_timezone
      from public.app_settings as s
     where s.key = 'appearance.default_timezone';

    if v_timezone is null then
      v_timezone := 'UTC';
    else
      perform (now() at time zone v_timezone);
    end if;
  exception when others then
    v_timezone := 'UTC';
  end;

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

  select count(*)::int
    into v_signed_in_today
    from auth.users as u
    join public.profiles as p on p.id = u.id
   where u.last_sign_in_at >= v_day_start
     and u.last_sign_in_at < v_day_end
     and p.status = 'active'
     and p.approval_status = 'approved';

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

  -- Active & approved workforce per role, plus the `no_role` slice representing
  -- pending users (`approval_status = 'pending'`; rejected users are excluded).
  v_users_without_role := v_pending_approvals;

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
         || jsonb_build_array(
           jsonb_build_object(
             'slug', 'no_role',
             'name_ar', 'بدون دور',
             'name_en', 'No Role',
             'user_count', v_users_without_role
           )
         )
    into v_role_items
    from public.roles as r
    left join (
      select ur.role_id, count(*)::int as n
        from public.user_roles as ur
        join public.profiles as p on p.id = ur.user_id
       where p.status = 'active'
         and p.approval_status = 'approved'
       group by ur.role_id
    ) as members on members.role_id = r.id;

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
               'actor_label', coalesce(
                 nullif(btrim(actor.full_name), ''),
                 regexp_replace(
                   coalesce(actor.email, ''),
                   '([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})',
                   '\1***\2',
                   'gi'
                 )
               ),
               'actor_kind', case when al.actor_id is null then 'system' else 'user' end,
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
  'Read-only executive dashboard snapshot: KPIs, project-timezone daily signups, active+approved role distribution with a pending no_role slice, and the last 10 administrative audit events.';

revoke all on function public.get_executive_dashboard(integer) from public, anon;
grant execute on function public.get_executive_dashboard(integer) to authenticated, service_role;

notify pgrst, 'reload schema';
