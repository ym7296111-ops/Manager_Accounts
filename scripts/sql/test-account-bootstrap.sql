-- =============================================================================
-- test-account-bootstrap.sql
-- ⚠ DEVELOPMENT ONLY: run only against an isolated, disposable QA project.
-- Never run this file in production or in a shared/non-isolated environment.
-- إعداد ثلاث شخصيات اختبار للتحقق من شاشة «الإشعارات وقوالب الرسائل»
-- (/settings/app/notifications) ومن الفصل بين قدرتَي settings.manage و
-- notifications.manage.
--
-- ⚠ هذا الملف **ليس ترحيلًا**: لا تضعه في supabase/migrations/ (سير العمل
--   يطبّق ذلك المجلد على قاعدة الإنتاج). مكانه الصحيح scripts/sql/.
--
-- الشخصيات:
--   ┌────────────────────────────────┬──────────────────────────┬──────────────────────────────────────────┐
--   │ البريد                          │ الدور                    │ القدرة المتوقعة على الشاشة                │
--   ├────────────────────────────────┼──────────────────────────┼──────────────────────────────────────────┤
--   │ qa.admin@example.com           │ admin                    │ كامل: الناقل + القوالب + تصدير + استيراد  │
--   │ qa.notifications@example.com   │ qa_notifications_editor  │ القوالب + التصدير فقط (بلا ناقل/استيراد)  │
--   │ qa.viewer@example.com          │ viewer                   │ مرفوض (42501) على كل نداءات الشاشة        │
--   └────────────────────────────────┴──────────────────────────┴──────────────────────────────────────────┘
--
-- قبل التشغيل:
--   1) هذا السكربت مخصص حصراً لبيئة تطوير/QA معزولة وقابلة للإزالة.
--   2) بدّل النطاق example.com بنطاق اختبار تملكه؛ لا تضع كلمات مرور ثابتة هنا.
--   3) سجّل مالك المشروع المقصود أولاً من واجهة التطبيق. إذا لم يسبق وجود أي
--      مستخدم Auth، فإن أول تسجيل يحصل ذرياً على owner ويُؤكَّد بريده؛
--      وكل تسجيل لاحق يحصل على viewer. لا تنشئ حسابات QA قبل هذا المالك.
--   4) حدّد الأدمن الفعّال المنفّذ في §3 و§4 (v_actor_email) — يجب أن يكون
--      profile.status = 'active' وأن يملك '*' (owner أو super_admin) أو roles.manage،
--      لأن admin_set_user_roles / admin_set_role_permissions تشترط ذلك.
--   5) شغّل الأقسام بالترتيب. كل الأقسام عاطلة التأثير (idempotent) ما عدا
--      §2 الذي ينشئ الحسابات مرة واحدة فقط. كلمات المرور العشوائية تظهر مرة
--      واحدة فقط لصفوف Auth الجديدة؛ خزّنها بأمان فوراً، ولا تُعد تشغيل استعلام
--      إنشاء الحسابات لتوقع استرجاعها (المخزن هو التجزئة فقط).
-- للتحقق بعد الإعداد: scripts/sql/admin-capability-audit.sql
-- للتنظيف:            scripts/sql/test-account-teardown.sql
-- =============================================================================


-- -----------------------------------------------------------------------------
-- §1 · المسار أ (الموصى به): إنشاء الحسابات عبر GoTrue لا عبر SQL
--      GoTrue هو مصدر الهوية؛ إدراج auth.users مباشرة (المسار ب) تجاوزٌ مقبول
--      لحسابات QA المؤقتة فقط، لأنه يتجاوز سياسات كلمة المرور وتدفق التأكيد.
--      سجّل مالك المشروع المقصود أولاً قبل أي حساب QA؛ فالـ Auth trigger يمنح
--      أول تسجيل فقط owner ويؤكد بريده، ثم يمنح viewer للتسجيلات اللاحقة.
--      هذا المسار لا يُستخدم إلا داخل مشروع تطوير معزول قابل للإزالة.
--
--   من لوحة Supabase:  Authentication → Users → Add user → "Auto Confirm User"
--   أو من سطر الأوامر:
--     supabase auth admin create-user qa.admin@example.com \
--       --password "$QA_ADMIN_PASSWORD" --auto-confirm
--     أنشئ QA_ADMIN_PASSWORD عشوائياً في مدير أسرار محلي مؤقت؛ لا تحفظه في هذا الملف.
--
--   بعد إنشاء الحسابات بهذا المسار: ابدأ من §3 مباشرة (§2 غير مطلوب).
-- -----------------------------------------------------------------------------


