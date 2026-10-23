-- Localization & Multi-Tenant Theme (screen 6 of 7).
--
--   * public.app_settings (key/value) stays the store; the `appearance` group
--     becomes the system-wide contract for default locale, text direction,
--     first-load theme, project time zone and weekend profile. Every key is
--     public so the login screen can resolve defaults before authentication.
--   * Direct client writes are revoked entirely; the SECURITY DEFINER RPC
--     admin_update_appearance_settings is the single, audited write path
--     (whitelist, value validation, optimistic lock, diff-only upserts).
--   * generate_scheduled_backup_requests() stops hardcoding 'Europe/Paris':
--     it now reads the project time zone and weekend profile dynamically,
--     falling back to UTC / Saturday+Sunday loudly (audit metadata) not silently.
--   * The pg_cron slot becomes an hourly idempotent check: a static UTC slot
--     can never mean "01:00 local" for every possible project time zone.

-- ---------------------------------------------------------------------------
-- 1) Seed the five localization keys (idempotent; never overwrites)
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, group_slug, value, is_public)
values
  ('appearance.default_locale', 'appearance', to_jsonb('ar'::text), true),
  ('appearance.default_direction', 'appearance', to_jsonb('rtl'::text), true),
  ('appearance.default_theme', 'appearance', to_jsonb('system'::text), true),
  ('appearance.default_timezone', 'appearance', to_jsonb('Europe/Paris'::text), true),
  ('appearance.weekend_days', 'appearance', '[6,7]'::jsonb, true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 2) Authorization helper (queried by the UI to gate the editor)
-- ---------------------------------------------------------------------------
create or replace function public.can_manage_appearance()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.is_active_user(), false)
     and (
       coalesce(public.is_admin(), false)
       or coalesce(public.has_permission('settings.manage'), false)
     );
$$;

