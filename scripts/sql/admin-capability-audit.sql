-- =============================================================================
-- admin-capability-audit.sql
-- تشخيص قدرات حساب بعينه على شاشة «الإشعارات وقوالب الرسائل»
-- (/settings/app/notifications) وما يتصل بها من RPC.
--
-- ملاحظات تشغيلية قبل أي شيء:
--   1) هذا الملف **ليس ترحيلًا (migration)** ولا يجوز وضعه في supabase/migrations/
--      لأن سير العمل يطبّق كل ما في ذلك المجلد على قاعدة الإنتاج.
--   2) كل الاستعلامات **قراءة فقط** عدا القسم 6 الذي يحاكي جلسة مستخدم داخل
--      معاملة واحدة تتراجع بنهايتها (set_config بصيغة local).
--   3) استبدل البريد 'qa.admin@example.com' ببريد الحساب المراد فحصه في كل
--      القسم 0 وما يليه (Find & Replace مرة واحدة تكفي).
--   4) لماذا لا يعتمد الملف على auth.uid()؟ لأن محرّر SQL في Supabase يعمل
--      بجلسة postgres بلا JWT، لذا auth.uid() و auth.jwt() يرجعان NULL دائمًا.
--      التشخيص هنا يجري **بالاسم/البريد** صراحةً، والقسم 6 يحاكي الجلسة عند اللزوم.
--
-- المرجع: docs/consultations/2026-10-03-admin-capability-verification-runbook.md
-- =============================================================================


-- -----------------------------------------------------------------------------
-- §0 · سياق الجلسة: من أنا داخل هذا المحرر؟ (توقع NULL في محرّر SQL)
-- -----------------------------------------------------------------------------
select
  auth.uid()                        as session_user_id,
  auth.jwt() ->> 'email'            as session_email,
  current_user                      as db_current_user,
  current_database()                as db_name,
  (auth.uid() is null)              as is_sql_editor_context;


-- -----------------------------------------------------------------------------
-- §1 · حلّ الحساب المستهدف: وجوده في auth.users وملفه في public.profiles
--      (public.has_permission تشترط profiles.status = 'active')
-- -----------------------------------------------------------------------------
with params as (
  select 'qa.admin@example.com'::text as target_email
)
select
  u.id                                              as user_id,
  u.email                                           as auth_email,
  u.email_confirmed_at,
  u.created_at                                      as auth_created_at,
  p.id                                              as profile_id,
  p.email                                           as profile_email,
  p.full_name,
  p.status                                          as profile_status,
  p.last_sign_in_at,
  case
    when u.id is null                      then 'NO_AUTH_USER'
    when p.id is null                      then 'NO_PROFILE'
    when p.status <> 'active'              then 'PROFILE_NOT_ACTIVE'
    else 'OK'
  end                                               as account_health
from params pr
left join auth.users u      on lower(u.email) = lower(pr.target_email)
left join public.profiles p on p.id = u.id;


-- -----------------------------------------------------------------------------
-- §2 · ما هي أدواري؟
--      تصحيح: جدول public.roles **لا يحتوي عمودًا باسم name**؛
--      الأعمدة هي slug · name_ar · name_en · description · is_system.
--      استخدام r.name يرفع الخطأ 42703 (column r.name does not exist).
-- -----------------------------------------------------------------------------
with params as (
  select 'qa.admin@example.com'::text as target_email
)
select
  r.slug          as role_slug,
  r.name_ar,
  r.name_en,
  r.is_system,
  ur.granted_at,
  ur.granted_by
from public.user_roles ur
join auth.users u      on u.id = ur.user_id
join params pr         on lower(u.email) = lower(pr.target_email)
join public.roles r    on r.id = ur.role_id
order by r.slug;


