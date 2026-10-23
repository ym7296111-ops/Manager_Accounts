# Runbook — التحقق المحلي من المرحلتين 1 و2 (الناقلات · الأسرار · القوالب)

> **النطاق:** ترحيل واحد فقط `supabase/migrations/20261002120000_notification_transports_and_secrets.sql`
>
> - تحديث مرآة الفحص `scripts/audit/database.mjs` + أنواع `src/lib/database.types.ts`.
>   **لا واجهة، لا Hooks، لا ملفات i18n** في هذه المرحلة (القاعدة الذهبية: تجزئة صارمة).
>   **المصدر:** `docs/consultations/2026-10-02-notifications-smtp-templates-design-study.md` (§1.2–1.8، §3.2، §3.4، §3.5).

---

## 0) ما الذي أُنشئ بالضبط

| الكائن                                     | الدور                                                                              | الحماية                                                                                                                      |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `public.notification_transports`           | تهيئة الناقل بحقول مكتوبة + `config jsonb` مُقنَّن (قائمة بيضاء = `{headers}` فقط) | RLS مُجبر · صفر سياسات · قراءة/كتابة عبر RPC فقط · `service_role` يملك `select/insert/update` · ثلاث CHECKs على `config`     |
| `notification_transport_config_is_valid()` | مدقّق `config`: يرفض المفاتيح خارج القائمة البيضاء والأنماط السرّية                | مسحوب من `public/anon/authenticated` (و`service_role` يملكه لأن CHECK يُنفَّذ بصلاحية الكاتب)                                |
| `public.notification_transport_secrets`    | **CipherSuite فقط** (`bytea` + nonce + بصمة)                                       | RLS مُجبر · **صفر سياسات RLS إطلاقاً** · صفر قراءة لأي دور API · `service_role` = `select/insert/update` فقط · خارج Realtime |
| `public.notification_encryption_keys`      | سجل **غير سرّي** لأين تعيش مفاتيح التشفير (vault/external)                         | RLS مُجبر · صفر سياسات · `select` لـ `service_role` فقط                                                                      |
| `guard_notification_transport_writes()`    | يمنع التفعيل بلا اعتماد، ويمنع ناقلين افتراضيين مُفعَّلين                          | `22023` + تفصيل «field: …» فقط                                                                                               |
| `guard_notification_secret_writes()`       | فحص بنيوي للـ AEAD + رفض السرّ المُخزَّن كنص صريح + منع الكتابة الصامتة            | `22023`                                                                                                                      |
| `guard_app_settings_reserved_keys()`       | يمنع `email.*` / `smtp.*` / `mail.*` / `notifications.smtp*` في KV                 | `MAIL4`                                                                                                                      |
| `can_manage_email_transport()`             | بوابة الصلاحية (`settings.manage`)                                                 | `security definer` + `set search_path`                                                                                       |
| `admin_get_email_transport()`              | لقطة **مقنَّعة** (بلا ciphertext، بصمة 8 خانات، `has_password`)                    | `authenticated` فقط                                                                                                          |
| `admin_update_email_transport(...)`        | مسار الكتابة **الوحيد** للناقل (قفل تفاؤلي)                                        | `authenticated` فقط                                                                                                          |
| `admin_set_email_password(...)`            | المسار A: تشفير داخل القاعدة عبر `pgsodium` + `vault`                              | `authenticated` فقط                                                                                                          |
| `admin_store_email_secret(...)`            | المسار B: العامل يخزّن ciphertext جاهزاً                                           | `service_role` فقط                                                                                                           |
| `admin_clear_email_password()`             | مسح صريح + تعطيل الناقل                                                            | `authenticated` فقط                                                                                                          |

---

## 1) المتطلبات

- Node.js ≥ 22.12 و`npm ci` (للتحقق من الأنواع/اللينت/الاختبارات).
- **أحد مسارين** لقاعدة البيانات:
  - **المسار السريع (موصى به للتحقق الشامل):** Supabase CLI محلي (`supabase db start`) — فيه `pgsodium` و`vault`.
  - **المسار المعزول (نفس ما تستخدمه المرآة):** PostgreSQL 17 مدمج على socket محلي بلا TCP (القسم 4).

