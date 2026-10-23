# Runbook — التحقق من صلاحيات الأدمن على شاشة الإشعارات + إعداد حساب اختبار

> **النطاق:** تشخيص صلاحيات `settings.manage` / `notifications.manage` على الشاشة
> `/settings/app/notifications`، وإعداد ثلاث شخصيات اختبار تُثبت الفصل بين القدرتين.
> **لا كود واجهة، لا ترحيل SQL** في هذا المستند — ملفات SQL التشغيلية وُضعت في `scripts/sql/`
> (خارج `supabase/migrations/` عمدًا؛ سير العمل يطبّق ذلك المجلد على قاعدة الإنتاج).
>
> **الملفات المرافقة:**
>
> | الملف                                    | الوصف                                                 |
> | ---------------------------------------- | ----------------------------------------------------- |
> | `scripts/sql/admin-capability-audit.sql` | تشخيص قراءة فقط + محاكاة جلسة داخل معاملة (٨ أقسام)   |
> | `scripts/sql/test-account-bootstrap.sql` | إعداد الشخصيات الثلاث + دور الاختبار (مساران للإنشاء) |
> | `scripts/sql/test-account-teardown.sql`  | حذف أثر الاختبار مع معاينة قبل الحذف                  |

---

## 0) الخلاصة التنفيذية (TL;DR)

الاستعلامات الثلاثة المقترحة في المهمة **لا تعمل كما هي** — ثلاث مشكلات مؤكدة بالرجوع إلى المخطط:

| #   | الاستعلام كما ورد                                              | المشكلة                                                                                                         | الأثر                                                                       | التصحيح                                                                              |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | `SELECT r.name AS role_name FROM … public.roles r`             | `public.roles` **لا يحتوي عمودًا باسم `name`**؛ الأعمدة هي `slug · name_ar · name_en · description · is_system` | `ERROR 42703: column r.name does not exist`                                 | استخدم `r.slug` (المعرّف المنطقي) + `r.name_ar` للعرض                                |
| 2   | `SELECT p.name AS permission_name FROM … public.permissions p` | `public.permissions` **لا يحتوي `name`**؛ المعرّف هو `slug` (+ `module · name_ar · name_en`)                    | `ERROR 42703: column p.name does not exist`                                 | استخدم `p.slug`                                                                      |
| 3   | `WHERE ur.user_id = auth.uid()`                                | في **محرّر SQL** الجلسة هي `postgres` بلا JWT → `auth.uid()` تُرجع `NULL` دائمًا                                | الاستعلام يُرجع **صفر صفوف** فيبدو كأن الحساب بلا أدوار — نتيجة سلبية كاذبة | مرّر البريد صراحةً (`params` CTE)، أو حاكِ الجلسة داخل معاملة (القسم ٦ من ملف الفحص) |

نقطة رابعة أهم من الثلاث: **قائمة الـ slugs وحدها لا تجيب على سؤال الشاشة.**
`public.has_permission` يفتح الباب إذا كان الـ slug مطابقًا **أو** كانت الصلاحية الشاملة `*`
ممنوحة — ويشترط `profiles.status = 'active'`. فحساب `super_admin` يرى قائمة تحتوي `*` فقط
ومع ذلك يملك كل شيء، وحساب معلّق (`suspended`) يرى القائمة كاملة ولا يملك شيئًا.

---

## 1) ما الذي تتطلبه الشاشة فعليًا؟

الشاشة مركّبة (ناقل SMTP + محرّر قوالب + معاينة)، وكل كتلة فيها بوابة مستقلة —
وليست بوابة واحدة بـ «`settings.manage` أو `notifications.manage`»:

| البوابة (الدالة/الـ RPC)                  | القدرة المطلوبة                                        | ما تتحكّم به على الشاشة                        |
| ----------------------------------------- | ------------------------------------------------------ | ---------------------------------------------- |
| `can_manage_email_transport()`            | `settings.manage` أو `*` + ملف نشط                     | قراءة/تعديل الناقل · تعيين كلمة المرور · مسحها |
| `can_manage_notification_templates()`     | `notifications.manage` أو `*` + ملف نشط                | قراءة القوالب · تحرير · نشر · تراجع · معاينة   |
| `admin_export_notification_bundle()`      | `settings.manage` **أو** `notifications.manage` أو `*` | تصدير الحزمة (غير السرّية)                     |
| `admin_import_notification_bundle(jsonb)` | `settings.manage` أو `*` **فقط**                       | استيراد الحزمة                                 |

