# دليل الإنقاذ المُقترَح — تطهير سجل ترحيلات الإنتاج (Supabase Migrations)

| البند   | القيمة                                                                                                            |
| ------- | ----------------------------------------------------------------------------------------------------------------- |
| التاريخ | 2026-10-02 (UTC)                                                                                                  |
| الحالة  | **مُقترَح للاعتماد — لم يُنفَّذ منه أي أمر على الإنتاج بعد.** كل الأوامر أدناه تحتاج موافقة بشرية                 |
| النطاق  | `ym7296111-ops/admin_system` — البوابة `Supabase Migrations` الحمراء على `main`                                   |
| الأساس  | `.github/workflows/supabase-production-telemetry.yml` + `docs/consultations/2026-10-01-migration-workflow-rca.md` |

> **القاعدة الحاكمة (مأخوذة من دليل الطوارئ الحالي في المستودع، §3.1):**
> **لا تُطبَّق أي خطوة كتابة قبل اكتمال الخطوة 0 (القياس عن بُعد).** الخطوة 2 في أي «خطة تطهير»
> ليست إلا قراراً مشتقاً من مخرَج الخطوة 0، وليست خطوة مستقلة.

---

## 1. الحالة الفعلية المسنودة إلى أدلة

| الدليل                                                                                                             | المعنى                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| التشغيل [#44](https://github.com/ym7296111-ops/admin_system/actions/runs/36985535753) — `run_attempt: 3`           | الوظيفة `deploy_production` فشلت **ثلاث مرات** عند `Push migrations`، مدة الخطوة في المحاولة الأولى 3 ثوانٍ بالضبط (`08:44:31Z → 08:44:34Z`) ⇒ الـ CLI ينهار قبل/عند أول عبارة SQL لا بعد سلسلة تطبيق طويلة |
| `test_and_lint` في نفس التشغيل = **success**                                                                       | ملفات الترحيل التسعة سليمة على قاعدة نظيفة؛ العطل ليس في الكود                                                                                                                                              |
| ترويسة `supabase-production-telemetry.yml` (كُتبت بعد التشغيل)                                                     | فشل الدفع برسالة **`public.is_active_user() does not exist`** بينما السجل البعيد يقول إن `20260930120000` مطبَّق                                                                                            |
| ملفان في التاريخ: `d044252` (إنشاء) ثم `380747e` (حذف) للترحيل `20261002000000_fix_branding_rpc_array_literal.sql` | إن كان ذلك الإصدار قد سُجّل يوماً في الإنتاج فهو **إصدار يتيم** غير موجود محلياً                                                                                                                            |

**القراءة الحاسمة:** السجل البعيد لا يعكس المخطط الحقيقي — فيه صفوف «وهمية» تقول «مطبَّق» لكائنات غير
موجودة، وهذا **بالضبط** ما يُفشل `db push` بسرعة: `supabase db push` يقارن السجل قبل تنفيذ أي SQL.

---

## 2. الخطوة 0 — القياس عن بُعد (قراءة فقط، إلزامية)

```bash
# أ) تشغيل القياس (read-only: لا يكتب أي شيء في الإنتاج)
gh workflow run supabase-production-telemetry.yml --ref main

# ب) متابعة التشغيل وقراءة ملخّصه
gh run list --workflow=supabase-production-telemetry.yml --limit 1
gh run view <run-id>          # افتح Job Summary
```

يجب أن تقرأ في الملخّص **ثلاثة مخرجات**:

1. `supabase migration list --linked` → أي الإصدارات في السجل البعيد، وهل فيها إصدار **ليس** من ملفات المستودع.
2. `supabase db push --dry-run` → الترحيلات المعلّقة التي سيدفعها الـ CLI فعلاً.
3. قسم **Live schema probe → 9) per-migration object checklist** → الكائنات الحقيقية لكل ترحيل (جداول، دوال، أنواع).

---

## 3. مصفوفة القرار (لا تتجاوز صفّاً حتى تُثبته الخطوة 0)

| مخرَج الخطوة 0                                                                           | القرار الصحيح                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| إصدار يتيم في السجل البعيد (مثال: `20261002000000`) وغير موجود في `supabase/migrations/` | `mark_reverted` **لهذا الإصدار فقط** (§4) ثم إعادة الدفع. الحذف المقترَح للتسعة لا يعالج هذه الحالة إطلاقاً                                                                                             |
| كائنات الترحيلات 120000→160000 **غائبة كلها** (صفوف «وهمية»)                             | `mark_reverted` للتسعة (§4) ثم دفع نظيف يُنشئها فعلاً                                                                                                                                                   |
| كائنات **بعضها موجود** (مثل `backup_settings` أو `tickets`)                              | **ممنوع** التطهير الكامل والدفع من جديد — سيصطدم بـ `relation already exists`. المسار: ترحيل إصلاحي تالٍ (`create or replace` / `add column if not exists`) أو حذف يدوي مُراجَع للكائن الجزئي قبل الدفع |
| السجل مطابق أصلاً والمشكلة `is_active_user() does not exist` وحدها                       | ترحيل إصلاحي صغير يعيد `create or replace function public.is_active_user()` — لا مسّ بالسجل                                                                                                             |

