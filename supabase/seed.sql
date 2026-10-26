-- Local/demo seed data: workspaces and grouped application settings.
-- Runs on `supabase db reset` (local) via `[db.seed]` in supabase/config.toml.
--
-- ⚠️  SECURITY BASELINE IS *NOT* SEEDED HERE ANY MORE.
--
-- The four legacy system roles, permission catalogue, and original
-- role→permission matrix are delivered by
-- `supabase/migrations/20261010130000_seed_rbac_baseline.sql`; the protected
-- `owner` role and its explicit all-permissions grant are delivered by
-- `supabase/migrations/20261016120000_add_owner_role_and_grant_all_permissions.sql`.
--
-- That move is deliberate and load-bearing. `[db.seed]` only runs on
-- `supabase db reset`; the production path used by
-- .github/workflows/supabase-migration.yml is `supabase db push --linked`, which
-- never applies seed.sql. If the baseline lived only here, a fresh cloud
-- project would have an EMPTY roles/permissions table and the first-signup
-- trigger would fail closed rather than assign a protected role.
--
-- Do NOT re-add role, permission or role_permissions rows here: that would
-- recreate a second source of truth for security-critical reference data, and
-- the copy in this file would silently never reach production again.
--
-- ⚠️  NO DEFAULT ACCOUNTS.
--
-- This file must never insert into `auth.users`, and must never assign a role
-- to a hard-coded email address. A previous revision auto-granted `super_admin`
-- to a fixed demo address; that block was removed because a well-known address
-- that is auto-elevated is exactly the account an attacker would try to
-- register. The first Auth signup on a project that has never had an Auth user
-- receives the protected `owner` role and every permission through the
-- database-owned Auth trigger. Existing `super_admin` remains protected with
-- its original wildcard grant. Subsequent signups receive `viewer`; user
-- metadata is never used for role assignment.

-- ---------------------------------------------------------------------------
-- Workspaces referenced by the sidebar tree
-- ---------------------------------------------------------------------------
insert into public.workspaces (slug, name_ar, name_en, description, sort_order)
values
  ('workspace-1', 'مساحة عمل 1', 'Workspace 1', 'مساحة عمل أولى جاهزة للتهيئة', 1),
  ('workspace-2', 'مساحة عمل 2', 'Workspace 2', 'مساحة عمل ثانية جاهزة للتهيئة', 2),
  ('workspace-3', 'مساحة عمل 3', 'Workspace 3', 'مساحة عمل ثالثة جاهزة للتهيئة', 3)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- Application settings grouped for the settings screens
-- ---------------------------------------------------------------------------
insert into public.app_settings (key, group_slug, value, is_public)
values
  ('general.system_name', 'general', to_jsonb('نظام الإدارة'::text), true),
  ('general.support_email', 'general', to_jsonb('support@example.com'::text), false),
  ('general.maintenance_mode', 'general', to_jsonb(false), false),
  ('appearance.default_theme', 'appearance', to_jsonb('system'::text), true),
  ('appearance.default_locale', 'appearance', to_jsonb('ar'::text), true),
  ('appearance.default_direction', 'appearance', to_jsonb('rtl'::text), true),
  ('appearance.default_timezone', 'appearance', to_jsonb('Europe/Paris'::text), true),
  ('appearance.weekend_days', 'appearance', '[6,7]'::jsonb, true),
  ('appearance.accent_color', 'appearance', to_jsonb('indigo'::text), true),
  ('appearance.sidebar_state', 'appearance', to_jsonb('expanded'::text), false),
  ('notifications.enabled', 'notifications', to_jsonb(true), true),
  ('notifications.channels', 'notifications', to_jsonb('["in_app","email"]'::jsonb), false),
  ('notifications.retention_days', 'notifications', to_jsonb(30), false)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Guard: the security baseline must already be in place when this file runs.
--
-- On `supabase db reset` the migrations always run first, so this can only fail
-- if someone deletes or reorders the RBAC baseline migration. Failing here is
-- far cheaper than discovering an un-bootstrapable project later.
-- ---------------------------------------------------------------------------
do $assert_baseline_present$
declare
  v_super_admin_flagged integer;
  v_super_admin_wildcard integer;
  v_owner_flagged integer;
  v_owner_missing_permissions integer;
begin
  select count(*) into v_super_admin_flagged
    from public.roles
   where slug = 'super_admin' and is_super_admin is true;

  select count(*) into v_super_admin_wildcard
    from public.roles r
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
   where r.slug = 'super_admin' and r.is_super_admin and p.slug = '*';

  select count(*) into v_owner_flagged
    from public.roles
   where slug = 'owner' and is_super_admin is true;

  select count(*) into v_owner_missing_permissions
    from public.permissions p
   where not exists (
     select 1
       from public.roles r
       join public.role_permissions rp on rp.role_id = r.id
      where r.slug = 'owner'
        and r.is_super_admin
        and rp.permission_id = p.id
   );

  if v_super_admin_flagged <> 1 or v_super_admin_wildcard <> 1
     or v_owner_flagged <> 1 or v_owner_missing_permissions <> 0 then
    raise exception
      'supabase/seed.sql requires both RBAC migrations to be applied '
      '(super_admin_flagged=%/1 super_admin_wildcard=%/1 owner_flagged=%/1 owner_missing_permissions=%/0).',
      v_super_admin_flagged, v_super_admin_wildcard, v_owner_flagged, v_owner_missing_permissions;
  end if;
end
$assert_baseline_present$;



