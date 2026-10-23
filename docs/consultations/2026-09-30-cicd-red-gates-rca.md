# تقرير تشخيصي — البوابات الحمراء في GitHub Actions (30 سبتمبر 2026)

> **النطاق:** فرع `main` في `ym7296111-ops/admin_system` بعد الدمج `7c74d0f`.
> **الطريقة:** قراءة الـ Annotations الرسمية لكل تشغيل (وهي نفس النص الخام الذي طبعته الخطوة الفاشلة)،
> وفحص تعريف الـ Workflows، وفحص كائنات GitHub عبر REST API (البيئات، التشغيلات، الوظائف، الخطوات).
> **لا يوجد أي تخمين في هذا التقرير:** كل استنتاج أدناه مسنود إلى تشغيل ورقم خطوة ومخرَج حرفي.

---

## 0. الخلاصة التنفيذية (TL;DR)

| السؤال                                            | الجواب الحرفي                                                                                                                                                                           |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| هل السبب تعارض جداول (`relation already exists`)؟ | **لا.** لا يوجد أي خطأ SQL في أي تشغيل. لم يُنفَّذ `supabase db push` ولا مرّة على الإنتاج.                                                                                             |
| هل السبب فشل الاتصال بالـ Host؟                   | **لا.** `supabase link` كان `skipped` في كل التشغيلات الفاشلة؛ لا محاولة اتصال واحدة.                                                                                                   |
| هل السبب نقص كلمة مرور قاعدة البيانات؟            | **لا.** نفس الخطوة تفحص ثلاث قيم وتطبع الناقص فقط، وقد طبعت قيمة واحدة: `SUPABASE_PROJECT_REF`.                                                                                         |
| ما السبب الحقيقي؟                                 | **قيمة واحدة غير معرَّفة في بيئة GitHub: `SUPABASE_PROJECT_REF`** (لا في البيئة `Production` ولا على مستوى المستودع)، فتفشل بوابة `Verify configuration` قبل أي عمل على قاعدة البيانات. |
| حالة عامل النسخ الاحتياطي؟                        | **لم يعمل ولا مرّة (0 تشغيل).** أُنشئ 18:58:38Z أي بعد نافذة 02:00 في نفس اليوم. أول تشغيل مبرمج: 1 أكتوبر 2026 — 02:00 بتوقيت باريس.                                                   |
| هل أحتاج سكربت SQL لتصفير الأخطاء؟                | **لا.** الإصلاح ثلاث أوامر `gh` + إعادة تشغيل. الـ SQL في الملحق للتحقق وفي السيناريو البديل فقط.                                                                                       |
| هل الـ Migrations تحتاج تصحيحاً؟                  | **لا.** الستة ترحيلات نجحت مراراً على قاعدة مؤقتة في `test_and_lint` (12 تشغيل أخضر من 12).                                                                                             |

**السبب الجذري في سطر واحد:** `[ -n "$SUPABASE_PROJECT_REF" ] || missing+=('SUPABASE_PROJECT_REF')` —
القيمة فارغة وقت التشغيل، فالوظيفة `deploy_production` تفشل وتُسقط الـ Workflow كله إلى اللون الأحمر.

---

## 1. الأدلة الخام (Raw Evidence)

### 1.1 جدول التشغيلات الفاشلة السبعة