كل بوابة = `is_active_user() AND ( is_admin() OR has_permission(…) )`،
و`is_admin()` مُعرَّفة بـ `has_permission('*')` — أي أن **`*` تفتح كل شيء**،
و**`roles.manage` لا تفتح شيئًا** في هذه الشاشة.

النداءات التي تُجريها الواجهة من المتصفح (من `src/`):

| النداء                                                                                                                                                                                                                                                             | البوابة                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| `admin_get_email_transport()` · `admin_update_email_transport()` · `admin_set_email_password()` · `admin_clear_email_password()`                                                                                                                                   | `settings.manage`      |
| `admin_list_notification_templates()` · `admin_upsert_notification_template_draft()` · `admin_publish_notification_template()` · `admin_rollback_notification_template()` · `admin_delete_notification_template_draft()` · `admin_preview_notification_template()` | `notifications.manage` |
| `admin_export_notification_bundle()` / `admin_import_notification_bundle()`                                                                                                                                                                                        | كما في الجدول أعلاه    |

> **نتيجة عملية:** أقل حساب «يرى الشاشة ويستخدمها بالكامل» هو من يملك
> `settings.manage` **و** `notifications.manage` معًا — أي دور `admin` في الـ seed الحالي.

---

## 2) الاستعلامات المصحّحة

### ٢.١ — نصائح تشغيل قبل التنفيذ

- محرّر SQL يعمل بجلسة `postgres`: **`auth.uid()` و`auth.jwt()` يُرجعان `NULL`**. ابدأ بالبريد لا بالجلسة.
- استبدل `qa.admin@example.com` ببريد حسابك في كل الأقسام (Find & Replace واحدة تكفي).
- كل الأقسام قراءة فقط عدا القسم ٦ الذي يحاكي جلسة داخل معاملة تتراجع بنهايتها.

### ٢.٢ — ① من أنا؟ (سياق الجلسة)

```sql
select
  auth.uid()             as session_user_id,
  auth.jwt() ->> 'email' as session_email,
  current_user           as db_current_user,
  (auth.uid() is null)   as is_sql_editor_context;
```

المتوقع في محرّر SQL: `session_user_id = NULL` و`is_sql_editor_context = true`.
هذا هو سبب النتيجة السلبية الكاذبة في الاستعلام الأصلي — وليس خللًا في الصلاحيات.

### ٢.٣ — ② ما هي أدواري؟ (مصحّح)

```sql
with params as (select 'qa.admin@example.com'::text as target_email)
select
  r.slug       as role_slug,   -- ✅ لا يوجد عمود r.name
  r.name_ar,
  r.is_system,
  ur.granted_at,
  ur.granted_by
from public.user_roles ur
join auth.users u   on u.id = ur.user_id
join params pr      on lower(u.email) = lower(pr.target_email)
join public.roles r on r.id = ur.role_id
order by r.slug;
```

### ٢.٤ — ③ ما هي صلاحياتي الفعلية؟ (مصحّح + توسيع `*`)

```sql
with params  as (select 'qa.admin@example.com'::text as target_email),
     granted as (
       select distinct p.slug, p.module, p.name_ar      -- ✅ لا يوجد عمود p.name
       from public.user_roles ur
       join auth.users u            on u.id = ur.user_id
       join params pr               on lower(u.email) = lower(pr.target_email)
       join public.role_permissions rp on rp.role_id = ur.role_id
       join public.permissions p    on p.id = rp.permission_id
     ),
     expanded as (
       -- '*' تمنح كل صلاحية: نوسّعها كما يفعل has_permission تمامًا
       select p.slug, p.module, p.name_ar
       from public.permissions p
       where exists (select 1 from granted g where g.slug = '*')
       union
       select g.slug, g.module, g.name_ar from granted g where g.slug <> '*'
     )
select slug, module, name_ar from expanded order by module, slug;
```

### ٢.٥ — ④ الحكم النهائي: مصفوفة البوابات الأربع

القسم ٥ من `scripts/sql/admin-capability-audit.sql` يُرجع صفًا واحدًا فيه:

`profile_status` · `is_active` · `has_star` · `has_settings_manage` ·
`has_notifications_manage` · `gate_transport` · `gate_templates` ·
`gate_export_bundle` · `gate_import_bundle` · `diagnosis_ar` · `recommended_fix_ar`.

العمودان الأخيران نصّيان بالعربية: التشخيص والإجراء المقترح
(`NO_PROFILE` · `PROFILE_NOT_ACTIVE` · `لا أدوار` · `ينقصه notifications.manage` · …).

### ٢.٦ — ⑤ محاكاة جلسة حقيقية (اختبار اختراقي)

```sql
begin;
  set local role authenticated;
  select set_config('request.jwt.claim.sub',  '<USER_UUID>', true);
  select set_config('request.jwt.claim.role', 'authenticated', true);

  select public.is_active_user()                    as is_active,
         public.is_admin()                          as is_admin,
         public.has_permission('settings.manage')      as settings_manage,
         public.has_permission('notifications.manage') as notifications_manage,
         public.can_manage_email_transport()           as gate_transport,
         public.can_manage_notification_templates()    as gate_templates;
commit;
```

البديل الجاهز (بدون نسخ UUID) هو القسم ٦ من ملف الفحص: كتلة `do $$ … $$`
تحلّ الحساب بالبريد، وتُطبّق `set_config` محليًا، وتجرّب نداء
`admin_export_notification_bundle()` / `admin_list_notification_templates()` /
`admin_get_email_transport()` مع التقاط `insufficient_privilege`
(الرفض `42501` هنا هو **النتيجة الصحيحة** للحساب غير المصرَّح).

> نفس التقنية (دور محلي + `request.jwt.claim.sub`) هي ما تستخدمه مرآة الفحص
> `scripts/audit/database.mjs`، فهي مدعومة وليست اجتهادًا.

---

## 3) إعداد حساب الاختبار

**قبل أي حساب QA في مشروع جديد، سجّل المالك المقصود أولًا.** أول حساب Auth فقط يحصل على
`super_admin` تلقائيًا؛ لا تفترض أن حساب QA الذي أُنشئ أولًا يمكن ترقيته أو خفضه لاحقًا إلى
`admin`. يفحص `scripts/sql/test-account-bootstrap.sql` أن `first_user_id` ليس حسابًا بنمط
`qa.*`، ويتوقف إذا استهلك حساب QA التسجيل الأول. عند حدوث ذلك، أعد تهيئة مشروع QA المعزول
وسجّل المالك المقصود قبل إنشاء حسابات الاختبار.

### ٣.١ — الشخصيات

| البريد                         | الدور                     | القدرة المتوقعة                                  |
| ------------------------------ | ------------------------- | ------------------------------------------------ |
| `qa.admin@example.com`         | `admin`                   | كل البوابات الأربع مفتوحة                        |
| `qa.notifications@example.com` | `qa_notifications_editor` | القوالب + التصدير فقط؛ الناقل والاستيراد مرفوضان |
| `qa.viewer@example.com`        | `viewer`                  | كل نداءات الشاشة مرفوضة (`42501`)                |

الشخصية الثانية هي جوهر الاختبار: تُثبت أن `notifications.manage`
**لا** تفتح الناقل ولا الاستيراد (الفصل مُنفَّذ في قاعدة البيانات لا في الواجهة).

### ٣.٢ — المساران

| المسار           | كيف                                                                                                                                                        | متى                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| **أ (موصى به)**  | لوحة Supabase: `Authentication → Users → Add user` مع _Auto Confirm_، أو `supabase auth admin create-user … --auto-confirm`. ثم الأقسام ٣←٤ من ملف الإعداد | الحالة العامة                                             |
| **ب (SQL خالص)** | إدراج مباشر في `auth.users` مع `extensions.crypt(..., extensions.gen_salt('bf', 10))`                                                                      | بيئة لا تتاح فيها اللوحة/الـ CLI؛ **حسابات QA مؤقتة فقط** |

ملاحظات المسار ب:

- مؤثر `handle_new_user()` ينشئ `public.profiles` تلقائيًا بحالة `active` — وهو شرط `has_permission`.
- تكلفة bcrypt `10` تطابق GoTrue؛ `gen_salt('bf')` بلا وسيط يستخدم 6 وهي ضعيفة.
- `pgcrypto` على Supabase في مخطط `extensions` (وهو **ليس** على `search_path`)، لذا كل نداء مُطلَق بالمخطط.