### وحدة التطهير هي **الإصدار الواحد**، لا القائمة التسعة

هذا أهم قيد في هذا الدليل، وسببه دقيق: `supabase db push` يطبّق كل ملف داخل معاملة مستقلة، فإذا نجح
`20260930150000` (إضافة `profiles` إلى الـ publication) ثم فشل الملف الذي يليه، يبقى الأول **مُسجَّلاً
ومطبَّقاً فعلاً**. حذف صفوفه التسعة دفعة واحدة ثم إعادة الدفع يعني محاولة `ALTER PUBLICATION supabase_realtime
ADD TABLE public.profiles` على جدول منشور مسبقاً ⇒ `is already member of publication` ⇒ فشل جديد، لكن هذه
المرة على قاعدة نصف-مطبَّقة.

لذلك: **احذف/استردّ فقط الإصدارات التي يُثبت القسم 9 من القياس أن كائناتها غائبة عن الكتالوج، إصداراً بإصدار.**

> قائمة `mark_reverted` التسعة الكاملة (كما في القوائم الجاهزة المتداولة، وفي مثال §4) ليست خطوة
> افتراضية: هي مشروعة **فقط** إذا أثبت القسم 9 من القياس أن كائنات التسعة كلها غائبة. أي صف يُحذف دون
> هذا الإثبات يحوّل البوابة الحمراء إلى قاعدة نصف-مطبَّقة — وهي حالة أسوأ من الفشل الحالي.

---

## 4. التنفيذ المُعتمَد — عبر الـ CLI داخل الـ Workflow (بديل `DELETE` اليدوي)

أُضيف في هذا الفرع مدخل `mark_reverted` إلى `.github/workflows/supabase-migration.yml`، وهو نفس أثر
`DELETE FROM supabase_migrations.schema_migrations ...`، لكنه:

- ينفّذه **الـ CLI الرسمي** (`supabase migration repair --linked --status reverted`) لا SQL يدوي،
- يجري داخل خط الأنابيب المحمي `Production` ومُوثَّق في سجل التشغيل،
- يتحقق من الصيغة (14 رقماً) لكل إصدار قبل الكتابة.

```bash
# 1) استرداد السجل الوهمي للترحيل التأسيسي (عند غياب public.profiles في الإنتاج) ثم الدفع الكامل
gh workflow run supabase-migration.yml --ref main \
  -f dry_run=false \
  -f mark_reverted='20260930000000'

# 2) أو في حال وجود سلسلة كاملة من الصفوف الوهمية (شاملةً الترحيل التأسيسي 20260930000000)
gh workflow run supabase-migration.yml --ref main \
  -f dry_run=false \
  -f mark_reverted='20260930000000,20260930120000,20260930150000,20260930160000,20260930170000,20260930180000,20261001130000,20261001140000,20261001150000,20261001160000'

# 3) التحقق
gh run list --workflow=supabase-migration.yml --branch main --limit 3
# ثم اقرأ Job Summary: يجب أن تظهر كل الترحيلات في عمودَي LOCAL و REMOTE في migration list
```

> 🛡️ **ملاحظة حاسمة:** يمنع `.github/workflows/supabase-migration.yml` الجمع بين `dry_run=true` و`mark_reverted`/`mark_applied` لحماية جدول `schema_migrations` من التعديل غير المقصود أثناء التشغيل الجاف. كما تقوم خطوة `Push migrations` تلقائياً باسترداد السجل الوهمي `20260930000000` وإعادة الدفع من الترحيل التأسيسي إذا اكتشفت خطأ `relation "public.profiles" does not exist`.

---

## 5. ما لا يجوز فعله (منقول حرفياً من دليل الطوارئ الحالي، §3.3)