-- ---------------------------------------------------------------------------
-- Demo stations & warehouses (Project Settings → Stations & Warehouses).
--
-- Local/e2e only: `supabase db push --linked` never applies this file, so
-- production stays empty until real stations are entered through the UI.
--
-- `code` is deliberately NOT supplied. The columns default to
-- public.next_station_code() / public.next_warehouse_code(), which advance
-- public.station_code_seq / public.warehouse_code_seq. Writing explicit codes
-- here would leave the sequences behind, and the first row created through the
-- UI would then mint a code that already exists and fail the unique index.
-- ---------------------------------------------------------------------------
do $seed_stations_and_warehouses$
declare
  v_existing integer;
begin
  select count(*)::integer into v_existing from public.stations;
  if v_existing > 0 then
    return;
  end if;

  with seeded_stations as (
    insert into public.stations (name, is_active)
    values
      ('المحطة الرئيسية', true),
      ('محطة الصيانة', true),
      ('محطة الوقود الشمالية', false)
    returning id, name
  )
  insert into public.warehouses (station_id, name, is_active)
  select station.id, demo.name, demo.is_active
    from seeded_stations as station
    join (
      values
        ('المحطة الرئيسية', 'مخزن المواد الخام', true),
        ('المحطة الرئيسية', 'مخزن قطع الغيار', true),
        ('المحطة الرئيسية', 'مخزن المرتجعات', false),
        ('محطة الصيانة', 'مخزن العدد والأدوات', true)
    ) as demo (station_name, name, is_active)
      on demo.station_name = station.name;
end;
$seed_stations_and_warehouses$;


-- ---------------------------------------------------------------------------
-- Demo classification tree (Project Settings → Classifications).
--
-- Local/e2e only, exactly like the stations seed: `supabase db push --linked`
-- never applies this file, so production stays empty until real categories are
-- entered through the UI.
--
-- Neither `code`, `level` nor `is_leaf` is supplied. `code` defaults to
-- public.next_classification_code() (so CLS-001… stay in step with
-- classification_code_seq and the first UI-created row never collides), while
-- `level` and `is_leaf` are derived by the classifications triggers from
-- `parent_id`. Writing any of the three here would either desynchronize the
-- sequence or be overwritten by the trigger.
-- ---------------------------------------------------------------------------
do $seed_classifications$
declare
  v_existing integer;
  v_materials uuid;
  v_services uuid;
  v_raw_materials uuid;
  v_operating_supplies uuid;
  v_maintenance uuid;
begin
  select count(*)::integer into v_existing from public.classifications;
  if v_existing > 0 then
    return;
  end if;

  -- Level 1 — categories
  insert into public.classifications (name, is_active)
  values ('المواد والمستلزمات', true)
  returning id into v_materials;

  insert into public.classifications (name, is_active)
  values ('الخدمات', true)
  returning id into v_services;

  -- Level 2 — groups (the first category carries two, as the acceptance
  -- criterion asks; the second keeps one, so empty-state and disabled-node
  -- rendering can both be inspected)
  insert into public.classifications (parent_id, name, is_active)
  values (v_materials, 'المواد الخام', true)
  returning id into v_raw_materials;

  insert into public.classifications (parent_id, name, is_active)
  values (v_materials, 'مستلزمات التشغيل', true)
  returning id into v_operating_supplies;

  insert into public.classifications (parent_id, name, is_active)
  values (v_services, 'خدمات الصيانة', false)
  returning id into v_maintenance;

  -- Level 3 — items (leaves; `is_leaf` stays true until a child is added)
  insert into public.classifications (parent_id, name, is_active)
  values
    (v_raw_materials, 'حديد وصلب', true),
    (v_raw_materials, 'أخشاب', true),
    (v_raw_materials, 'بلاستيك ومطاط', false),
    (v_operating_supplies, 'زيوت وشحوم', true),
    (v_operating_supplies, 'قطع غيار', true),
    (v_maintenance, 'صيانة دورية', true),
    (v_maintenance, 'إصلاح أعطال', true);
end;
$seed_classifications$;


-- ---------------------------------------------------------------------------
-- Demo parties (Project Settings → جهات الوارد وأغراض الصرف): two inbound
-- parties and one outbound party, plus a sister-company tree with two branches.
--
-- Local/e2e only, exactly like the stations and classifications seeds:
-- `supabase db push --linked` never applies this file, so production stays
-- empty until real parties are entered through the UI.
--
-- `code` is deliberately NOT supplied. `parties_before_write` mints it from the
-- branch's own sequence, so the rows land as IN-001 / IN-002 / OUT-001 and each
-- sequence stays in step with the rows it numbered — writing explicit codes
-- here would make the first UI-created party mint a code that already exists.
-- A party is a name and a branch: there is no tax number, address, phone,
-- email, credit limit or payment term to seed (those columns were retired in
-- 20261109000000).
-- The sister-company codes (SIS-001, SIS-001-01, SIS-001-02) are minted the
-- same way by `sister_companies_before_write`.
-- ---------------------------------------------------------------------------
do $seed_parties$
declare
  v_existing integer;
  v_sister uuid;
begin
  select count(*)::integer into v_existing from public.parties;
  if v_existing = 0 then
    insert into public.parties (branch, name, is_active)
    values
      ('inbound', 'شركة النيل للتوريدات الصناعية', true),
      ('inbound', 'Nile Trading GmbH', true),
      ('outbound', 'مؤسسة الأفق للتجارة والتوزيع', true);
  end if;

  select count(*)::integer into v_existing from public.sister_companies;
  if v_existing = 0 then
    insert into public.sister_companies (name, is_active)
    values ('الشركة المتحدة للخدمات اللوجستية', true)
    returning id into v_sister;

    insert into public.sister_companies (parent_id, name, is_active)
    values
      (v_sister, 'المتحدة للنقل الثقيل', true),
      (v_sister, 'المتحدة للتخليص الجمركي', false);
  end if;
end;
$seed_parties$;