### ٣.٣ — منح الأدوار: المسار المعتمد فقط

```sql
-- داخل كتلة do $$ … $$ (انظر §4 من ملف الإعداد):
perform set_config('request.jwt.claim.sub', v_actor::text, true);   -- أدمن فعّال ونشط
v_result := public.admin_set_user_roles(v_target, array['admin']);
```

لماذا الـ RPC لا الإدراج المباشر؟

- `admin_set_user_roles` يكتب سطر تدقيق `role.granted` ويمرّ بحرّاس الخفض الذاتي و«آخر مسؤول».
- المصفوفة هي **الحالة النهائية** لا «عملية إضافة»: أي دور سابق غير مذكور **يُسحب**
  (وقد يُفعّل حارس `RBA01`/`RBA02` إن كان الحساب يملك `*`).
- `admin_set_role_permissions(role_id, slugs)` هو المسار الوحيد لربط صلاحيات دور الاختبار،
  لأن الإدراج المباشر في `role_permissions` محجوب بمؤثر `guard_role_permissions_writes`
  (يسمح فقط حين `current_user ∈ (postgres, supabase_admin)`).

---

## 4) مصفوفة النتائج المتوقعة

| الشخصية                        | `can_manage_email_transport` | `can_manage_notification_templates` | `export`   | `import`   | ما تراه على الشاشة              |
| ------------------------------ | ---------------------------- | ----------------------------------- | ---------- | ---------- | ------------------------------- |
| `qa.admin@example.com`         | ✅                           | ✅                                  | ✅         | ✅         | الناقل + القوالب كاملَين        |
| `qa.notifications@example.com` | ❌ `42501`                   | ✅                                  | ✅         | ❌ `42501` | القوالب فقط؛ كتلة الناقل مرفوضة |
| `qa.viewer@example.com`        | ❌ `42501`                   | ❌ `42501`                          | ❌ `42501` | ❌ `42501` | كل النداءات مرفوضة              |
| حساب `super_admin` (يملك `*`)  | ✅                           | ✅                                  | ✅         | ✅         | كل شيء                          |

كيف تقرأ النتيجة في الواجهة؟ الرفض يصل كخطأ PostgREST بكود `42501`
ويُترجَم في الواجهة إلى رسالة «هذه الشاشة مقيّدة على من يملك صلاحية إدارة الإعدادات…»
(`settings.denied.*` في قاموس i18n).

---

## 5) التنظيف

نفّذ `scripts/sql/test-account-teardown.sql` **قسمًا قسمًا** في محرّر SQL:

| القسم | الأثر                                                                |
| ----- | -------------------------------------------------------------------- |
| §1    | **معاينة فقط** — اعرض النطاق وتأكد أنك على قاعدة الاختبار قبل أي حذف |
| §2    | فكّ ارتباط الأدوار عن حسابات `qa.*`                                  |
| §3    | حذف دور `qa_notifications_editor` (يتتالى إلى `role_permissions`)    |
| §4    | حذف الحسابات من `auth.users` (يتتالى إلى `profiles` ثم `user_roles`) |
| §5    | تحقّق نهائي                                                          |

> النمط المستخدم هو `u.email ilike 'qa.%@%'`؛ عدّله إن غيّرت النطاق في ملف الإعداد.

ما **لا** يُحذف: سطور `public.audit_logs` (سجل التدقيق لا يُنتقص)، والأدوار النظامية.
النتيجة المتوقعة في §5: `remaining_qa_users = 0` · `remaining_qa_roles = 0` · `active_star_admins ≥ 1`.

---

## 6) ملاحظات معمارية ظهرت أثناء التحقق (تحتاج قرارًا منفصلًا)

1. **المسار غير محمي على العميل.** `src/pages/SettingsPage.tsx` يركّب `NotificationSettings`
   دون تمرير الخاصية `disabled`، فكل مستخدم مُصادَق يمكنه فتح `/settings/app/notifications`
   ويصل إلى الشاشة؛ الحماية كلها على الخادم (RLS + بوابات الـ RPC). النتيجة: شاشة تبدو
   فارغة/تفشل نداءاتها بدل أن تُغلق. شاشتا `GeneralSettings` و`LocalizationSettings`
   تفعلان العكس تمامًا (`canManage === false` ⇒ شاشة 403 صريحة عبر `useAppIdentity`).
   **التوصية:** تمرير بوابة `can_manage_notification_templates()` إلى `disabled`
   (أو شاشة منع) لتوحيد السلوك مع بقية شاشات الإعدادات.