-- -----------------------------------------------------------------------------
-- §3 · ما هي صلاحياتي الفعلية؟
--      تصحيح: جدول public.permissions **لا يحتوي عمودًا باسم name**؛
--      المعرّف المنطقي هو slug (مع module · name_ar · name_en).
--      استخدام p.name يرفع الخطأ 42703 (column p.name does not exist).
-- -----------------------------------------------------------------------------
with params as (
  select 'qa.admin@example.com'::text as target_email
),
granted as (
  select distinct p.slug, p.module, p.name_ar, p.name_en
  from public.user_roles ur
  join auth.users u           on u.id = ur.user_id
  join params pr              on lower(u.email) = lower(pr.target_email)
  join public.role_permissions rp on rp.role_id = ur.role_id
  join public.permissions p   on p.id = rp.permission_id
),
expanded as (
  -- «*» صلاحية شاملة: has_permission تُطابق أي slug إذا وُجدت.
  -- نوسّعها هنا على كامل جدول الصلاحيات حتى تعكس القائمة ما يراه الخادم فعلًا.
  select p.slug, p.module, p.name_ar, p.name_en
  from public.permissions p
  where exists (select 1 from granted g where g.slug = '*')
  union
  select g.slug, g.module, g.name_ar, g.name_en from granted g where g.slug <> '*'
)
select slug, module, name_ar, name_en
from expanded
order by module, slug;


-- -----------------------------------------------------------------------------
-- §4 · هل أمتلك صلاحيّتَي الشاشة تحديدًا؟ (settings.manage / notifications.manage)
--      نفس منطق public.has_permission: (slug مطابق أو '*') + ملف نشط.
-- -----------------------------------------------------------------------------
with params as (
  select 'qa.admin@example.com'::text as target_email
),
granted as (
  select distinct p.slug
  from public.user_roles ur
  join auth.users u           on u.id = ur.user_id
  join params pr              on lower(u.email) = lower(pr.target_email)
  join public.role_permissions rp on rp.role_id = ur.role_id
  join public.permissions p   on p.id = rp.permission_id
),
profile_state as (
  select coalesce(p.status, 'invited'::public.user_status) as status
  from auth.users u
  join params pr              on lower(u.email) = lower(pr.target_email)
  left join public.profiles p on p.id = u.id
)
select
  (select status from profile_state)                              as profile_status,
  ((select status from profile_state) = 'active')                 as is_active_user,
  exists (select 1 from granted where slug = '*')                  as has_wildcard_star,
  exists (select 1 from granted where slug = 'settings.manage')    as has_settings_manage,
  exists (select 1 from granted where slug = 'notifications.manage') as has_notifications_manage,
  -- نفس تعبير public.has_permission('settings.manage')
  ((select status from profile_state) = 'active')
    and (exists (select 1 from granted where slug = '*')
         or exists (select 1 from granted where slug = 'settings.manage'))       as has_permission_settings_manage,
  -- نفس تعبير public.has_permission('notifications.manage')
  ((select status from profile_state) = 'active')
    and (exists (select 1 from granted where slug = '*')
         or exists (select 1 from granted where slug = 'notifications.manage'))  as has_permission_notifications_manage;