| `public.notification_templates` | القوالب: صف لكل (مفتاح · لغة · إصدار)، ثنائي اللغة بالصفوف | RLS مُجبر · سياسة قراءة واحدة · **صفر سياسة كتابة** |
| `guard_notification_template_writes()` | يجمّد النشط والمرشَّف، ويمنع حذف غير المسودات | `22023` + `field: status` |
| `can_manage_notification_templates()` | بوابة `notifications.manage` (محرّر محتوى بلا مفاتيح) | `security definer` |
| `admin_list_notification_templates()` | RPC `SECURITY DEFINER` (لا قراءة مباشرة) | تحترم السياسة: مسودات الغير مخفية |
| `admin_upsert_notification_template_draft(...)` | إنشاء/تحرير مسودة (`version = max+1`) | `TPL01/TPL04/TPL05` + `22023` |
| `admin_publish_notification_template(...)` | نشر ذرّي (الأقدم ⇒ `archived`) | `TPL01…TPL05/22023` |
| `admin_rollback_notification_template(...)` | قلب `is_current` إلى إصدار منشور سابق | `22023` |
| `admin_delete_notification_template_draft(...)` | حذف **مسودة فقط** | `22023` |
| `admin_render_notification(...,'preview'\|'delivery')` | العارض **stable** بلا كتابة، والعقد واحد للمسارين | `TPL01/TPL02/TPL03` |
| `admin_preview_notification_template(...)` | غلاف المعاينة المُدقَّق (`notification.template_previewed`) | `42501` + سجل تدقيق |

### الانحرافات المقبولة (مثبَّتة في الكود)

| #   | الانحراف                                                                                                                    | المبرر                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | `admin_render_notification` **نقية `stable` بلا كتابة**، وسجل المعاينة في غلاف متطاير `admin_preview_notification_template` | §2.4 يشترط أن يكون العرض قابلاً للتكرار بلا آثار (1000 استدعاء = بصمة واحدة)، و§3.5 يريد صف تدقيق للمعاينة؛ الغلاف يوفّق بينهما                                                                                                |
| 2   | `admin_list_notification_templates` **RPC `SECURITY DEFINER`** بدل قراءة SQL مباشرة                                         | سطح كتابة/قراءة أضيق، وتصفية صريحة للمسودات، والعميل لا يحتاج منحاً أوسع                                                                                                                                                       |
| 3   | `config` محصور في `{headers}` اليوم                                                                                         | مصدر حقيقة واحد: المفاتيح التشغيلية أعمدة مكتوبة؛ تفادي ازدواج `daily_quota` بين عمود وJSON                                                                                                                                    |
| 4   | `admin_render_notification(..., 'delivery')` لا يُستدعى من المتصفح                                                          | `42501` لأي دور يحمل `authenticated` في JWT، و`service_role`/جلسة مشغّل فقط (فحص آلي يثبت الحالتين)                                                                                                                            |
| 5   | كل نداءات `pgcrypto` **مُطلَقة بالمخطط**: `extensions.digest(...)` · `extensions.gen_random_bytes(...)`                     | Supabase تثبّت `pgcrypto` في مخطط `extensions`، وهذا المخطط **ليس** على `search_path` أثناء الترحيل؛ النداء غير المُطلَق يفشل بـ `42883 function digest(text, unknown) does not exist` (اكتشفه CI في خطوة `supabase db start`) |

> **A16 في هذه المرحلة = طبقة قاعدة البيانات فقط:** جدول القوالب منشور على `supabase_realtime` وجداول الأسرار/الناقلات/المفاتيح مستثناة.
> أما «الإبطال + اللافتة» فهما سلوك واجهة (المرحلة 4) وغير مكتوبين هنا عمداً.

---

---

## 2) المسار السريع: Supabase محلي

```bash
# 0) أدوات المشروع
npm ci

# 1) قاعدة محلية نظيفة = إعادة تشغيل كل الترحيلات + seed
supabase db start
supabase db reset --local

# 2) فحص الأجسام (plpgsql_check) — بوابة CI نفسها
supabase db lint --local --level warning --fail-on error
```

المتوقع: `db reset` يمر بلا خطأ (بما فيه مسار `pgsodium`/`vault`)، و`db lint` بلا أخطاء.
الدالة `admin_set_email_password` تستدعي `pgsodium`/`vault` **عبر SQL ديناميكي** متعمَّد،
لذلك لا يفشل الفحص الثابت حين تكون الإضافتان غائبتين (Path B).

