-- =============================================================================
-- test-account-teardown.sql
-- حذف أثر الاختبار الذي أنشأه test-account-bootstrap.sql.
--
-- ⚠ هذا الملف **ليس ترحيلًا**: لا تضعه في supabase/migrations/.
-- ⚠ لا تشغّله قبل التأكد من أنك على قاعدة الاختبار لا الإنتاج.
--
-- ما يُحذف:
--   • الحسابات الثلاثة وحسابات qa.* الأخرى من auth.users
--     (يتتالى الحذف تلقائيًا إلى public.profiles ثم public.user_roles).
--   • دور الاختبار qa_notifications_editor
--     (يتتالى الحذف إلى public.role_permissions).
--
-- ما **لا** يُحذف (عن قصد):
--   • سطور public.audit_logs — سجل التدقيق لا يُنتقص.
--   • الأدوار النظامية والأدوار المبذورة (super_admin/admin/editor/viewer).
-- =============================================================================


-- -----------------------------------------------------------------------------
-- §1 · معاينة قبل الحذف (شغّل هذا أولًا وتأكد من النطاق)
-- -----------------------------------------------------------------------------
select
  u.id,
  u.email,
  p.status,
  coalesce(array_agg(distinct r.slug) filter (where r.slug is not null), '{}') as roles
from auth.users u
left join public.profiles p      on p.id = u.id
left join public.user_roles ur   on ur.user_id = u.id
left join public.roles r         on r.id = ur.role_id
where u.email ilike 'qa.%@%'     -- عدّل النمط إن غيّرت النطاق في ملف الإعداد
group by u.id, u.email, p.status
order by u.email;


-- -----------------------------------------------------------------------------
-- §2 · فكّ ارتباط الأدوار أولًا (ترتيب أوضح، والحذف بالتتالي يكفي بدونه)
-- -----------------------------------------------------------------------------
delete from public.user_roles ur
using auth.users u
where ur.user_id = u.id
  and u.email ilike 'qa.%@%';


-- -----------------------------------------------------------------------------
-- §3 · حذف دور الاختبار
--      مؤثر guard_role_permissions_writes يسمح بالحذف فقط حين
--      current_user ∈ (postgres, supabase_admin) — وهو حال جلسة محرّر SQL.
-- -----------------------------------------------------------------------------
delete from public.roles r
where r.slug = 'qa_notifications_editor'
  and r.is_system = false;


-- -----------------------------------------------------------------------------
-- §4 · حذف الحسابات (يُتالي الملف الشخصي، وروابط الأدوار إن بقي منها شيء)
-- -----------------------------------------------------------------------------
delete from auth.users u
where u.email ilike 'qa.%@%';


-- -----------------------------------------------------------------------------
-- §5 · تحقّق: لا حسابات qa.* ولا دور اختبار، والأدوار النظامية سليمة
-- -----------------------------------------------------------------------------
select
  (select count(*) from auth.users u where u.email ilike 'qa.%@%')          as remaining_qa_users,
  (select count(*) from public.roles r where r.slug like 'qa!_%' escape '!') as remaining_qa_roles,
  (select count(*) from public.roles r)                                      as total_roles,
  (select count(*) from public.permissions p)                                as total_permissions,
  (
    select count(distinct pr.id)
    from public.profiles pr
    join public.user_roles ur on ur.user_id = pr.id
    join public.roles r       on r.id = ur.role_id
    join public.role_permissions rp on rp.role_id = r.id
    join public.permissions perm    on perm.id = rp.permission_id
    where pr.status = 'active' and perm.slug = '*'
  )                                                                          as active_star_admins;
-- المتوقع: remaining_qa_users = 0 · remaining_qa_roles = 0 · active_star_admins ≥ 1