-- -----------------------------------------------------------------------------
-- §5 · الحكم النهائي: مصفوفة البوابات الأربع التي تحكم الشاشة فعلًا
--      (كل بوابة = is_active_user() AND ( is_admin() OR has_permission(...) ))
--      البوابة 1 · can_manage_email_transport()        → settings.manage   (الناقل/الأسرار/الاستيراد)
--      البوابة 2 · can_manage_notification_templates() → notifications.manage (القوالب)
--      البوابة 3 · admin_export_notification_bundle()  → settings.manage OR notifications.manage
--      البوابة 4 · admin_import_notification_bundle()  → settings.manage فقط
-- -----------------------------------------------------------------------------
with params as (
  select 'qa.admin@example.com'::text as target_email
),
account as (
  select
    u.id                                                        as user_id,
    u.email                                                     as email,
    p.id is not null                                            as has_profile,
    coalesce(p.status::text, 'NO_PROFILE')                      as profile_status,
    coalesce(p.status, 'invited'::public.user_status) = 'active' as is_active
  from params pr
  left join auth.users u      on lower(u.email) = lower(pr.target_email)
  left join public.profiles p on p.id = u.id
),
granted as (
  select distinct p.slug
  from public.user_roles ur
  join public.role_permissions rp on rp.role_id = ur.role_id
  join public.permissions p       on p.id = rp.permission_id
  where ur.user_id = (select user_id from account)
),
caps as (
  select
    (select count(*) from public.user_roles ur where ur.user_id = (select user_id from account)) as role_count,
    exists (select 1 from granted where slug = '*')                   as star,
    exists (select 1 from granted where slug = 'settings.manage')     as settings_manage,
    exists (select 1 from granted where slug = 'notifications.manage') as notifications_manage
)
select
  a.email,
  a.has_profile,
  a.profile_status,
  a.is_active,
  c.role_count,
  c.star                                                                   as has_star,
  c.settings_manage                                                        as has_settings_manage,
  c.notifications_manage                                                   as has_notifications_manage,
  a.is_active and (c.star or c.settings_manage)                            as gate_transport,
  a.is_active and (c.star or c.notifications_manage)                       as gate_templates,
  a.is_active and (c.star or c.settings_manage or c.notifications_manage)  as gate_export_bundle,
  a.is_active and (c.star or c.settings_manage)                            as gate_import_bundle,
  case
    when a.user_id is null                        then 'الحساب غير موجود في auth.users'
    when not a.has_profile                        then 'لا يوجد صف في public.profiles (الملف ينشئه مؤثر handle_new_user)'
    when not a.is_active                          then 'الملف غير نشط (status = ' || a.profile_status || ') — كل البوابات مغلقة'
    when c.role_count = 0                         then 'لا أدوار مرتبطة بالحساب (user_roles فارغ)'
    when not (c.star or c.notifications_manage)   then 'لا يملك notifications.manage ولا * — شاشة القوالب فارغة/مرفوضة'
    when not (c.star or c.settings_manage)        then 'يملك القوالب فقط — الناقل والاستيراد مرفوضان (هذا مقصود للفصل بين القدرتين)'
    when c.star                                   then 'مدير شامل (*) — كل البوابات مفتوحة'
    else 'مدير إعدادات + إشعارات — كل البوابات مفتوحة'
  end                                                                       as diagnosis_ar,
  case
    when a.user_id is null       then 'أنشئ الحساب: scripts/sql/test-account-bootstrap.sql'
    when not a.has_profile       then 'insert into public.profiles (id, email, full_name) values (...)'
    when not a.is_active         then 'فعّله عبر admin_set_user_status أو حدّث profiles.status إلى active'
    when c.role_count = 0        then 'admin_set_user_roles(user_id, array[''admin''])'
    when not (c.star or c.notifications_manage) then 'أضف دورًا يملك notifications.manage (admin أو qa_notifications_editor)'
    else 'لا إجراء مطلوب'
  end                                                                       as recommended_fix_ar
from account a
cross join caps c;


-- -----------------------------------------------------------------------------
-- §6 · محاكاة جلسة حقيقية (اختبار اختراقي للبوابات نفسها لا لمنطقها)
--      يعمل داخل معاملة واحدة؛ set_config(..., true) محلي يتراجع بنهايتها،
--      فلا يترك أي أثر على الجلسة. النتيجة تُطبع في «Messages/Notices».
--      ملاحظة: رفض 42501 في export/list/get = النتيجة الصحيحة لحساب بلا صلاحية.
-- -----------------------------------------------------------------------------
do $$
declare
  v_email          text := 'qa.admin@example.com';
  v_user           uuid;
  v_active         boolean;
  v_admin          boolean;
  v_settings       boolean;
  v_notify         boolean;
  v_transport      boolean;
  v_templates      boolean;
  v_export         text;
  v_list           text;
  v_transport_read text;
