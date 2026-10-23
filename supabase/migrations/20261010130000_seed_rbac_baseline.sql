-- =============================================================================
-- 20261010130000_seed_rbac_baseline.sql
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- Until now the four baseline roles and their permission matrix existed ONLY in
-- supabase/seed.sql. Per supabase/config.toml, `[db.seed]` is applied by
-- `supabase db reset` (local) and is NOT part of `supabase db push`, which is
-- what .github/workflows/supabase-migration.yml runs against a cloud project.
--
-- The result on a fresh cloud project was:
--
--     roles                     -> 0 rows
--     permissions               -> 0 rows
--     roles.is_super_admin      -> column present, but no super_admin row
--     super_admin '*' grant     -> absent
--
-- so BOTH first-admin paths aborted with
-- "Bootstrap refused: seed the super_admin role and its * permission first."
--
-- Verified by replaying every migration in filename order against a clean
-- PostgreSQL instance: 16/16 migrations applied cleanly, yet the database was
-- not bootstrap-ready. The RBAC baseline is therefore part of the schema
-- contract and belongs in a migration, not in developer seed data.
--
-- PROPERTIES
-- ----------
--   * Idempotent: every statement is `on conflict do nothing` or a guarded
--     UPDATE, so replaying it — or running it against a project that was
--     already seeded — changes nothing.
--   * Never overwrites: existing role/permission display names, descriptions
--     and custom grants are left untouched. Only rows that are missing are
--     inserted, and only an unflagged `super_admin` is flagged.
--   * Owner-only: the protected flag is written as postgres/supabase_admin,
--     exactly like 20261005120000_harden_super_admin.sql already does, so the
--     guard_super_admin_role_writes() trigger permits it and the one-super-admin
--     partial unique index still holds.
--   * Grants no access: this creates the RBAC vocabulary only. It assigns
--     super_admin to NO user. The first administrator is still granted solely
--     through scripts/sql/grant-first-super-admin.sql or
--     public.bootstrap_first_super_admin().
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1) Baseline roles
-- ---------------------------------------------------------------------------
insert into public.roles (slug, name_ar, name_en, description, is_system)
values
  ('super_admin', 'مدير النظام', 'Super Administrator', 'صلاحيات كاملة على جميع وحدات النظام', true),
  ('admin', 'مدير عام', 'Administrator', 'إدارة المستخدمين والإعدادات دون الوصول للاحتياطي', true),
  ('editor', 'محرر', 'Editor', 'إدارة المحتوى ومساحات العمل', true),
  ('viewer', 'مشاهد', 'Viewer', 'اطلاع فقط على التقارير واللوحات', true)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- 2) Baseline permissions ('*' grants everything through public.has_permission)
-- ---------------------------------------------------------------------------
insert into public.permissions (slug, module, name_ar, name_en, description)
values
  ('*', 'system', 'كل الصلاحيات', 'All permissions', 'صلاحية شاملة تمنحها الأدوار النظامية'),
  ('dashboard.view', 'dashboard', 'عرض الشاشة الرئيسية', 'View dashboard', 'الاطلاع على لوحة المؤشرات'),
  ('workspace.1.access', 'workspace', 'الوصول لمساحة العمل 1', 'Access workspace 1', 'فتح أول مساحة عمل'),
  ('workspace.2.access', 'workspace', 'الوصول لمساحة العمل 2', 'Access workspace 2', 'فتح ثانية مساحة عمل'),
  ('workspace.3.access', 'workspace', 'الوصول لمساحة العمل 3', 'Access workspace 3', 'فتح ثالثة مساحة عمل'),
  ('users.manage', 'system', 'ضبط المستخدمين', 'Manage users', 'إضافة وتعديل وتعطيل المستخدمين'),
  ('roles.manage', 'system', 'الصلاحيات والأدوار', 'Manage roles', 'تحرير الأدوار وربط الصلاحيات'),
  ('backup.manage', 'system', 'النسخ الاحتياطي', 'Manage backups', 'إنشاء واستعادة النسخ الاحتياطية'),
  ('support.manage', 'system', 'الدعم الفني', 'Manage support', 'متابعة تذاكر الدعم الفني'),
  ('settings.manage', 'app', 'الإعدادات الإدارية العامة', 'Manage general settings', 'تعديل إعدادات النظام العامة'),
  ('appearance.manage', 'app', 'التحكم بالمظهر', 'Manage appearance', 'قالب ووضع العرض الافتراضي'),
  ('notifications.manage', 'app', 'التنبيهات', 'Manage notifications', 'قواعد وقنوات الإشعارات')
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- 3) Role -> permission matrix
-- ---------------------------------------------------------------------------
insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.slug = '*'
where r.slug = 'super_admin'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.slug in (
  'dashboard.view',
  'workspace.1.access', 'workspace.2.access', 'workspace.3.access',
  'users.manage', 'roles.manage', 'backup.manage', 'support.manage',
  'settings.manage', 'appearance.manage', 'notifications.manage'
)
where r.slug = 'admin'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.slug in (
  'dashboard.view',
  'workspace.1.access', 'workspace.2.access'
)
where r.slug = 'editor'
on conflict do nothing;

insert into public.role_permissions (role_id, permission_id)
select r.id, p.id
from public.roles r
join public.permissions p on p.slug = 'dashboard.view'
where r.slug = 'viewer'
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 4) Protect the super_admin role
--
-- Runs last on purpose: 20261005120000 already performed the same UPDATE, but on
-- a cloud project the roles table was still empty at that point, so the flag was
-- never actually set. Repeating it here — after the row is guaranteed to exist —
-- is what makes `r.is_super_admin is true` hold on every code path.
-- ---------------------------------------------------------------------------
update public.roles
   set is_super_admin = true
 where slug = 'super_admin'
   and is_super_admin is distinct from true;

-- ---------------------------------------------------------------------------
-- 5) Fail the migration loudly if the baseline did not land
--
-- Without this, a future change that silently breaks the baseline would again
-- produce a project where no first administrator can be granted.
-- ---------------------------------------------------------------------------
do $verify_rbac_baseline$
declare
  v_roles integer;
  v_permissions integer;
  v_flagged integer;
  v_wildcard integer;
begin
  select count(*) into v_roles
    from public.roles
   where slug in ('super_admin', 'admin', 'editor', 'viewer');

  select count(*) into v_permissions
    from public.permissions
   where slug in (
     '*', 'dashboard.view',
     'workspace.1.access', 'workspace.2.access', 'workspace.3.access',
     'users.manage', 'roles.manage', 'backup.manage', 'support.manage',
     'settings.manage', 'appearance.manage', 'notifications.manage'
   );

  select count(*) into v_flagged
    from public.roles
   where slug = 'super_admin' and is_super_admin is true;

  select count(*) into v_wildcard
    from public.roles r
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions p on p.id = rp.permission_id
   where r.slug = 'super_admin' and r.is_super_admin and p.slug = '*';

  if v_roles <> 4 or v_permissions <> 12 or v_flagged <> 1 or v_wildcard <> 1 then
    raise exception
      'RBAC baseline incomplete: roles=%/4 permissions=%/12 flagged=%/1 wildcard=%/1',
      v_roles, v_permissions, v_flagged, v_wildcard;
  end if;
end
$verify_rbac_baseline$;

notify pgrst, 'reload schema';