2. **مفاتيح `notifications.*` في `app_settings` أضيق من الشاشة.** سياسة القراءة هي
   `is_public OR is_admin()`، و`is_admin()` = `*` فقط — فـ `notifications.channels`
   و`notifications.retention_days` (غير عامّة) **لا تُقرأ إلا بـ `*`**، لا بـ `settings.manage`.
   لا أثر عملي اليوم لأن الشاشة لا تقرأ هذه المفاتيح، لكنه فخّ لأي قراءة مباشرة لاحقة.
3. **الرفض لا يميّز «لا صلاحية» عن «غير مُصادَق».** كل البوابات تُرجع `42501` نفسه.
   مقبول أمنيًا (لا تسريب معلومات)، ويستحق توثيقه في قاموس الأخطاء.

---

## 7) دليل التحقق: نُفِّذ فعليًا لا نظريًا

الملفات الثلاثة نُفِّذت على **PostgreSQL 17.4** أُنشئ محليًا من مكوّنات المشروع نفسها:

```
scripts/audit/supabase-fixture.sql  +  supabase/migrations/*.sql (١٤ ترحيلًا)  +  supabase/seed.sql
```

(نفس تسلسل التحميل الذي تستخدمه مرآة الفحص `scripts/audit/database.mjs`، مع استكمال
أعمدة `auth.users` و`auth.jwt()` التي يحذفها المِثبَت المدمج حتى تطابق سلوك Supabase المستضاف.)

| الملف                        | النتيجة                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `test-account-bootstrap.sql` | ✅ كل الأقسام نُفِّذت؛ `admin_set_role_permissions` و`admin_set_user_roles` أرجعتا diff صحيحًا |
| `admin-capability-audit.sql` | ✅ الأقسام ١←٨ كلها نُفِّذت على ٤ حسابات + حساب غير موجود                                      |
| `test-account-teardown.sql`  | ✅ `remaining_qa_users = 0` · `remaining_qa_roles = 0` · `active_star_admins = 1`              |

مخرجات محاكاة الجلسة (القسم ٦) كما رُصدت:

| الحساب                          | `is_active_user` | `is_admin` | `settings.manage` | `notifications.manage` | `export`   | `list templates` | `get transport`  |
| ------------------------------- | ---------------- | ---------- | ----------------- | ---------------------- | ---------- | ---------------- | ---------------- |
| `admin@example.com` (super)     | ✅               | ✅         | ✅                | ✅                     | ALLOWED    | ALLOWED          | ALLOWED          |
| `qa.admin@example.com`          | ✅               | ❌         | ✅                | ✅                     | ALLOWED    | ALLOWED          | ALLOWED          |
| `qa.notifications@example.com`  | ✅               | ❌         | ❌                | ✅                     | ALLOWED    | ALLOWED          | **DENIED 42501** |
| `qa.viewer@example.com`         | ✅               | ❌         | ❌                | ❌                     | **DENIED** | **DENIED**       | **DENIED**       |
| نفسه بعد `status = 'suspended'` | ❌               | ❌         | ❌                | ❌                     | **DENIED** | **DENIED**       | **DENIED**       |

الصفان الأخيران هما البرهان على بند «الخلاصة»: الحساب المعلّق **يرى** صلاحياته في
`user_roles`/`role_permissions` كاملة، ومع ذلك تُغلق كل البوابات — لأن `has_permission`
تشترط `profiles.status = 'active'`. و`super_admin` يرى slug واحدًا (`*`) ويفتح كل شيء.

---

## 8) نقاط اعتماد مقترحة

1. اعتماد الأعمدة الصحيحة (`slug` لا `name`) في أي استشارات/أدوات فحص لاحقة؟
2. اعتماد الشخصيات الثلاث كعُرف اختبار ثابت (بريد/دور/قدرة) أم اختراقها عند الحاجة فقط؟
3. إضافة بوابة عميل على `/settings/app/notifications` لتوحيدها مع باقي شاشات الإعدادات؟ (التوصية: نعم)
4. هل نُوسّع سياسة قراءة `app_settings` لتشمل `settings.manage` بدل `is_admin()` فقط؟