| إجراء                                                            | لماذا هو خطأ                                                                                            |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `DELETE FROM supabase_migrations.schema_migrations` قبل الخطوة 0 | يحوّل الدفع التالي إلى مقامرة: أي كائن موجود فعلاً سيُسقط الدفع في منتصف الطريق فتنتج قاعدة نصف-مطبَّقة |
| `repair --status applied` لإخفاء فشل                             | يُسجّل نجاحاً دون تنفيذ SQL ⇒ عطل صامت في الإنتاج                                                       |
| تشغيل `workflow_dispatch` على فرع غير `main`                     | الوظيفة مشروطة بـ `github.ref == 'refs/heads/main'` فتُستبعد بنيوياً (هدر تشغيل أحمر مؤكد)              |
| `--include-all` بلا مبرر                                         | دفع خارج الترتيب قرار هندسي صريح لا يُتَّخذ ضمنياً                                                      |

### 5.1 مواضع اصطدام مُثبتة داخل الملفات التسعة (إن أُعيد دفعها فوق كائنات موجودة)

| الملف                            | عبارات غير محمية (ستفشل إن كان الكائن موجوداً)                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `20260930150000_...realtime.sql` | `ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;`                         |
| `20260930170000_...schema.sql`   | `create table public.backup_settings` / `backup_logs` + `create index` + `create policy` |
| `20261001140000_...support.sql`  | `create table public.tickets` / `ticket_replies` + `create index` + `create policy`      |
| `20261001150000_...identity.sql` | `create trigger app_identity_settings_set_updated_at` + `create policy`                  |

هذه القائمة هي **السبب المباشر** لوجوب الخطوة 0 قبل أي تطهير: ملف واحد منها موجود في الإنتاج يكفي
لإسقاط الدفع بالكامل بعد إفراغ السجل.

---

## 6. معايير اللون الأخضر المستقر

1. `Supabase Production Telemetry` أخضر، وملخّصه يُظهر أن كل كائنات الترحيلات العشرة `present = true`.
2. `Supabase Migrations` على `main` أخضر، و`Push migrations` = success، والملخّص يُظهر 10 إصدارات `applied` في العمودين.
3. تحقق وظيفي: استدعاء `admin_update_app_identity` بحساب إداري + صف جديد في `audit_logs` (حسب §3.1/6 من تقرير RCA).
4. إعادة تشغيل `dry_run=true` مرة أخيرة ⇒ `No migrations to push` (رسالة السجل النظيف).

---

## 7. الحزمة الجاهزة للنسخ (تنفيذ يدوي كامل — المسار المُعتمَد: CLI عبر الـ Workflow)

> تُنفَّذ بالترتيب حرفياً. لا تنتقل من مرحلة إلى التي تليها إلا إذا تحقّق شرط الخروج المكتوب في نهايتها.

### المرحلة 0 — القياس (قراءة فقط، 3 دقائق)

```bash
gh workflow run supabase-production-telemetry.yml --ref main
gh run list --workflow=supabase-production-telemetry.yml --limit 1
gh run view <run-id> --web     # افتح Job Summary
```

**شرط الخروج:** الملخّص يحتوي على ثلاثة أقسام غير فارغة: `supabase migration list --linked`،
`supabase db push --dry-run`، و`Live schema probe → 9) per-migration object checklist`.

### المرحلة 0-ب — قراءة بديلة من SQL Editor (اختيارية، لكنها الأسرع للحسم)

```sql
-- ب1) السجل البعيد كما هو (لاحظ أي إصدار لا مقابل له في supabase/migrations/)
select version, name
  from supabase_migrations.schema_migrations
 order by version;

-- ب2) فحص وجود كائنات كل ترحيل — نفس منطق القسم 9 في القياس
select v.version, v.label, v.present
  from (values
    ('20260930000000', 'table profiles',
      exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = 'profiles')),
    ('20260930120000', 'fn is_active_user()',
      exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'is_active_user')),
    ('20260930150000', 'profiles in supabase_realtime',
      exists (select 1 from pg_publication_tables
               where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'profiles')),
    ('20260930160000', 'trigger role_permissions_guard_writes',
      exists (select 1 from pg_trigger where tgname = 'role_permissions_guard_writes')),
    ('20260930170000', 'table backup_settings',
      exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = 'backup_settings')),
    ('20260930170000', 'table backup_logs',
      exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = 'backup_logs')),
    ('20260930180000', 'fn admin_claim_next_backup_job()',
      exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'admin_claim_next_backup_job')),
    ('20261001130000', 'fn admin_set_user_roles()',
      exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'admin_set_user_roles')),
    ('20261001140000', 'table tickets',
      exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = 'tickets')),
    ('20261001150000', 'table app_identity_settings',
      exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where n.nspname = 'public' and c.relname = 'app_identity_settings')),
    ('20261001160000', 'fn admin_update_appearance_settings()',
      exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'admin_update_appearance_settings'))
  ) as v(version, label, present)
 order by v.version, v.label;
```

**قاعدة الحسم:**