begin
  select u.id into v_user from auth.users u where lower(u.email) = lower(v_email);
  if v_user is null then
    -- إشعار لا استثناء: الاستثناء يُبطل نتائج كل الأقسام السابقة في محرّر SQL.
    raise notice 'لا يوجد حساب بالبريد % — أنشئه أولًا عبر test-account-bootstrap.sql', v_email;
    return;
  end if;

  -- محاكاة JWT المستخدم داخل هذه المعاملة فقط.
  perform set_config('request.jwt.claim.sub',  v_user::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_active    := public.is_active_user();
  v_admin     := public.is_admin();
  v_settings  := public.has_permission('settings.manage');
  v_notify    := public.has_permission('notifications.manage');
  v_transport := public.can_manage_email_transport();
  v_templates := public.can_manage_notification_templates();

  begin
    perform public.admin_export_notification_bundle();
    v_export := 'ALLOWED';
  exception when insufficient_privilege then
    v_export := 'DENIED (42501)';
  end;

  begin
    perform count(*) from public.admin_list_notification_templates();
    v_list := 'ALLOWED';
  exception when insufficient_privilege then
    v_list := 'DENIED (42501)';
  end;

  begin
    perform public.admin_get_email_transport();
    v_transport_read := 'ALLOWED';
  exception when insufficient_privilege then
    v_transport_read := 'DENIED (42501)';
  end;

  raise notice '──────── تقرير القدرات: % ────────', v_email;
  raise notice 'is_active_user()                     : %', v_active;
  raise notice 'is_admin()  (يملك *)                 : %', v_admin;
  raise notice 'has_permission(settings.manage)      : %', v_settings;
  raise notice 'has_permission(notifications.manage) : %', v_notify;
  raise notice 'can_manage_email_transport()         : %', v_transport;
  raise notice 'can_manage_notification_templates()  : %', v_templates;
  raise notice 'admin_export_notification_bundle()   : %', v_export;
  raise notice 'admin_list_notification_templates()  : %', v_list;
  raise notice 'admin_get_email_transport()          : %', v_transport_read;

  -- تراجع عن محاكاة الجلسة صراحةً (احتياط فوق الطابع المحلي للمعاملة).
  perform set_config('request.jwt.claim.sub',  '', true);
  perform set_config('request.jwt.claim.role', '', true);
end $$;


-- -----------------------------------------------------------------------------
-- §7 · صورة شاملة: من يملك ماذا بين كل الحسابات (مفيد قبل منح الصلاحيات)
-- -----------------------------------------------------------------------------
select
  p.email,
  p.full_name,
  p.status                                              as profile_status,
  coalesce(array_agg(distinct r.slug) filter (where r.slug is not null), '{}') as roles,
  bool_or(perm.slug = '*')                              as star,
  bool_or(perm.slug = 'settings.manage')                as settings_manage,
  bool_or(perm.slug = 'notifications.manage')           as notifications_manage,
  p.status = 'active'
    and (bool_or(perm.slug = '*') or bool_or(perm.slug = 'notifications.manage')) as can_use_notifications_screen
from public.profiles p
left join public.user_roles ur       on ur.user_id = p.id
left join public.roles r             on r.id = ur.role_id
left join public.role_permissions rp on rp.role_id = r.id
left join public.permissions perm    on perm.id = rp.permission_id
group by p.id, p.email, p.full_name, p.status
order by can_use_notifications_screen desc, p.email;


-- -----------------------------------------------------------------------------
-- §8 · سلامة مصفوفة الأدوار (هل seed/الترحيلات ربطت الصلاحيات كما نتوقع؟)
--      المتوقع: super_admin = * فقط · admin = settings.manage + notifications.manage
-- -----------------------------------------------------------------------------
select
  r.slug                as role_slug,
  r.is_system,
  count(perm.id)        as permission_count,
  bool_or(perm.slug = '*')                    as star,
  bool_or(perm.slug = 'settings.manage')      as settings_manage,
  bool_or(perm.slug = 'notifications.manage') as notifications_manage,
  bool_or(perm.slug = 'roles.manage')         as roles_manage,
  bool_or(perm.slug = 'users.manage')         as users_manage
from public.roles r
left join public.role_permissions rp on rp.role_id = r.id
left join public.permissions perm    on perm.id = rp.permission_id
group by r.id, r.slug, r.is_system
order by r.slug;