### 2.1 فحوص قبول سريعة بـ `psql`

```bash
DB=postgresql://postgres:postgres@127.0.0.1:54322/postgres

# (أ) الجداول الثلاثة: RLS مُفعَّل ومُجبَر
psql "$DB" -c "select relname, relrowsecurity, relforcerowsecurity from pg_class
 where oid in ('public.notification_transports'::regclass,
               'public.notification_transport_secrets'::regclass,
               'public.notification_encryption_keys'::regclass);"

# (ب) جدول الأسرار: صفر سياسات RLS (هذا هو القرار، وقد يكون غيابها مفاجئاً لمن يراجع لاحقاً)
psql "$DB" -c "select count(*) as policies from pg_policy
 where polrelid = 'public.notification_transport_secrets'::regclass;"   -- النتيجة: 0

# (ج) لا أعمدة jsonb في جدول الناقلات
psql "$DB" -c "select count(*) as jsonb_columns from pg_attribute a
 join pg_type t on t.oid = a.atttypid
 where a.attrelid = 'public.notification_transports'::regclass
   and a.attnum > 0 and not a.attisdropped and t.typname = 'jsonb';"    -- النتيجة: 0

# (د) دور anon لا يقرأ ولا ينفّذ شيئاً
psql "$DB" -c "select has_table_privilege('anon','public.notification_transport_secrets','select') as anon_select,
                      has_function_privilege('anon','public.admin_get_email_transport()','execute') as anon_rpc;"
# النتيجة: false / false

# (هـ) قيم التدقيق الجديدة في ذيل الـ enum
psql "$DB" -c "select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
 where t.typname = 'audit_action' and e.enumlabel like 'email.%';"

# (و) الأسرار خارج Realtime
psql "$DB" -c "select tablename from pg_publication_tables
 where pubname = 'supabase_realtime' and tablename like 'notification%';"  -- النتيجة: صفر صفوف
```

### 2.2 سيناريو يدوي كامل (RLS + RPC) على Supabase محلي

نفّذ داخل `psql` وأنت **لست** superuser لتختبر RLS فعلياً:

```sql
-- 1) ادّعِ هوية مستخدم مصادَق (في Supabase المحلي: role authenticated + claim)
set role authenticated;
select set_config('request.jwt.claim.sub', '<uuid مستخدم إداري نشط>', true);

-- 2) قراءة مقنّعة (ينجح مع settings.manage)
select public.admin_get_email_transport();

-- 3) محاولة كتابة مباشرة على الجدول (تفشل 42501 — الغياب هو الرفض)
select * from public.notification_transport_secrets;           -- 42501

-- 4) تحديث ناقل بقيمة غير صالحة: رسالة بلا قيمة، والتفصيل اسم حقل فقط
select public.admin_update_email_transport(p_slug := 'default-smtp', p_host := 'bad host');  -- 22023 / field: host

-- 5) تفعيل بلا اعتماد: مرفوض
select public.admin_update_email_transport(p_slug := 'default-smtp', p_is_enabled := true);  -- 22023 / field: is_enabled

-- 6) قفل تفاؤلي قديم
select public.admin_update_email_transport(p_slug := 'default-smtp',
       p_expected_updated_at := '2026-01-01T00:00:00Z');                                     -- MAIL1

-- 7) تخزين الاعتماد (المسار A: يعمل إن كان pgsodium+vault متاحين)
select public.admin_set_email_password('correct-horse-battery-staple');                       -- fingerprint 8 خانات

-- 8) تخزين سرّ في KV: مرفوض
insert into public.app_settings(key, group_slug, value, is_public)
values ('notifications.smtp_password', 'notifications', '"x"'::jsonb, false);                 -- MAIL4

-- 9) تحقق أن البصمة الكاملة لا تُسجَّل في التدقيق
select metadata from public.audit_logs where action in
  ('email.transport_updated','email.credentials_rotated') order by id desc limit 3;
```

---

## 3) التحقق من الأنواع والجودة (بلا قاعدة)

```bash
npm run typecheck     # يجب أن يمر
npm run lint          # يجب أن يمر
npm run test          # 138 اختبار vitest
npm run format:check  # prettier

# بعد ربط المشروع (linked) لتوليد الأنواع الكاملة النهائية:
npm run db:types      # ← يكتب الآن إلى src/lib/database.types.ts
```