-- -----------------------------------------------------------------------------
-- §2 · المسار ب (SQL خالص): إنشاء الحسابات الثلاثة مباشرة
--      ⚠ تطوير/QA معزول فقط؛ لا تستخدمه في الإنتاج أو مشروع مشترك.
--      يولّد 32 بايت عشوائياً لكل حساب جديد ويعرض كلمة المرور مرة واحدة في
--      نتيجة هذا الاستعلام. الحساب الموجود مسبقاً لا يعرض كلمة مروره ولا يغيّرها.
--      مؤثر handle_new_user() ينشئ صف public.profiles تلقائيًا بحالة 'active'،
--      ويمنح viewer لأن هذا السكريبت يرفض العمل قبل تسجيل مالك المشروع.
--      pgcrypto مثبّت في مخطط extensions على Supabase؛ لذا النداء مُطَلَق بالمخطط.
-- -----------------------------------------------------------------------------
do $qa_first_signup_guard$
declare
  v_claimed boolean;
  v_first_user_id uuid;
begin
  select s.claimed, s.first_user_id
    into v_claimed, v_first_user_id
    from public.first_admin_bootstrap_state as s
   where s.singleton is true;

  if not found or not coalesce(v_claimed, false) then
    raise exception 'Register the intended project owner as the first Auth user before creating QA accounts.';
  end if;

  if v_first_user_id is not null and exists (
    select 1 from auth.users as u
     where u.id = v_first_user_id
       and lower(u.email) like 'qa.%@%'
  ) then
    raise exception 'A QA account consumed the first owner signup. Do not try to promote it to admin; reset this disposable QA project and register the intended owner first.';
  end if;
end
$qa_first_signup_guard$;

with candidates as materialized (
  select
    gen_random_uuid() as id,
    v.email,
    encode(extensions.gen_random_bytes(32), 'hex') as password,
    v.full_name
  from (values
    ('qa.admin@example.com',         'مدير اختبار'),
    ('qa.notifications@example.com', 'محرر إشعارات اختبار'),
    ('qa.viewer@example.com',        'مشاهد اختبار')
  ) as v(email, full_name)
  where not exists (
    select 1 from auth.users u where lower(u.email) = lower(v.email)
  )
), created as (
  insert into auth.users (
    id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  )
  select
    c.id,
    'authenticated',
    'authenticated',
    c.email,
    extensions.crypt(c.password, extensions.gen_salt('bf', 10)),
    now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('full_name', c.full_name),
    now(),
    now()
  from candidates c
  on conflict do nothing
  returning id, email
)
select c.email, c.password as generated_password
  from candidates c
  join created u on u.id = c.id and u.email = c.email
 order by c.email;

-- تحقق: ثلاثة حسابات + ثلاثة ملفات شخصية بحالة active
select
  u.email,
  p.id is not null as has_profile,
  p.status,
  p.full_name
from auth.users u
left join public.profiles p on p.id = u.id
where lower(u.email) in (
  'qa.admin@example.com', 'qa.notifications@example.com', 'qa.viewer@example.com'
)
order by u.email;

-- احتياط يدوي إن تعطّل المؤثر (لا يُتوقع):
-- insert into public.profiles (id, email, full_name, status)
-- select u.id, u.email, 'مدير اختبار', 'active'
-- from auth.users u
-- where lower(u.email) = 'qa.admin@example.com'
-- on conflict (id) do nothing;