- `present = false` ⇒ هذا الإصدار **صفّ وهمي** ويجوز استرداده (`mark_reverted`).
- `present = true` ⇒ **لا تلمسه**؛ كائنه موجود فعلاً وإعادة دفعه ستُسقط الدفع.
- إصدار في السجل البعيد بلا ملف محلي (يتيم) ⇒ أضفه إلى قائمة `mark_reverted` **بشكل منفصل**.
- **إذا كانت كائنات ترحيل الـ init (`20260930000000`) نفسها غائبة ⇒ توقف فوراً**: القاعدة ليست في حالة
  «سجل متقدّم على مخطط»، بل في حالة أسوأ تستدعي تقييم استعادة من نسخة احتياطية، لا تطهيراً.

### المرحلة 1 — دمج PR #15 (شرط تقني)

الفرع `arena/01a0fc42-admin-system` → PR [#15](https://github.com/ym7296111-ops/admin_system/pull/15).
بدون الدمج لن يعرف `main` المدخل `mark_reverted`، وأي تمرير له سيُرفض بخطأ `422`.

> فحص Vercel الأحمر على الـ PR **سابق لعملكم**: نفس الرسالة مسجّلة على PR #13
> (`Git author arena must have access to the project on Vercel to create deployments`) — لا علاقة لها بالترحيلات.

### المرحلة 2 — التطهير عبر الـ CLI (لا كتابة SQL يدوية)

```bash
# ضع هنا فقط الإصدارات التي أظهرت present = false (مثال: نسختان)
VERSIONS='20260930150000,20260930160000'

# 2أ) بروفة: يعرض الترحيلات المعلّقة بعد التصحيح ولا يطبّق أي SQL
gh workflow run supabase-migration.yml --ref main -f dry_run=true -f mark_reverted="$VERSIONS"

# 2ب) التحقق قبل التنفيذ: يجب أن تظهر VERSIONS في عمود REMOTE كمعلّقة (بلا صف)،
#     وأن يطبع الـ dry-run قائمة الترحيلات التي سيدفعها بالترتيب.
gh run list --workflow=supabase-migration.yml --branch main --limit 1
gh run view <dry-run-id> --web

# 2ج) التنفيذ الفعلي (نفس القائمة حرفياً)
gh workflow run supabase-migration.yml --ref main -f dry_run=false -f mark_reverted="$VERSIONS"
```

> ⚠️ اقرأ تحذير السجل: عند الجمع بين `dry_run=true` و`mark_reverted` يُعدَّل السجل **فعلاً**.
> لذلك لا تُمرِّر `mark_reverted` في مرحلة البروفة إلا وأنت متأكد من القائمة.

**شرط الخروج:** `Push migrations` = success، وملخّص التشغيل يُظهر كل الإصدارات في العمودين،
ولا أثر لأي `already exists` في السجل.

### المرحلة 3 — إعادة البوابة إلى الأخضر

```bash
# الطريق المفضّل: تشغيل طازج على main (يبني على تعريف الـ workflow المدموج)
gh workflow run supabase-migration.yml --ref main -f dry_run=false

# بديل: إعادة تشغيل الوظيفة الفاشلة من #44 (تعريف أقدم، لكن كافٍ لأن السجل صار سليماً)
gh run rerun 36985535753 --failed
```

### المرحلة 4 — التحقق النهائي (لم تُثبَت الأخضرار إلا بهذه)

1. آخر تشغيل لـ `Supabase Migrations` على `main` = **success**.
2. `gh workflow run supabase-migration.yml --ref main -f dry_run=true` ⇒ **لا ترحيلات معلّقة**.
3. `Supabase Production Telemetry` (تشغيل جديد) ⇒ كل الكائنات `present = true`.
4. تحقق وظيفي: `admin_update_app_identity` بحساب إداري ⇒ صف جديد في `audit_logs`.

### معايير الإجهاض (توقف ولا تُكرّر الحذف)

| العَرَض                                                | ما يعنيه                                  | الإجراء                                          |
| ------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------ |
| `relation … already exists` في البروفة أو الدفع        | كائن موجود فعلاً لنسخة طُلب استردادها     | توقف: أزل ذلك الإصدار من القائمة، ولا تُعد الحذف |
| `is already member of publication "supabase_realtime"` | نفس السبب أعلاه على مستوى الـ publication | نفس الإجراء                                      |
| إصدار يتيم جديد يظهر بعد الدفع                         | سجل متقدّم على الملفات                    | استرداده وحده ثم أعد الدفع                       |
| فشل آخر بلا رسالة واضحة (انسداد سجلات)                 | لا حسم                                    | لا تكرار عشوائي؛ اقرأ Job Summary ثم قرّر        |