> الملاحظة: الملف `src/lib/database.types.ts` المُرفَق هو **شريحة المرحلة 1** بصيغة
> مُولِّد Supabase حرفياً (الجداول الثلاثة + الدوال + قيم `audit_action`).
> أمر `npm run db:types` يستبدله بالملف الكامل المولَّد من المشروع المرتبط، وهو المسار المعتمد
> قبل المرحلة 4. المسار كان سابقاً `src/types/` في `package.json` وتم توحيده على
> `src/lib/database.types.ts` لأنه المسار المطلوب في اتفاقية المشروع.

---

## 4) المسار المعزول: مرآة الفحص `scripts/audit/database.mjs`

هذا هو نفس المسار الذي استُخدم في تقرير التدقيق، **بلا TCP وبلا أي سرّ**:

```bash
npm install --prefix .cache/live-audit/tooling --package-lock=false --no-audit --no-fund \
  @embedded-postgres/linux-x64@17.10.0-beta.17 pg@8.20.0

native="$PWD/.cache/live-audit/tooling/node_modules/@embedded-postgres/linux-x64/native"
export LD_LIBRARY_PATH="$native/lib"
mkdir -p .cache/live-audit/pg-data .cache/live-audit/pg-socket
# initdb مرة واحدة فقط عند إنشاء العنقود
"$native/bin/initdb" -D "$PWD/.cache/live-audit/pg-data" -U postgres --auth=trust --encoding=UTF8 --locale=C

# ثم، في طرفية أولى دائمة العمل:
"$native/bin/postgres" -D "$PWD/.cache/live-audit/pg-data" -h '' \
  -k "$PWD/.cache/live-audit/pg-socket" -p 55432 -c wal_level=logical

# وفي طرفية ثانية:
node scripts/audit/database.mjs --reset-fixture
```

**النتيجة المتوقعة:** `34 database checks passed` (كانت 18 فحصاً قبل هذين الترحيلين).

> **مرآة المنصة (مهمة):** ملف التجهيز `scripts/audit/supabase-fixture.sql` يثبّت الآن `pgcrypto` في مخطط `extensions`
> ويُبقي هذا المخطط خارج `search_path` — تماماً كما تفعل Supabase. لذلك أي نداء `pgcrypto` غير مُطلَق بالمخطط يفشل
> محلياً بـ `42883` قبل أن يصل إلى CI. تحقّق سريع من الفرق على قاعدة الفحص:
>
> ```sql
> show search_path;                                    -- "$user", public
> select digest('x','sha256');                         -- 42883 (يفشل)
> select extensions.digest('x','sha256');              -- يعمل
> select n.nspname from pg_extension e join pg_namespace n on n.oid = e.extnamespace
>  where e.extname = 'pgcrypto';                       -- extensions
> ```
>
> سبب الانحراف عن «عنقود عارٍ»: العنقود العاري يثبّت `pgcrypto` في `public` فيُخفي العطل الذي أسقط خطوة
> `supabase db start` في CI. المرآة الحالية هي ما يمنع تكراره.

الفحوص الجديدة (7 في المرحلة 1، و11 في المرحلة 2):

1. `notification carriers are typed, RLS-forced, and unreachable without an RPC`
2. `transport capability and the masked snapshot obey settings.manage`
3. `transport RPC validates fields, locks optimistically, and audits names only`
4. `reserved KV namespaces and plaintext-shaped secrets are rejected`
5. `credential rotation is deterministic and never leaks a value`
6. `path A encrypts in-database when vault material is available (contract stub)`

> **بديل تعاقدي (stub):** عنقود الفحص لا يحتوي `pgsodium` ولا `vault`، لذلك يسجّل الترحيل
> المفتاح `external` (المسار B) ويجب أن يعيد `admin_set_email_password` رمز `MAIL3`.
> الفحص السادس ينشئ `pgsodium.crypto_secretbox` و`vault.decrypted_secrets` **وهميين**
> (كـ `cron.schedule` الوهمي في `supabase-fixture.sql` بالضبط) ليثبت أن مسار A يعمل من طرفه
> إلى طرفه، وأن كلمة المرور **لا تدخل** إلى vault.secrets ولا إلى التدقيق ولا إلى رسائل الخطأ.
> التشفير الحقيقي يُفحص في CI عبر صورة Supabase التي تحوي الإضافتين.