-- Recheck before the role setup so the Auth-API path (§1) has the same guard
-- as the direct-SQL path (§2), even when this section is run by itself.
do $qa_first_signup_guard$
declare
  v_claimed boolean;
  v_first_user_id uuid;
begin
  select s.claimed, s.first_user_id
    into v_claimed, v_first_user_id
    from public.first_admin_bootstrap_state as s
   where s.singleton is true;

  if not found or not coalesce(v_claimed, false) then
    raise exception 'Register the intended project owner as the first Auth user before configuring QA roles.';
  end if;

  if v_first_user_id is not null and exists (
    select 1 from auth.users as u
     where u.id = v_first_user_id
       and lower(u.email) like 'qa.%@%'
  ) then
    raise exception 'A QA account consumed the first owner signup. Do not try to promote it to admin; reset this disposable QA project and register the intended owner first.';
  end if;
end
$qa_first_signup_guard$;

-- -----------------------------------------------------------------------------
-- §3 · دور الاختبار للفصل بين القدرتين: qa_notifications_editor
--      (غير نظامي، يملك notifications.manage دون settings.manage)
--      ربط الصلاحيات يتم عبر admin_set_role_permissions — المسار الوحيد المسموح،
--      لأن الإدراج المباشر في role_permissions محجوب بمؤثر guard_*.
-- -----------------------------------------------------------------------------
insert into public.roles (slug, name_ar, name_en, description, is_system)
values (
  'qa_notifications_editor',
  'محرر إشعارات (اختبار)',
  'Notifications editor (QA)',
  'دور اختبار غير نظامي: يملك notifications.manage فقط لإثبات الفصل عن settings.manage',
  false
)
on conflict (slug) do nothing;

do $$
declare
  v_actor_email text := 'admin@example.com';   -- ⚠ عدّلها: أدمن فعّال ونشط
  v_actor  uuid;
  v_role   uuid;
  v_result jsonb;