| #   | UTC      | SHA       | الحدث | الفرع            | الوظيفة                           | الخطوة التي توقّفت     | الرسالة الخام                                                                             |
| --- | -------- | --------- | ----- | ---------------- | --------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------- |
| 1   | 11:35:29 | `c71fed7` | PR    | `arena/01a0f1d0` | `Validate migrations (dry run)`   | `Verify configuration` | `Missing GitHub secrets: SUPABASE_ACCESS_TOKEN SUPABASE_DB_PASSWORD SUPABASE_PROJECT_REF` |
| 2   | 11:44:42 | `4734255` | push  | `main`           | `Apply migrations`                | `Verify configuration` | نفس الرسالة أعلاه                                                                         |
| 5   | 12:41:31 | `4c48950` | push  | `main`           | `Deploy migrations to production` | `Verify configuration` | `Missing secrets in the "production" environment: SUPABASE_PROJECT_REF`                   |
| 8   | 15:34:45 | `a13e647` | push  | `main`           | `Deploy migrations to production` | `Verify configuration` | نفس الرسالة أعلاه                                                                         |
| 11  | 17:21:16 | `e009a63` | push  | `main`           | `Deploy migrations to production` | `Verify configuration` | نفس الرسالة أعلاه                                                                         |
| 14  | 17:53:00 | `a10e890` | push  | `main`           | `Deploy migrations to production` | `Verify configuration` | نفس الرسالة أعلاه                                                                         |
| 17  | 18:58:40 | `7c74d0f` | push  | `main`           | `Deploy migrations to production` | `Verify configuration` | نفس الرسالة أعلاه                                                                         |