---

## 4.1) تحقق المرحلة 2 تحديداً (بذور + دورة حياة + حقن)

```sql
-- 0) يجب أن تكون ست بذور نشطة (3 مفاتيح × لغتان)
select key, locale, version, status, is_current from public.notification_templates order by key, locale;
-- المتوقع: 6 صفوف، كلها version=1 / active / is_current=true

-- 1) بصمة كل بذرة = بصمة الدالة القانونية نفسها (يطابقها الفحص الآلي)
select t.key, t.locale,
       t.content_hash = public.notification_template_content_hash(
         t.subject, t.body_text, t.body_html, t.variables) as hash_ok
  from public.notification_templates t;

-- 2) المعاينة تعمل من بيانات العيّنة المُلغَّمة (بلا PII)
select public.admin_preview_notification_template('auth.welcome_invitation','ar');

-- 3) تحرير مسودة ⇒ نشر ⇒ تراجع (كلها ذرّية ومُدقَّلة)
select public.admin_upsert_notification_template_draft(
  p_key := 'auth.welcome_invitation', p_locale := 'ar',
  p_subject := 'نسخة جديدة {{user_name}}',
  p_body_text := 'مرحباً {{user_name}}',
  p_body_html := '<p>مرحباً {{user_name}}</p>',
  p_variables := '[{"name":"user_name","type":"text","required":true,"max_length":120}]'::jsonb,
  p_sample_variables := '{"user_name":"لينا"}'::jsonb);
select public.admin_publish_notification_template('auth.welcome_invitation','ar',2);
select public.admin_rollback_notification_template('auth.welcome_invitation','ar',1);

-- 4) الحارس: تعديل المنشور مباشرة مرفوض (22023 / field: status)
update public.notification_templates set subject = 'hacked'
 where key='backup.failure_notice' and locale='ar' and status='active';

-- 5) نسختان نشطتان لنفس (key, locale) مرفوضتان
--    المتوقع: 23505 على notification_templates_active_current_idx

-- 6) الأمان: TPL05 للمحجوز، TPL01 للغريب/البنية، TPL04 لـ HTML
select public.admin_upsert_notification_template_draft(
  p_key := 'probe.tokens', p_locale := 'ar', p_subject := 'probe',
  p_body_text := '{{smtp_password}}');
select public.admin_upsert_notification_template_draft(
  p_key := 'probe.tokens', p_locale := 'ar', p_subject := 'probe',
  p_body_text := '{{{app_name}}}');
select public.admin_upsert_notification_template_draft(
  p_key := 'probe.html', p_locale := 'ar', p_subject := 'probe',
  p_body_text := 'safe', p_body_html := '<p onclick="x()">a</p>');

-- 7) التهريب: قيمة متغير شريرة تخرج مُهرَّبة
select public.admin_render_notification(
  'security.suspension_alert','ar',
  '{"user_name":"</td><script>alert(1)</script>","app_name":"App","admin_name":"A",
    "reason_code":"R","effective_at":"2026-10-02T09:00:00Z",
    "appeal_url":"https://app.example.invalid/x"}'::jsonb,
  'delivery');
-- المتوقع: لا '<script>' في body_html، ويظهر كـ &lt;/td&gt;

-- 8) تفاصيل خطأ القيمة: اسم الحقل فقط، ولا قيمة
select public.admin_render_notification('auth.welcome_invitation','en',
  '{"user_name":"x","app_name":"y","action_url":"http://insecure.invalid/z",
    "expires_at":"2026-10-09T12:00:00Z","support_email":"s@example.invalid"}'::jsonb,'preview');
-- المتوقع: TPL02 + names: action_url (http مرفوض في url)
```

> **الفحوص الآلية المقابلة في المرآة (11 فحصاً جديداً في المرحلة 2):**
> `template table is RLS-forced…` · `A16: realtime…` · `seeded templates…` ·
> `template RPCs obey capabilities…` · `A7` · `A8` · `A9` · `A11/A12` · `render is capability-split…`
> بالإضافة إلى `carrier config is whitelisted…` لتعديل المرحلة 1 الجديد.

---

## 5) ما سيفعله CI عند الدفع

`.github/workflows/supabase-migration.yml` على كل PR:

1. `supabase db start` ثم `supabase db reset --local` → إعادة كل الترحيلات + seed.
2. `supabase db lint --level warning --fail-on error` → لا أخطاء في أجسام الدوال.
3. فحص «RLS مفعّل على كل جدول public» → الجداول الثلاثة مُجبرة ✓.
4. فحص «لا دالة SECURITY DEFINER متاحة لـ anon» → كل دوالنا مسحوبة من `public, anon` ✓.

على `main`: النشر عبر `supabase db push --linked` (Environment محمي).

---

## 6) جدول رموز الأخطاء (كما وردت في الدراسة ↔ SQLSTATE الفعلي)

| الرمز في الدراسة | SQLSTATE المستخدم | ملاحظة                                                        |
| ---------------- | ----------------- | ------------------------------------------------------------- |
| `42501`          | `42501`           | لا صلاحية (قياسي)                                             |
| `22023`          | `22023`           | قيمة/نمط غير مقبول — `detail = 'field: <name>'` فقط           |
| `MAIL01`         | `MAIL1`           | صراع قفل تفاؤلي (PostgreSQL يشترط 5 محارف بالضبط)             |
| `MAIL02`         | `MAIL2`           | بنية payload (slug مفقود / تعديل صف غير موجود)                |
| `MAIL03`         | `MAIL3`           | مادة التشفير غير متاحة — بلا أي تفاصيل                        |
| `MAIL04`         | `MAIL4`           | محاولة تخزين سرّ في `app_settings`                            |
| `TPL01`–`TPL05`  | `TPL01`–`TPL05`   | المرحلة 2 (5 محارف أصلاً)                                     |
| `SEC01`          | `SEC01`           | إصدار مفتاح غير متوافق / مصدر مفتاح غير مطابق (5 محارف أصلاً) |

كل رسالة خطأ تحمل **اسم الحقل فقط** ولا تحمل أي قيمة، وأي خطأ غير متوقع يُعاد رفعه برسالة
مُنقّاة (`email_config_update_failed` / `email_password_update_failed` / …) مع الحفاظ على `sqlstate`
(عقد §3.4). واختبار `SENTINEL-<uuid>` في المرآة يثبت أن القيمة **لا تظهر** في أي استجابة أو سجل.

---

## 7) مخارج المراجعة اليدوية المطلوبة منك

- [ ] تثبيت تسمية الجداول: الدراسة تقول `notification_transports` و`notification_transport_secrets`
      (وقد اتُّبعت حرفياً) بينما نصّ المهمة ذكر `notification_carriers` و`notification_secrets`.
- [ ] تثبيت إلغاء `config jsonb` في جدول الناقلات (اتُّخذ القرار: صفر jsonb، وكل المفاتيح أعمدة مكتوبة،
      والتمدد المستقبلي عبر عمود مكتوب أو جدول تابع — بلا فتحة jsonb).
- [ ] تثبيت أن `is_default` الافتراضي عند **إنشاء** ناقل جديد = `false` (الناقل الافتراضي يأتي من البذرة
      `default-smtp` أو بطلب صريح)، وأن التفعيل يتطلب وجود اعتماد مخزَّن.
- [ ] تثبيت أن مسار B (`admin_store_email_secret`) مضمَّن في المرحلة 1 لتفعيل rule 4 (مسار بديل آمن)،
      مع بقاء تشغيل الإرسال نفسه للمرحلة 3.
- [ ] تثبيت أن بذرة `default-smtp` (معطَّلة، `localhost:587`) مقصودة كحالة ابتدائية.

---

## 8) ما هو **مؤجَّل صراحةً** (لا تنفيذ في هذه المرحلة)

| البند                                                                                       | المرحلة                               |
| ------------------------------------------------------------------------------------------- | ------------------------------------- |
| `notification_templates` + الحارس + البذور الثلاثة + `admin_upsert/publish/rollback/render` | 2                                     |
| `can_manage_notification_templates()` وقراءة الناقل لحامل `notifications.manage`            | 2 (مع القوالب)                        |
| `admin_test_email_transport()` الفعلي (اتصال + مصادقة + إرسال)                              | 3 (workers) — لا خروج شبكي من القاعدة |
| واجهة الشاشة + Realtime invalidation + i18n                                                 | 4                                     |
| تدوير المفاتيح التشغيلي + تصدير/استيراد الحزمة                                              | 5                                     |