revoke all on function public.can_manage_appearance() from public, anon;
grant execute on function public.can_manage_appearance() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3) Atomic write RPC — the ONLY sanctioned writer for the appearance group
-- ---------------------------------------------------------------------------
-- Contract:
--   p_settings             jsonb object whose keys must be a subset of the
--                          whitelist below; values are validated per key.
--   p_expected_updated_at  optimistic lock against max(updated_at) of the
--                          managed keys; mismatch raises LOC02.
-- Returns the full post-write snapshot:
--   { "default_locale", "default_direction", "default_theme",
--     "default_timezone", "weekend_days", "updated_at" }
-- Errors: 42501 (capability), 22023 (payload/value/timezone), LOC02 (conflict).
create or replace function public.admin_update_appearance_settings(
  p_settings jsonb,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_whitelist constant text[] := array[
    'appearance.default_locale',
    'appearance.default_direction',
    'appearance.default_theme',
    'appearance.default_timezone',
    'appearance.weekend_days'
  ];
  v_key text;
  v_new jsonb;
  v_current jsonb;
  v_locale text := null;
  v_direction text := null;
  v_theme text := null;
  v_timezone text := null;
  v_weekend integer[] := null;
  v_element jsonb;
  v_number numeric;
  v_stored_locale text;
  v_stored_direction text;
  v_final_locale text;
  v_final_direction text;
  v_max_updated_at timestamptz;
  v_changed jsonb := '{}'::jsonb;
begin
  -- (1) Capability gate: active user holding `*` or `settings.manage`.
  if v_actor is null
     or not public.is_active_user()
     or not (
       coalesce(public.is_admin(), false)
       or coalesce(public.has_permission('settings.manage'), false)
     ) then
    raise exception 'admin_update_appearance_settings: settings.manage capability required'
      using errcode = '42501';
  end if;

  -- (2) Payload shape + whitelist: no foreign keys ever reach the table.
  if p_settings is null
     or jsonb_typeof(p_settings) <> 'object'
     or p_settings = '{}'::jsonb then
    raise exception 'admin_update_appearance_settings: payload must be a non-empty jsonb object'
      using errcode = '22023';
  end if;

  for v_key in select jsonb_object_keys(p_settings) loop
    if not (v_key = any (v_whitelist)) then
      raise exception 'admin_update_appearance_settings: key "%" is not allowed', v_key
        using errcode = '22023';
    end if;
  end loop;

  -- (3) Lock the managed rows and snapshot the group version.
  perform 1
    from public.app_settings
   where key = any (v_whitelist)
   for update;

  select coalesce(max(updated_at), to_timestamp(0))
    into v_max_updated_at
    from public.app_settings
   where key = any (v_whitelist);

  if p_expected_updated_at is not null and v_max_updated_at <> p_expected_updated_at then
    raise exception 'admin_update_appearance_settings: version-conflict'
      using errcode = 'LOC02';
  end if;

  -- (4) Per-key validation, producing normalized candidate values.
  if p_settings ? 'appearance.default_locale' then
    if jsonb_typeof(p_settings -> 'appearance.default_locale') <> 'string' then
      raise exception 'admin_update_appearance_settings: default_locale must be a string'
        using errcode = '22023';
    end if;
    v_locale := p_settings ->> 'appearance.default_locale';
    if v_locale not in ('ar', 'en') then
      raise exception 'admin_update_appearance_settings: invalid default_locale "%"', v_locale
        using errcode = '22023';
    end if;
  end if;

  if p_settings ? 'appearance.default_direction' then
    if jsonb_typeof(p_settings -> 'appearance.default_direction') <> 'string' then
      raise exception 'admin_update_appearance_settings: default_direction must be a string'
        using errcode = '22023';
    end if;
    v_direction := p_settings ->> 'appearance.default_direction';
    if v_direction not in ('rtl', 'ltr') then
      raise exception 'admin_update_appearance_settings: invalid default_direction "%"', v_direction
        using errcode = '22023';
    end if;
  end if;

  if p_settings ? 'appearance.default_theme' then
    if jsonb_typeof(p_settings -> 'appearance.default_theme') <> 'string' then
      raise exception 'admin_update_appearance_settings: default_theme must be a string'
        using errcode = '22023';
    end if;
    v_theme := p_settings ->> 'appearance.default_theme';
    if v_theme not in ('light', 'dark', 'system') then
      raise exception 'admin_update_appearance_settings: invalid default_theme "%"', v_theme
        using errcode = '22023';
    end if;
  end if;

  if p_settings ? 'appearance.default_timezone' then
    if jsonb_typeof(p_settings -> 'appearance.default_timezone') <> 'string' then
      raise exception 'admin_update_appearance_settings: default_timezone must be a string'
        using errcode = '22023';
    end if;
    v_timezone := btrim(p_settings ->> 'appearance.default_timezone');
    if v_timezone = '' then
      raise exception 'admin_update_appearance_settings: default_timezone must not be empty'
        using errcode = '22023';
    end if;
    -- Validation by the engine itself: no hand-maintained zone list.
    begin
      perform (clock_timestamp() at time zone v_timezone);
    exception when others then
      raise exception 'admin_update_appearance_settings: invalid IANA time zone "%"', v_timezone
        using errcode = '22023';
    end;
  end if;

  if p_settings ? 'appearance.weekend_days' then
    if jsonb_typeof(p_settings -> 'appearance.weekend_days') <> 'array' then
      raise exception 'admin_update_appearance_settings: weekend_days must be an array'
        using errcode = '22023';
    end if;
    v_weekend := array[]::integer[];
    for v_element in select * from jsonb_array_elements(p_settings -> 'appearance.weekend_days') loop
      if jsonb_typeof(v_element) <> 'number' then
        raise exception 'admin_update_appearance_settings: weekend_days entries must be integers'
          using errcode = '22023';
      end if;
      v_number := (v_element #>> '{}')::numeric;
      if v_number <> floor(v_number) or v_number < 1 or v_number > 7 then
        raise exception 'admin_update_appearance_settings: weekend day out of range (isodow 1..7)'
          using errcode = '22023';
      end if;
      if v_number::integer = any (v_weekend) then
        raise exception 'admin_update_appearance_settings: duplicate weekend day %', v_number
          using errcode = '22023';
      end if;
      v_weekend := array_append(v_weekend, v_number::integer);
    end loop;
    if cardinality(v_weekend) not between 1 and 3 then
      raise exception 'admin_update_appearance_settings: weekend_days must contain 1..3 days'
        using errcode = '22023';
    end if;
    select array_agg(day order by day) into v_weekend from unnest(v_weekend) as day;
  end if;

  -- (5) Server-enforced locale/direction consistency on the resulting pair.
  select value #>> '{}'
    into v_stored_locale
    from public.app_settings
   where key = 'appearance.default_locale';

  select value #>> '{}'
    into v_stored_direction
    from public.app_settings
   where key = 'appearance.default_direction';

  v_final_locale := coalesce(v_locale, v_stored_locale, 'ar');
  v_final_direction := coalesce(v_direction, v_stored_direction, 'rtl');

  if (v_final_locale = 'ar' and v_final_direction <> 'rtl')
     or (v_final_locale = 'en' and v_final_direction <> 'ltr') then
    raise exception 'admin_update_appearance_settings: locale/direction pair "%" / "%" is inconsistent',
      v_final_locale, v_final_direction
      using errcode = '22023';
  end if;

  -- (6) Diff-only upserts; identical values are never rewritten.
  for v_key in select unnest(v_whitelist) loop
    if not (p_settings ? v_key) then
      continue;
    end if;

    v_new := case v_key
      when 'appearance.default_locale' then to_jsonb(v_locale)
      when 'appearance.default_direction' then to_jsonb(v_direction)
      when 'appearance.default_theme' then to_jsonb(v_theme)
      when 'appearance.default_timezone' then to_jsonb(v_timezone)
      when 'appearance.weekend_days' then to_jsonb(v_weekend)
    end;

    select s.value
      into v_current
      from public.app_settings as s
     where s.key = v_key;

    if v_current is not distinct from v_new then
      continue;
    end if;

    insert into public.app_settings (key, group_slug, value, is_public, updated_by)
    values (v_key, 'appearance', v_new, true, v_actor)
    on conflict (key) do update
      set value = excluded.value,
          is_public = excluded.is_public,
          updated_by = excluded.updated_by;

    v_changed := jsonb_set(
      v_changed,
      array[replace(v_key, 'appearance.', '')],
      jsonb_build_object('old', coalesce(v_current, 'null'::jsonb), 'new', v_new)
    );
  end loop;

  -- (7) One audit row per transaction, carrying the per-key diff.
  if v_changed <> '{}'::jsonb then
    insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (
      v_actor,
      'settings.updated',
      'app_settings',
      'appearance',
      jsonb_build_object('group', 'appearance', 'changed', v_changed)
    );
  end if;

  -- (8) Full post-write snapshot for the caller's cache + boot snapshot.
  select coalesce(max(updated_at), to_timestamp(0))
    into v_max_updated_at
    from public.app_settings
   where key = any (v_whitelist);

  return jsonb_build_object(
    'default_locale', (
      select value #>> '{}' from public.app_settings where key = 'appearance.default_locale'
    ),
    'default_direction', (
      select value #>> '{}' from public.app_settings where key = 'appearance.default_direction'
    ),
    'default_theme', (
      select value #>> '{}' from public.app_settings where key = 'appearance.default_theme'
    ),
    'default_timezone', (
      select value #>> '{}' from public.app_settings where key = 'appearance.default_timezone'
    ),
    'weekend_days', coalesce((
      select value from public.app_settings where key = 'appearance.weekend_days'
    ), '[6,7]'::jsonb),
    'updated_at', v_max_updated_at
  );
end;
$$;

revoke all on function public.admin_update_appearance_settings(jsonb, timestamptz)
  from public, anon, service_role;
grant execute on function public.admin_update_appearance_settings(jsonb, timestamptz)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 4) Backup scheduler reads the project time zone + weekend profile
-- ---------------------------------------------------------------------------
create or replace function public.generate_scheduled_backup_requests()
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_settings_enabled boolean;
  v_interval_working_days integer;
  v_last_success_at timestamptz;
  v_last_success_date date;
  v_today_local date;
  v_working_days_elapsed integer;
  v_request_id uuid;
  v_now timestamptz;
  v_timezone text := 'UTC';
  v_timezone_fallback boolean := false;
  v_weekend_days integer[] := array[6, 7];
  v_weekend_value jsonb;
  v_weekend_candidate integer[];
  v_element jsonb;
  v_number numeric;
begin
  -- Shares the existing manual-request/worker gate, so concurrent cron runs,
  -- manual requests and job claims cannot race the one-active-request invariant.
  perform pg_advisory_xact_lock(hashtextextended('backup_request_gate', 0));
  v_now := clock_timestamp();

  select bs.enabled, bs.interval_working_days
    into v_settings_enabled, v_interval_working_days
    from public.backup_settings as bs
   where bs.singleton
   for share;

  if not found or not v_settings_enabled then
    return null;
  end if;

  -- Idempotence: an outstanding manual OR automatic request owns the single
  -- active slot. The unique partial index remains the final database guard.
  if exists (
    select 1
      from public.backup_logs as b
     where b.status in ('queued', 'running')
  ) then
    return null;
  end if;

  -- Project time zone: dynamic setting with a loud-but-safe UTC fallback.
  begin
    select nullif(btrim(coalesce(s.value #>> '{}', '')), '')
      into v_timezone
      from public.app_settings as s
     where s.key = 'appearance.default_timezone';

    if v_timezone is null then
      v_timezone := 'UTC';
      v_timezone_fallback := true;
    else
      -- Engine-level validity probe; unknown zones raise below.
      perform (v_now at time zone v_timezone);
    end if;
  exception when others then
    v_timezone := 'UTC';
    v_timezone_fallback := true;
  end;

  -- Weekend profile: isodow days excluded from the working-day counter.
  begin
    select s.value
      into v_weekend_value
      from public.app_settings as s
     where s.key = 'appearance.weekend_days';

    if v_weekend_value is null or jsonb_typeof(v_weekend_value) <> 'array' then
      raise exception 'weekend profile missing';
    end if;

    v_weekend_candidate := array[]::integer[];
    for v_element in select * from jsonb_array_elements(v_weekend_value) loop
      if jsonb_typeof(v_element) <> 'number' then
        raise exception 'non-numeric weekend day';
      end if;
      v_number := (v_element #>> '{}')::numeric;
      if v_number <> floor(v_number) or v_number < 1 or v_number > 7 then
        raise exception 'weekend day out of range';
      end if;
      if v_number::integer = any (v_weekend_candidate) then
        raise exception 'duplicate weekend day';
      end if;
      v_weekend_candidate := array_append(v_weekend_candidate, v_number::integer);
    end loop;

    if cardinality(v_weekend_candidate) not between 1 and 3 then
      raise exception 'weekend profile length out of range';
    end if;

    v_weekend_days := v_weekend_candidate;
  exception when others then
    -- Preserve historical behaviour (Saturday + Sunday) when corrupt.
    v_weekend_days := array[6, 7];
  end;

  select coalesce(b.finished_at, b.requested_at)
    into v_last_success_at
    from public.backup_logs as b
   where b.status = 'completed'
   order by coalesce(b.finished_at, b.requested_at) desc, b.requested_at desc, b.id desc
   limit 1;

  v_today_local := (v_now at time zone v_timezone)::date;

  -- With no successful backup in the ledger, the first scheduled run is due
  -- immediately; subsequent runs use finished_at (or requested_at for legacy
  -- completed rows that predate the finished_at telemetry column).
  if v_last_success_at is null then
    v_working_days_elapsed := v_interval_working_days;
  else
    v_last_success_date := (v_last_success_at at time zone v_timezone)::date;

    select count(*)::integer
      into v_working_days_elapsed
      from generate_series(
             v_last_success_date + 1,
             v_today_local,
             interval '1 day'
           ) as day_series(work_day)
     where not (extract(isodow from day_series.work_day)::integer = any (v_weekend_days));
  end if;

  if v_working_days_elapsed < v_interval_working_days then
    return null;
  end if;

  insert into public.backup_logs (backup_type, status, requested_by)
  values ('automatic', 'queued', null)
  returning id into v_request_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    null,
    'backup.created'::public.audit_action,
    'backup',
    v_request_id::text,
    jsonb_build_object(
      'backup_type', 'automatic',
      'status', 'queued',
      'source', 'pg_cron',
      'interval_working_days', v_interval_working_days,
      'working_days_elapsed', v_working_days_elapsed,
      'timezone', v_timezone,
      'timezone_fallback', v_timezone_fallback,
      'weekend_days', to_jsonb(v_weekend_days)
    )
  );

  return v_request_id;
end;
$$;

revoke all on function public.generate_scheduled_backup_requests()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5) Hourly idempotent check instead of a fixed Paris-time slot
-- ---------------------------------------------------------------------------
-- A static UTC slot can never mean "01:00 local" for an arbitrary project
-- time zone, so the generator itself is the gate: it counts working days in
-- the configured zone and enqueues only when due. Advisory lock + single
-- active slot + counter reset after success keep hourly calls idempotent.
do $cron_job$
declare
  v_job_id bigint;
  v_command constant text := $command$select public.generate_scheduled_backup_requests();$command$;
begin
  for v_job_id in
    select j.jobid
      from cron.job as j
     where j.jobname in (
       'generate-scheduled-backup-requests-europe-paris-0100',
       'generate-scheduled-backup-requests-hourly'
     )
       and j.database = current_database()
       and j.username = current_user
  loop
    perform cron.unschedule(v_job_id);
  end loop;

  perform cron.schedule(
    'generate-scheduled-backup-requests-hourly',
    '0 * * * *',
    v_command
  );
end;
$cron_job$;

-- ---------------------------------------------------------------------------
-- 6) Close every direct write path on app_settings
-- ---------------------------------------------------------------------------
-- Reading stays: the public-keys policy serves anonymous visitors (login
-- screen) and the admin-read policy stays for operators. Writing exists only
-- through admin_update_appearance_settings (owner-executed) and service_role
-- operational tooling.
drop policy if exists "Admins manage settings" on public.app_settings;

revoke insert, update, delete, truncate
  on table public.app_settings
  from authenticated, anon;

-- ---------------------------------------------------------------------------
-- 7) Realtime publication guard (invalidation signal only)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'app_settings'
  ) then
    alter publication supabase_realtime add table public.app_settings;
  end if;
end;
$$;