> لاحظ الفرق بين الحقبتين: في #1 و#2 كانت الأسرار الثلاثة على مستوى المستودع وغير موجودة إطلاقاً.
> بعد نقلها إلى بيئة GitHub (التشغيل #5 وما بعده) صار الناقص **قيمة واحدة فقط** — وهي حالة اليوم.

### 1.2 النص الخام لتشغيل الإنتاج #17 (آخر تشغيل على `main`)

```text
[failure] Missing secrets in the "production" environment: SUPABASE_PROJECT_REF
[failure] Process completed with exit code 1.
[warning] Could not read the remote migration list.
[notice]  "The ubuntu-latest label will migrate to Ubuntu 26 beginning October 19, 2026. ..."
```

### 1.3 حالة الخطوات في التشغيل #17 (دليل مباشر على أن قاعدة البيانات لم تُلمس)

| الخطوة                        | النتيجة                  |
| ----------------------------- | ------------------------ |
| 3. `Verify configuration`     | **failure**              |
| 4. `Install Supabase CLI`     | skipped                  |
| 5. `Link project`             | **skipped**              |
| 6. `Repair migration history` | skipped                  |
| 7. `Push migrations`          | **skipped**              |
| 8. `Publish migration report` | success (`if: always()`) |

وبالتوازي: الوظيفة `Test migrations on an ephemeral database` كانت **success** في كل تشغيلات `main` السبعة
(`supabase db start` ← `supabase db reset` ← `db lint` ← فحص RLS ← فحص `SECURITY DEFINER`)،
أي أن ملفات الترحيل الستة + `seed.sql` تُطبَّق نظيفة من الصفر على PostgreSQL 17:

```
20260930000000_init_core_schema.sql
20260930120000_harden_profiles_and_definer_functions.sql
20260930150000_enable_profiles_realtime.sql
20260930160000_rbac_atomic_operations.sql
20260930170000_backup_system_schema.sql
20260930180000_backup_atomic_lock.sql
```

### 1.4 أوامر إعادة إنتاج الأدلة (للتحقق المستقل)

```bash
gh run list --branch main --limit 20
gh run view 36762408950 --json jobs      # أرقام الخطوات ونتائجها
gh api repos/ym7296111-ops/admin_system/check-runs/110061846148/annotations
gh api repos/ym7296111-ops/admin_system/environments
```

---

## 2. الحالة الأولى — Supabase Migrations (الإنتاج)

### 2.1 أين تفشل بالضبط؟

في ملف `.github/workflows/supabase-migration.yml` → الوظيفة `deploy_production` → الخطوة `Verify configuration`:

```bash
# السطر المتسبب — القيمة فارغة وقت التشغيل
[ -n "$SUPABASE_PROJECT_REF" ] || missing+=('SUPABASE_PROJECT_REF')

if [ ${#missing[@]} -gt 0 ]; then
  printf '::error::Missing secrets in the "production" environment: %s\n' "${missing[*]}"
  exit 1
fi
```

القيمة تُشتق من: `SUPABASE_PROJECT_REF: ${{ vars.SUPABASE_PROJECT_REF || secrets.SUPABASE_PROJECT_REF }}`
وعندما تكون غير معرَّفة أبداً (لا كمتغير `vars` ولا كسر `secrets`) يصل المتغيّر فارغاً ويُطبع الاسم الناقص.

### 2.2 استبعاد الفرضيات الثلاث (بالدليل)

| الفرضية                                | الحكم      | الدليل                                                                                                                                                   |
| -------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `relation already exists`              | ❌ مستبعدة | `Push migrations` كانت `skipped`؛ لم يُنفَّذ أي أمر على الإنتاج. كذلك نجاح إعادة تشغيل كل الترحيلات محلياً يثبت أنها لا تتصادم من الصفر.                 |
| فشل الاتصال بالـ Host (IPv6/شبكة)      | ❌ مستبعدة | `Link project` كانت `skipped`. الخطوة التي قد تنتج أخطاء شبكة لم تُنفَّذ إطلاقاً.                                                                        |
| نقص كلمة المرور `SUPABASE_DB_PASSWORD` | ❌ مستبعدة | الرسالة تطبع **كل** الناقص، وطبعت `SUPABASE_PROJECT_REF` وحده ⇒ `SUPABASE_ACCESS_TOKEN` و`SUPABASE_DB_PASSWORD` موجودان ومُستخدمان فعلاً في نفس الوظيفة. |

### 2.3 إبطال «الشبهة» المتعلقة بحالة الأحرف

الـ Workflow يطلب `environment: production` (حروف صغيرة) بينما المستودع يعرّف البيئة باسم
`Production` (حرف كبير) — وهذا **ليس السبب**، لسببين مسنودين:

1. توثيق GitHub الرسمي: _"Environment names are not case sensitive"_ (والاسم الفعلي المُحلَّل هو `Production`).
2. لو كان الاسم لا يُطابق لكانت الأسرار الثلاثة كلها ناقصة، لكن الواقع أن سرّي `SUPABASE_ACCESS_TOKEN` و
   `SUPABASE_DB_PASSWORD` قُرِئا بنجاح من نفس البيئة في نفس الوظيفة.

ورغم ذلك تم توحيد الاسم في الـ Workflows إلى `Production` (انظر §6) لإزالة أي التباس مستقبلي،
لأن الـ Deployments API وبعض واجهات حماية البيئة تتعامل مع الاسم بحساسية حالة أحرف.

### 2.4 الخطر الوحيد المتبقّي بعد إضافة القيمة

بمجرد وجود `SUPABASE_PROJECT_REF` سينتقل الفشل المحتمل (إن وُجد) إلى `supabase db push`:
إذا كانت الجداول قد أُنشئت يدوياً من SQL Editor في لوحة Supabase بينما سجل الترحيلات
`supabase_migrations.schema_migrations` فارغاً، فحينها **فقط** سيظهر
`relation "profiles" already exists`. هذا السيناريو مغطّى في §5.4 بخطوتين: فحص ثم إصلاح سجل الترحيلات.

---

## 3. الحالة الثانية — Database Backup Worker

### 3.1 الحالة الفعلية الآن

| البند                    | القيمة                                                                         |
| ------------------------ | ------------------------------------------------------------------------------ |
| عدد التشغيلات            | **صفر** (`gh run list --workflow=database-backup-worker.yml` → `[]`)           |
| تاريخ تسجيل الـ Workflow | `2026-09-30T18:58:38Z` (دقيقتان قبل تشغيل #17 للترحيلات)                       |
| الحالة                   | `active` (ليس معطّلاً — لا مشكلة `disabled_inactivity`)                        |
| أول تشغيل مبرمج          | `0 2 * * *` بتوقيت `Europe/Paris` ⇒ **1 أكتوبر 2026، 02:00 باريس = 00:00 UTC** |

### 3.2 أين سيتوقف عند أول تشغيل؟ (وليس: أين توقف)

لأنه لم يعمل بعد، فالسؤال «هل توقف في الـ Claim أم الـ `pg_dump` أم الرفع؟» جوابه:
**لا هذا ولا ذاك — سيتوقف قبل الثلاثة جميعاً في بوابة التحقق المسبق `Verify configuration`.**

السبب: نفس القيمة الناقصة `SUPABASE_PROJECT_REF`، إضافة إلى قيمتين لا وجود مؤكد لهما بعد:
`SUPABASE_DB_HOST` و`SUPABASE_SERVICE_ROLE_KEY` (بوابة العامل تفحص الأربعة معاً
`SUPABASE_PROJECT_REF` + `SUPABASE_DB_HOST` + `SUPABASE_DB_PASSWORD` + `SUPABASE_SERVICE_ROLE_KEY`
وتطبع الناقص ثم `exit 1`).

والترتيب في الـ Workflow يجعل هذا حتمياً:

```
3. Verify configuration      ← البوابة (تفشل هنا)
4. Claim next backup job      (لم يُنفَّذ)  admin_claim_next_backup_job() عبر PostgREST
5. Install PostgreSQL client  (لم يُنفَّذ)
6. Export with pg_dump        (لم يُنفَّذ)  psql SHOW server_version_num ← pg_dump
7. Compress + checksum        (لم يُنفَّذ)
8. Upload to private storage  (لم يُنفَّذ)  private-backups/backups/<job-id>/backup.sql.gz
9. Mark job completed/failed  (لم يُنفَّذ)
```

### 3.3 المخاطر الحقيقية التي ستظهر في المراحل التالية (بعد ضبط الأسرار)

| #   | المرحلة                     | الشرط الصحيح                                                                        | العَرَض عند الخطأ                                                                                                                     |
| --- | --------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `Export with pg_dump`       | `SUPABASE_DB_HOST` = مضيف **Session Pooler** (`aws-0-<region>.pooler.supabase.com`) | `[stage=export] connection failed` — لأن `db.<ref>.supabase.co` صار IPv6 فقط وrunners لا تدعم IPv6 (ما لم يكن مشروعك يملك إضافة IPv4) |
| 2   | `Verify configuration`      | `SUPABASE_SERVICE_ROLE_KEY` بصيغة `sb_secret_...` أو JWT بدور `service_role`        | رسالة صريحة: المفتاح JWT لكن ليس `service_role` (الخطأ الشائع: لصق مفتاح `anon`)                                                      |
| 3   | `Claim next backup job`     | تطبيق الترحيل `20260930180000` (الدالة `admin_claim_next_backup_job`) وسجل فارغ     | `HTTP 404` مع إرشاد الـ Workflow نفسه للتحقق من الترحيل                                                                               |
| 4   | `Upload to private storage` | وجود الـ Bucket `private-backups` (ينشئه الترحيل `20260930170000`)                  | `Storage rejected the upload (HTTP 404/400)`                                                                                          |
| 5   | `Export with pg_dump`       | تطابق `PG_MAJOR=17` مع نسخة الخادم                                                  | الـ Workflow يفحص `server_version_num` ويشرح الفرق بنفسه                                                                              |
| 6   | `Claim` عند عدم وجود عمل    | لا شيء                                                                              | ينتهي التشغيل **بنجاح** مع `::notice::No jobs to process` — لا تفشل الليلةَ دون سبب                                                   |

> مفتاح الـ Bucket والـ RPC مقيّدان بـ `service_role` فقط (`grant execute ... to service_role`)،
> وهذا صحيح أمنياً: عامل النسخ الاحتياطي هو المستدعي الوحيد.

---

## 4. السبب الجذري منفصلاً لكل حالة

| الحالة                                    | السبب الجذري                                                                               | التصنيف                                            | الأثر                                                     |
| ----------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------------------- |
| `Supabase Migrations` × 5 (وما قبلها × 2) | قيمة `SUPABASE_PROJECT_REF` غير معرَّفة في بيئة GitHub `Production` ولا على مستوى المستودع | **إعداد بيئة (Configuration) — ليس كوداً ولا SQL** | فشل بوابة الإنتاج؛ لم يصل أي شيء إلى قاعدة بيانات الإنتاج |
| `Database Backup Worker`                  | لم يعمل بعد (لم يحن موعده) — وسيفشل بنفس السبب عند أول تشغيل                               | إعداد بيئة + توقيت                                 | لا نسخة احتياطية واحدة حتى الآن                           |
| `CI` (نجح 12/12)                          | —                                                                                          | —                                                  | لا علاقة له بالمشكلة                                      |

**ملاحظة حاكمة:** الـ CI (Lint/Typecheck/Test/Build) أخضر بالكامل، و`test_and_lint` أخضر بالكامل؛
المشكلة الوحيدة في المستودع هي **مفتاح إعداد واحد ناقص**، لا شيء غير ذلك.

---

## 5. العلاج الفوري (Hotfix)

### 5.1 الإصلاح الأدنى (دقيقتان) — أوامر جاهزة

نفّذها من جهازك بحساب يملك صلاحية `admin` على المستودع:

```bash
# 1) القيمة التي تُسقط البوابة الحمراء (Project Settings -> General -> Reference ID)
gh variable set SUPABASE_PROJECT_REF --env Production --body 'abcdefghijklmnopqrst'   # 20 حرفاً/رقماً

# 2) متطلبات عامل النسخ الاحتياطي (لا تؤثر على الترحيلات)
gh variable set SUPABASE_DB_HOST --env Production --body 'aws-0-eu-central-1.pooler.supabase.com'
gh secret   set SUPABASE_SERVICE_ROLE_KEY --env Production --body 'sb_secret_...'

# (SUPABASE_ACCESS_TOKEN و SUPABASE_DB_PASSWORD موجودان فعلاً في البيئة — لا حاجة لإعادتهما)
```

### 5.2 سكربت الإصلاح والتحقق الجاهز

أُضيف في هذا الـ PR: `scripts/configure-production-environment.sh`

```bash
./scripts/configure-production-environment.sh --check            # قراءة فقط: ما الموجود وما الناقص
./scripts/configure-production-environment.sh --apply --project-ref <ref> \
    --db-host aws-0-<region>.pooler.supabase.com --service-role-key sb_secret_...
./scripts/configure-production-environment.sh --run              # تشغيل Dry Run فوراً وطباعة رابط التشغيل
```

السكربت: يعرض البيئة التي تُحلّ فعلياً (مع مسألة حالة الأحرف)، يتحقق من الصيغة قبل الكتابة
(`^[a-z0-9]{20}$`)، يكتب القيم الناقصة فقط (idempotent)، ولا يطبع أي قيمة سرية في المخرجات.

### 5.3 التحقق بالترتيب الآمن (Dry Run ← Push)

```bash
# أ) تشغيل جاف: يعرض الترحيلات المعلّقة دون تطبيق أي شيء
gh workflow run supabase-migration.yml --ref main -f dry_run=true

# ب) بعد أن يصبح (أ) أخضر: التطبيق الفعلي
gh workflow run supabase-migration.yml --ref main -f dry_run=false

# ج) المراقبة والنتيجة
gh run list --branch main --workflow supabase-migration.yml --limit 3
```

### 5.4 السيناريو البديل — إذا ظهر `relation already exists` بعد الإصلاح

هذا يعني أن الكائنات موجودة فعلاً في الإنتاج لكن سجل الترحيلات فارغ.
**افحص أولاً** (Supabase SQL Editor):

```sql
-- ما الذي يعرفه المشروع عن الترحيلات؟
select version, name from supabase_migrations.schema_migrations order by version;

-- هل الجداول موجودة فعلاً؟
select table_name from information_schema.tables
where table_schema = 'public' order by table_name;
```

**ثم اختر الإصلاح المناسب:**

- **الطريقة المفضّلة (CLI عبر الـ Workflow):** شغّل الـ Workflow يدوياً مع
  `mark_applied = 20260930000000,20260930120000,...` ليعامل الترحيلات المطبَّقة كمنتهية، ثم أعد `db push`.
- **بديل SQL مباشر** (نفس أثر `supabase migration repair --status applied`) — نفّذه **فقط** وسكربت التحقق أعلاه
  يؤكد وجود الجداول:

```sql
insert into supabase_migrations.schema_migrations (version)
values
  ('20260930000000'),
  ('20260930120000'),
  ('20260930150000'),
  ('20260930160000'),
  ('20260930170000'),
  ('20260930180000')
on conflict (version) do nothing;
```

- **إذا كان الترحيل مطبَّقاً جزئياً** — لا تستخدم `mark_applied`؛ نظّف الجزء المطبَّق يدوياً
  (`drop ...` للكائنات ناقصة التطبيق) ثم أعد `db push` نظيفاً، أو استخدم `--include-all` مع
  مراجعة يدوية لكل ترحيل.

### 5.5 تهيئة عامل النسخ الاحتياطي واختباره فوراً

```sql
-- (اختياري) إدخال وظيفة نسخ احتياطي يدوية في الطابور لاختبار العامل فوراً
-- الجدول محمي بـ RLS، وتنفيذ الاستعلام من SQL Editor بصلاحية المالك يتجاوزها
insert into public.backup_logs (backup_type, status) values ('manual', 'queued')
returning id, requested_at, status;

-- التحقق من عدم وجود وظيفة عالقة (فهرس فريد يسمح بوظيفة نشطة واحدة فقط)
select id, status, started_at, requested_at, error_summary
from public.backup_logs order by requested_at desc limit 10;
```

ثم:

```bash
gh workflow run database-backup-worker.yml --ref main
gh run watch "$(gh run list --workflow=database-backup-worker.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

النتيجة الصحيحة لليلة بلا طلبات: تشغيل **أخضر** مع `::notice title=Database backup worker::No jobs to process`.

### 5.6 تصفير وظيفة عالقة في الطابور (Unstick)

يوجد فهرس فريد `backup_logs_one_active_request_idx` يمنع أكثر من وظيفة نشطة؛ أي صف `running`
مُهجَر يُستعاد تلقائياً بعد ساعتين داخل `admin_claim_next_backup_job()`.
في الطوارئ فقط:

```sql
update public.backup_logs
set status = 'failed',
    error_summary = 'manual reset from SQL editor'
where status in ('queued', 'running');
-- finished_at يُختم آلياً بواسطة trigger backup_logs_stamp_finished
```

### 5.7 ما تم تحصينه في الكود (هذا الـ PR)

| الملف                                         | التغيير                                                                      | الفائدة                                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `supabase-migration.yml`                      | توحيد `environment.name` إلى `Production`                                    | إزالة التباس حالة الأحرف في واجهات الإدارة/الـ Deployments API           |
| `supabase-migration.yml`                      | رسالة الفشل تطبع الآن أوامر `gh` الدقيقة للإصلاح + مسار السكربت              | لن يعيد أحد التحقيق في نفس الخطأ مرتين                                   |
| `supabase-migration.yml`                      | `--yes` على `supabase link` و`supabase migration repair` و`supabase db push` | منع أي توقف على مطالبة تفاعلية على runner غير تفاعلي (غير قادر على الرد) |
| `database-backup-worker.yml`                  | توحيد `environment.name` + رسالة إرشادية بأوامر الإصلاح                      | نفس الفائدة للعامل السحابي                                               |
| `scripts/configure-production-environment.sh` | سكربت إصلاح/تحقق idempotent                                                  | إصلاح من أمر واحد، مع فحص الصيغة وعدم طباعة الأسرار                      |
| `README.md`                                   | تحديث اسم البيئة وجدول متطلبات العامل                                        | مطابقة التوثيق للواقع                                                    |

---

## 6. مصفوفة القبول — كيف نعرف أن كل شيء أخضر

| البوابة                                             | الأمر                                                     | النتيجة المتوقعة                                                                   |
| --------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `CI`                                                | `gh run list --branch main --workflow=ci.yml --limit 3`   | `success` لكل تشغيل                                                                |
| `Supabase Migrations / test_and_lint`               | `gh run view <id>`                                        | `success` (كما هي الآن)                                                            |
| `Supabase Migrations / deploy_production` (Dry Run) | `gh workflow run supabase-migration.yml -f dry_run=true`  | `Verify configuration` ✅ → `Link project` ✅ → يطبع قائمة الترحيلات المعلّقة      |
| `Supabase Migrations / deploy_production` (Apply)   | `gh workflow run supabase-migration.yml -f dry_run=false` | `db push` ✅ + جدول حالة الترحيلات في `$GITHUB_STEP_SUMMARY`                       |
| `Database Backup Worker`                            | `gh workflow run database-backup-worker.yml --ref main`   | `success` مع `No jobs to process` (بلا طلبات) أو نسخة مرفوعة إلى `private-backups` |
| بيئة الإنتاج                                        | `gh api repos/ym7296111-ops/admin_system/environments`    | `Production` موجودة وبلا قواعد حماية معلّقة (كما هي)                               |

---

## 7. ملاحظات حوكمة وأمن (DevSecOps)

1. **لا تُضِف قيمة وهمية** لـ `SUPABASE_PROJECT_REF` لتخضير البوابة؛ الفحص التالي (`supabase link`) سيفشل
   برسالة أقل وضوحاً. البوابة الحمراء هنا **صحيحة**: الإنتاج لم يُهيَّأ بعد.
2. **لا تنقل الأسرار إلى مستوى المستودع؛** مستودع واحد + بيئة واحدة محمية أفضل من أسرار متاحة لكل وظيفة.
3. **فعّل Required reviewers على بيئة `Production`** إن أردت بوابة موافقة بشرية للترحيلات؛ حالياً
   `protection_rules` فارغة والـ `deployment_branch_policy` غير مقيَّد (تشغيل يدوي من أي فرع مرفوض داخل الـ Workflow
   عبر `if: github.ref == 'refs/heads/main'`، لكن التقييد من إعدادات البيئة طبقة دفاع إضافية).
4. **راجع صلاحية رمز الوصول في جلسة التحقيق:** رمز GitHub المستخدم في هذه الجلسة لا يملك صلاحية قراءة
   الأسرار (`HTTP 403: Resource not accessible by integration`)، لذا نُفِّذ الإصلاح على شكل سكربت جاهز
   تُشغّله أنت بحساب مسؤول — ولم يُطلَب منك ولن يُطلَب أي كلمة مرور أو رمز وصول في المحادثة.
5. **حدود المزامنة:** Workers هي "العامل الموثوق" الوحيد الذي يكتب إلى الـ Bucket الخاص، والـ UI يقرأ عبر
   Signed URLs؛ لا تغيّر سياسة RLS على `storage.objects` دون مراجعة أمنية.

---

## 8. الملحق — أوامر التحقيق المستخدمة فعلياً في هذا التشخيص

```bash
gh run list --branch main --limit 40 --json databaseId,name,conclusion,headSha
gh run view 36762408950 --json jobs
gh api repos/ym7296111-ops/admin_system/actions/runs/36762408950/jobs
gh api repos/ym7296111-ops/admin_system/check-runs/110061846148/annotations
gh api repos/ym7296111-ops/admin_system/actions/runs/36710416364/jobs
gh api repos/ym7296111-ops/admin_system/environments
gh api repos/ym7296111-ops/admin_system/actions/workflows
gh run list --workflow=database-backup-worker.yml --limit 20
```

> نص سجل الخطوة الخام (ملف `job-logs.txt`) يُقدَّم من تخزين Azure مؤقت قابل للتوقيع؛
> تعذّر تنزيله من بيئة التحقيق (`SSL_ERROR_SYSCALL` / `EOF` عند الاتصال بـ
> `productionresultssa3.blob.core.windows.net`)، وتم الاعتماد على الـ Annotations الرسمية
> التي تحمل **نفس النص الحرفي** الذي طبعته الخطوة الفاشلة — وهذا موثّق أعلاه نصاً بنص.