begin
  select u.id into v_actor from auth.users u where lower(u.email) = lower(v_actor_email);
  if v_actor is null then
    raise exception 'لا يوجد أدمن بالبريد % — عدّل v_actor_email في §3', v_actor_email;
  end if;

  select r.id into v_role from public.roles r where r.slug = 'qa_notifications_editor';
  if v_role is null then
    raise exception 'دور qa_notifications_editor غير موجود — نفّذ جملة insert أعلاه أولًا';
  end if;

  -- محاكاة جلسة الأدمن المنفّذ داخل هذه المعاملة فقط (تُتراجَع بنهايتها).
  perform set_config('request.jwt.claim.sub',  v_actor::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_result := public.admin_set_role_permissions(
    v_role,
    array['dashboard.view', 'notifications.manage']   -- الحالة النهائية المرغوبة (diff داخل الـ RPC)
  );
  raise notice 'qa_notifications_editor → %', v_result;

  perform set_config('request.jwt.claim.sub',  '', true);
  perform set_config('request.jwt.claim.role', '', true);
end $$;


-- Recheck before the role setup so the Auth-API path (§1) has the same guard
-- as the direct-SQL path (§2), even when this section is run by itself.
do $qa_first_signup_guard$
declare
  v_claimed boolean;
  v_first_user_id uuid;
begin
  select s.claimed, s.first_user_id
    into v_claimed, v_first_user_id
    from public.first_admin_bootstrap_state as s
   where s.singleton is true;

  if not found or not coalesce(v_claimed, false) then
    raise exception 'Register the intended project owner as the first Auth user before assigning QA roles.';
  end if;

  if v_first_user_id is not null and exists (
    select 1 from auth.users as u
     where u.id = v_first_user_id
       and lower(u.email) like 'qa.%@%'
  ) then
    raise exception 'A QA account consumed the first owner signup. Do not try to promote it to admin; reset this disposable QA project and register the intended owner first.';
  end if;
end
$qa_first_signup_guard$;

-- -----------------------------------------------------------------------------
-- §4 · ربط الأدوار بالحسابات عبر admin_set_user_roles (المسار المعتمد)
--      يكتب سطر تدقيق 'role.granted' ويتحقق من حرّاس الخفض الذاتي و«آخر مسؤول».
-- -----------------------------------------------------------------------------
do $$
declare
  v_actor_email text := 'admin@example.com';   -- ⚠ عدّلها: أدمن فعّال ونشط
  v_actor  uuid;
  v_rec    record;
  v_target uuid;
  v_result jsonb;
begin
  select u.id into v_actor from auth.users u where lower(u.email) = lower(v_actor_email);
  if v_actor is null then
    raise exception 'لا يوجد أدمن بالبريد % — عدّل v_actor_email في §4', v_actor_email;
  end if;

  perform set_config('request.jwt.claim.sub',  v_actor::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  for v_rec in
    select *
    from (
      values
        ('qa.admin@example.com',         array['admin']),
        ('qa.notifications@example.com', array['qa_notifications_editor']),
        ('qa.viewer@example.com',        array['viewer'])
    ) as t(email, role_slugs)
  loop
    select u.id into v_target from auth.users u where lower(u.email) = lower(v_rec.email);

    if v_target is null then
      raise notice 'تجاوز %: لا يوجد حساب (نفّذ §1 أو §2 أولًا)', v_rec.email;
      continue;
    end if;

    -- ملاحظة: المصفوفة هي «الحالة النهائية» لا «عملية إضافة»؛ أي دور سابق
    -- غير مذكور يُسحب — وهو ما قد يفعّل حارس الخفض الذاتي إن كان الحساب يملك *.
    v_result := public.admin_set_user_roles(v_target, v_rec.role_slugs);
    raise notice '% → %', v_rec.email, v_result;
  end loop;

  perform set_config('request.jwt.claim.sub',  '', true);
  perform set_config('request.jwt.claim.role', '', true);
end $$;


-- -----------------------------------------------------------------------------
-- §5 · بديل مباشر (طوارئ فقط): إدراج user_roles يدويًا
--      يُستخدم فقط إذا تعذّر §4 (مثلًا: لا يوجد أدمن نشط بعد). يتجاوز الحرّاس
--      ولا يكتب سطر تدقيق — لا تعتمده في بيئة تُمثّل الإنتاج.
--      يعمل لأن جلسة محرّر SQL هي postgres (superuser) ولا تخضع للمنح المسحوبة.
-- -----------------------------------------------------------------------------
-- insert into public.user_roles (user_id, role_id)
-- select u.id, r.id
-- from auth.users u
-- join public.roles r on r.slug = 'admin'
-- where lower(u.email) = 'qa.admin@example.com'
-- on conflict (user_id, role_id) do nothing;


-- -----------------------------------------------------------------------------
-- §6 · تحقّق سريع بعد الإعداد (المتوقع: true / true / false في العمود الأخير)
-- -----------------------------------------------------------------------------
select
  u.email,
  p.status                                                     as profile_status,
  array_agg(distinct r.slug)                                   as roles,
  bool_or(perm.slug = '*')                                     as star,
  bool_or(perm.slug = 'settings.manage')                       as settings_manage,
  bool_or(perm.slug = 'notifications.manage')                  as notifications_manage,
  p.status = 'active'
    and (bool_or(perm.slug = '*') or bool_or(perm.slug = 'notifications.manage')) as can_open_templates,
  p.status = 'active'
    and (bool_or(perm.slug = '*') or bool_or(perm.slug = 'settings.manage'))      as can_manage_transport
from auth.users u
join public.profiles p             on p.id = u.id
left join public.user_roles ur     on ur.user_id = u.id
left join public.roles r           on r.id = ur.role_id
left join public.role_permissions rp on rp.role_id = r.id
left join public.permissions perm  on perm.id = rp.permission_id
where lower(u.email) in (
  'qa.admin@example.com', 'qa.notifications@example.com', 'qa.viewer@example.com'
)
group by u.email, p.status
order by u.email;
