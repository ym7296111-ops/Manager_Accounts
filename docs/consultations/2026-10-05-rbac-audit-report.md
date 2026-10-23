# 📊 تقرير جرد نظام الصلاحيات (RBAC Audit Report)

> **المرحلة:** المرحلة 1 — جرد شامل لمسارات الصلاحيات والأدوار (قراءة وتوثيق فقط).
> **الحالة:** وثيقة مرجعية معتمدة كمخرج وحيد لهذه المرحلة — **لم يُعدَّل أي ملف موجود** (SQL / TypeScript / React / YAML)، ولم تُنشأ ملفات ترحيل أو دوال RPC أو سياسات RLS جديدة.
> **التاريخ:** 2026-10-05 · **الفرع:** `arena/f557f665-admin-system` عند `60005ce`.
> **البيئة المرجعية:** Vite + React 19 + TypeScript (strict) + TanStack Query v5 + Supabase (PostgreSQL / RLS / PostgREST / Realtime).
> **المراجع المعتمدة السابقة:** `docs/consultations/2026-10-04-hidden-super-admin-design-study.md` (التقرير الاستشاري الشامل) · `docs/consultations/roles-permissions-design-study.md` (وثيقة قرارات التنفيذ) · `docs/runbooks/first-time-admin-setup.md`.
> **حالة الاختبارات:** شُغّلت الاختبارات الحالية دون تعديل عليها — **27 ملف اختبار / 186 اختباراً — كلها ناجحة** (`npm test` → `vitest run`).

---

## 1. الملخص التنفيذي

- **عدد مواضع `'*'` (الصلاحية الشاملة) المكتشفة:** 64 سطراً متعلقاً بالصلاحيات، موزّعة على **34 موضعاً منطقياً** (بعد تجميع أسطر نفس العبارة الواحدة)، إضافة إلى **10 أسطر إيجابية خاطئة مستبعدة** (`event: '*'` في Realtime، `select('*')`، علامة `*` إلزامية في نموذج).
- **عدد مواضع slug الحساسة:** **90 سطراً** للحرف اللفظي `super_admin` في نحو **30 موضعاً منطقياً**، موزّعة بين SQL وسكربتات تشغيلية وواجهة واختبارات — إضافة إلى مواضع slugs حساسة أخرى (`roles.manage`، `'admin'` المضمّن في الواجهة، `support.manage`، `settings.manage`، `notifications.manage`).
- **عدد RPCs المتعلقة بالأدوار:** **3 دوال RPC مباشرة** للكتابة/الإدارة (`admin_set_role_permissions` · `admin_set_user_roles` · `admin_set_user_status`) + **1 عرض قراءة** (`role_permission_matrix`) + **4 واجهات مطلوبة غير موجودة أصلاً** (`admin_list_roles` · `admin_create_role` · `admin_delete_role` · `admin_list_users`) + **13 دالة RPC أخرى** تمر عبر `has_permission` / `is_admin` وتقرأ `user_roles` بشكل غير مباشر.
- **عدد سياسات RLS على الجداول الحساسة الخمسة** (`roles` · `user_roles` · `role_permissions` · `permissions` · `profiles`): **13 تعريف سياسة** (8 نشطة حالياً + 5 مُسحوبة في ترحيلات التقوية).
- **مستوى الخطورة العام:** **عالي** 🔴 — لنظام مركّز حول صلاحية واحدة `'*'` تُعرَّف بها `is_admin()` نفسها، مع تعارض دلالات التفويض (قدرة مقابل عضوية slug) بين الطبقات، واعتماد بوابات الواجهة على **محتوى القوائم** لا على قناة قدرات مستقلة.

**الخلاصة في سطر واحد:** النظام الحالي «سليم الحراس لكن متماسك الخطورة» — كل مسار كتابة محجوب ومُدقَّق، لكن **المعنى نفسه للمسؤولية مكرَّر بأربع صيغ مختلفة** (`'*'` كقدرة، `super_admin` كـ slug، `is_admin()` كدالة، وقوائم العميل كمصدر حقيقة)، وأي تغيير قادم نحو `is_super_admin` أو دور مخفي يجب أن يمر على **كل** المواضع الموثّقة أدناه.

---

## 2. جرد مواضع `'*'` (الصلاحية الشاملة)

> **منهجية العد:** كل سطر يرد فيه `'*'` بمعنى صلاحية (ليس `event: '*'` ولا `select('*')` ولا علامة نموذج). الأسطر المتجاورة داخل العبارة الواحدة تُجمع في صف واحد بالمدى الكامل. عمود «يحتاج تحديث؟» يجيب: هل يجب أن يعترف هذا الموضع بـ `is_super_admin` عند تنفيذ قرار الدور المخفي/قناة القدرات.

### 2.1 قاعدة البيانات — ترحيلات (نطاق حرج)

| #   | الملف:السطر                                                                                                                                       | السياق                                                                                                                               | الخطورة | يحتاج تحديث؟ |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------- | ------------ |
| 1   | `supabase/migrations/20260930000000_init_core_schema.sql:151`                                                                                     | فحص أمني جوهري — نواة `has_permission`: `(p.slug = p_permission or p.slug = '*')`                                                    | عالي    | نعم          |
| 2   | `supabase/migrations/20260930000000_init_core_schema.sql:155-162`                                                                                 | فحص أمني — `is_admin()` معرّفة حرفياً بـ `has_permission('*')` (سطر 162)                                                             | عالي    | نعم          |
| 3   | `supabase/migrations/20260930160000_rbac_atomic_operations.sql:207-209`                                                                           | حارس قيد — `system-role-locked`: `super_admin` يجب أن يحتفظ بـ `'*'` (النسخة الأولى من `admin_set_role_permissions`، مستبدلة لاحقاً) | عالي    | نعم          |
| 4   | `supabase/migrations/20260930160000_rbac_atomic_operations.sql:221-232`                                                                           | حارس خفض ذاتي — حساب `'*'` قبل/بعد التعديل (سطرا 222-223 و231-232)                                                                   | عالي    | نعم          |
| 5   | `supabase/migrations/20260930160000_rbac_atomic_operations.sql:244-248`                                                                           | رسالة خطأ `RBA01` توثّق ضرورة الاحتفاظ بـ `'*'`                                                                                      | منخفض   | لا (نص فقط)  |
| 6   | `supabase/migrations/20260930160000_rbac_atomic_operations.sql:270-274`                                                                           | حارس «آخر مسؤول» — العدّ بـ `p.slug = '*' or p.slug = 'roles.manage'` (نسخة قديمة تعدّ حاملي roles.manage كمسؤولين)                  | عالي    | نعم          |
| 7   | `supabase/migrations/20261001130000_core_security_hardening.sql:265-289`                                                                          | حارس خفض ذاتي (النسخة النهائية `admin_set_user_roles`) — `'*'` قبل/بعد + رسالة RBA01 (سطرا 267-268، 276-277، 284)                    | عالي    | نعم          |
| 8   | `supabase/migrations/20261001130000_core_security_hardening.sql:323-327`                                                                          | حساب `v_target_star_after` — هل يملك المستخدم المُعَيَّن `'*'` بعد التعديل                                                           | عالي    | نعم          |
| 9   | `supabase/migrations/20261001130000_core_security_hardening.sql:334-342`                                                                          | حارس «آخر مسؤول» — عدّ حاملي `permission.slug = '*'` النشطين                                                                         | عالي    | نعم          |
| 10  | `supabase/migrations/20261001130000_core_security_hardening.sql:507-509`                                                                          | حارس `system-role-locked` (النسخة النهائية `admin_set_role_permissions`)                                                             | عالي    | نعم          |
| 11  | `supabase/migrations/20261001130000_core_security_hardening.sql:520-548`                                                                          | حارس خفض ذاتي النسخة النهائية (سطرا 522-523، 531-532، ورسالة 548)                                                                    | عالي    | نعم          |
| 12  | `supabase/migrations/20261001130000_core_security_hardening.sql:555-573`                                                                          | حارس «آخر مسؤول» النهائي — العدّ بـ `permission.slug = '*'` فقط (التعليق 557 يوضّح أن roles.manage وحدها لا تُرضي الثبات)            | عالي    | نعم          |
| 13  | `supabase/migrations/20261001130000_core_security_hardening.sql:263` · `:557` · `supabase/migrations/20261001140000_support_system_schema.sql:14` | تعليقات توثيقية تشرح دلالة `'*'`                                                                                                     | منخفض   | لا (توثيق)   |

### 2.2 قاعدة البيانات — seed

| #   | الملف:السطر               | السياق                                                                         | الخطورة              | يحتاج تحديث؟ |
| --- | ------------------------- | ------------------------------------------------------------------------------ | -------------------- | ------------ |
| 14  | `supabase/seed.sql:17`    | تعليق: «`'*'` grants everything through `public.has_permission`»               | منخفض                | لا (توثيق)   |
| 15  | `supabase/seed.sql:21`    | **seed data** — صف الصلاحية `('*', 'system', ...)` نفسه                        | عالي (بيانات مرجعية) | نعم          |
| 16  | `supabase/seed.sql:37-43` | **seed data** — ربط `super_admin` بالصلاحية `'*'` (`join p.slug = '*'` سطر 42) | عالي (بيانات مرجعية) | نعم          |

### 2.3 سكربتات تشغيلية (scripts/sql)

| #   | الملف:السطر                                      | السياق                                                                                     | الخطورة         | يحتاج تحديث؟ |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------ | --------------- | ------------ |
| 17  | `scripts/sql/grant-first-super-admin.sql:91-98`  | فحص أمني تشغيلي — يشترط أن يمنح دور `super_admin` فعلاً `'*'` قبل المنح                    | عالي (مسار منح) | نعم          |
| 18  | `scripts/sql/admin-capability-audit.sql:101-107` | تشخيص — توسيع `'*'` على كامل جدول الصلاحيات (سطرا 105 و107)                                | متوسط           | نعم          |
| 19  | `scripts/sql/admin-capability-audit.sql:136-148` | تشخيص — `has_wildcard_star` + إعادة بناء `has_permission(...)` يدوياً (سطرا 138، 143، 147) | متوسط           | نعم          |
| 20  | `scripts/sql/admin-capability-audit.sql:181-187` | تشخيص — CTE القدرات الأربع (سطر 183)                                                       | متوسط           | نعم          |
| 21  | `scripts/sql/admin-capability-audit.sql:304-310` | تشخيص — `bool_or(perm.slug = '*')` وبوابة شاشة الإشعارات (سطرا 306، 310)                   | متوسط           | نعم          |
| 22  | `scripts/sql/admin-capability-audit.sql:326-328` | تشخيص — فحص سلامة مصفوفة الأدوار (`star`)                                                  | متوسط           | نعم          |
| 23  | `scripts/sql/test-account-bootstrap.sql:22`      | تعليق — «يملك `'*'` (super_admin) أو roles.manage»                                         | منخفض           | لا (توثيق)   |
| 24  | `scripts/sql/test-account-bootstrap.sql:211-219` | تشخيص — `star` + `can_open_templates` + `can_manage_transport` (سطرا 213، 217، 219)        | متوسط           | نعم          |
| 25  | `scripts/sql/test-account-teardown.sql:72-78`    | تحقق — `active_star_admins` (عدّ حاملي `'*'` النشطين)                                      | متوسط           | نعم          |

### 2.4 TypeScript/React — مصدر التطبيق

| #   | الملف:السطر                                 | السياق                                                                                          | الخطورة | يحتاج تحديث؟ |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------- | ------------ |
| 26  | `src/hooks/useRolesManagement.ts:191`       | ثابت `WILDCARD_SLUG = '*'` — أساس منطق الحماية في الشاشة                                        | عالي    | نعم          |
| 27  | `src/hooks/useRolesManagement.ts:197`       | ثابت `CRITICAL_SLUGS = ['*', 'roles.manage']` — قوائم الحماية                                   | عالي    | نعم          |
| 28  | `src/hooks/useRolesManagement.ts:382-384`   | `hasCapability` — `'*'` يمنح كل قدرة (انعكاس لدالة الخادم)                                      | عالي    | نعم          |
| 29  | `src/hooks/useRolesManagement.ts:436-441`   | `getPermissionProtection` — قفل `'*'` على `super_admin` + منع خفض الذات                         | عالي    | نعم          |
| 30  | `src/hooks/useRolesManagement.ts:466-474`   | `getSaveBlocker` — رفض draft يجرد `super_admin` من `'*'` (سطر 470)                              | عالي    | نعم          |
| 31  | `src/hooks/useRolesManagement.ts:575-580`   | `parseMatrix` — اشتقاق `actorIsSuperAdmin` من امتلاك `'*'` عبر أي دور (سطرا 576-578)            | عالي    | نعم          |
| 32  | `src/hooks/useSupportManagement.ts:605-610` | فحص صلاحيات عميل — `permSlug === '*' \|\| 'support.manage'` و`permSlug === '*'` (سطرا 606، 609) | عالي    | نعم          |

### 2.5 TypeScript — الاختبارات

| #   | الملف:السطر                                                                | السياق                                                          | الخطورة | يحتاج تحديث؟ |
| --- | -------------------------------------------------------------------------- | --------------------------------------------------------------- | ------- | ------------ |
| 33  | `src/hooks/useRolesManagement.test.ts:36` + `:105,119,180-226,252-254,403` | اختبارات حرّاس `'*'` و`super_admin` (fixtures وحالات الحماية)   | متوسط   | نعم          |
| 34  | `src/hooks/useSupportManagement.test.tsx:139-140`                          | fixture — دور `super_admin` يملك `permissions: [{ slug: '*' }]` | متوسط   | نعم          |
| 35  | `src/pages/SettingsPage.audit.test.tsx:137`                                | fixture — صلاحية `slug: '*'`                                    | متوسط   | نعم          |
| 36  | `src/pages/settings/RolesPermissions.test.tsx:41` + `:47`                  | fixture — `P_STAR` ودور `super_admin`                           | متوسط   | نعم          |

### 2.6 مواضع مستبعدة (إيجابية خاطئة — ليست صلاحيات)

| #   | الملف:السطر                                                                                                                                                                                                                                                      | سبب الاستبعاد                                         | الخطورة       | يحتاج تحديث؟ |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------- | ------------ |
| —   | `src/components/notifications/TemplateEditor.tsx:483`                                                                                                                                                                                                            | علامة `*` للحقل الإلزامي في واجهة القالب              | لا شيء        | لا           |
| —   | `src/context/BrandingContext.tsx:107` · `src/context/LocalizationProvider.tsx:97` · `src/hooks/useBackupManagement.ts:108,111` · `src/hooks/useNotificationRealtime.ts:78` · `src/hooks/useSupportManagement.ts:762,765` · `src/hooks/useUsersManagement.ts:434` | `event: '*'` في اشتراكات Supabase Realtime (أي تغيير) | لا شيء        | لا           |
| —   | `src/hooks/useBackupManagement.ts:80`                                                                                                                                                                                                                            | `.select('*')` — كل الأعمدة في استعلام PostgREST      | منخفض (أسلوب) | لا           |

---

## 3. جرد مواضع slug الحساسة

> يشمل الحرف اللفظي `super_admin` (90 سطراً)، وأي slugs أخرى حساسة تُفحص مباشرة. التجميع كما في القسم 2.

### 3.1 مواضع `slug = 'super_admin'` — قاعدة البيانات والسكربتات

| #   | الملف:السطر                                                              | slug المفحوص    | السياق                                                                                                               | الخطورة         |
| --- | ------------------------------------------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1   | `supabase/seed.sql:10`                                                   | `'super_admin'` | seed — صف الدور النظامي (is_system=true)                                                                             | عالي (بيانات)   |
| 2   | `supabase/seed.sql:37-43`                                                | `'super_admin'` | seed — ربط الدور بالصلاحية `'*'`                                                                                     | عالي (بيانات)   |
| 3   | `supabase/seed.sql:108-113`                                              | `'super_admin'` | seed — منح تجريبي لـ `admin@example.com` (`on conflict do nothing`)                                                  | عالي (بيانات)   |
| 4   | `supabase/migrations/20260930160000_rbac_atomic_operations.sql:207-209`  | `'super_admin'` | حارس قيد — `v_role_slug = 'super_admin'` (ثبات الاحتفاظ بـ `'*'`)                                                    | عالي            |
| 5   | `supabase/migrations/20260930170000_backup_system_schema.sql:38-42`      | `'super_admin'` | سياسة RLS — `backup_settings_super_admin_read` (عضوية slug لا قدرة)                                                  | عالي            |
| 6   | `supabase/migrations/20260930170000_backup_system_schema.sql:45-49`      | `'super_admin'` | سياسة RLS — `backup_logs_super_admin_read`                                                                           | عالي            |
| 7   | `supabase/migrations/20260930170000_backup_system_schema.sql:61-65`      | `'super_admin'` | فحص أمني RPC — `admin_trigger_manual_backup` (exists على `r.slug = 'super_admin'`)                                   | عالي            |
| 8   | `supabase/migrations/20260930170000_backup_system_schema.sql:94-98`      | `'super_admin'` | فحص أمني RPC — `admin_update_backup_settings`                                                                        | عالي            |
| 9   | `supabase/migrations/20260930170000_backup_system_schema.sql:118-127`    | `'super_admin'` | سياسة تخزين — `backup_objects_super_admin_read` على `storage.objects`                                                | عالي            |
| 10  | `supabase/migrations/20261001130000_core_security_hardening.sql:61-87`   | `'super_admin'` | حارس «آخر مسؤول» في `admin_set_user_status` (عدّ + تحديد الهدف + `last-admin-lockout` — سطور 66، 71، 80، 82، 85-87)  | عالي            |
| 11  | `supabase/migrations/20261001130000_core_security_hardening.sql:295-318` | `'super_admin'` | حارس «آخر مسؤول» في `admin_set_user_roles` (العدّ قبل/بعد + `RBA02` — سطور 295-300، 303-318)                         | عالي            |
| 12  | `supabase/migrations/20261001130000_core_security_hardening.sql:507-509` | `'super_admin'` | حارس `system-role-locked` في `admin_set_role_permissions`                                                            | عالي            |
| 13  | `supabase/migrations/20261001140000_support_system_schema.sql:14,180`    | `'super_admin'` | تعليقات توثيقية (وكلاء الدعم = super_admin / `'*'`)                                                                  | منخفض           |
| 14  | `scripts/sql/grant-first-super-admin.sql:91-112,136-156`                 | `'super_admin'` | سكربت المنح الأول — التحقق من الدور (`r.slug = 'super_admin'` سطر 97) ومنع أي ربط سابق (110-112) + سجل التدقيق (154) | عالي (مسار منح) |
| 15  | `scripts/sql/admin-capability-audit.sql:322`                             | `'super_admin'` | تعليق — التوقعات المتوقعة للمصفوفة                                                                                   | منخفض           |
| 16  | `scripts/sql/test-account-bootstrap.sql:22`                              | `'super_admin'` | تعليق — شرط المنفّذ                                                                                                  | منخفض           |
| 17  | `scripts/sql/test-account-teardown.sql:16`                               | `'super_admin'` | تعليق — الأدوار النظامية المحمية                                                                                     | منخفض           |

### 3.2 مواضع `slug = 'super_admin'` — الواجهة الأمامية

| #   | الملف:السطر                                                       | slug المفحوص    | السياق                                                                                                                                                      | الخطورة     |
| --- | ----------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 18  | `src/hooks/useUsersManagement.ts:44,108,240,268`                  | `'super_admin'` | `SUPER_ADMIN_SLUG` + `isSuperAdmin = roles.some(slug === 'super_admin')` (سطر 240) و`isActiveSuperAdmin` (268) — **بوابة الشاشة مبنية على الاسم لا القدرة** | عالي        |
| 19  | `src/hooks/useRolesManagement.ts:24,113,188,426,456`              | `'super_admin'` | `SUPER_ADMIN_SLUG` (188) + ثبات «super_admin يحتفظ بـ `'*'`» في الحارس (438، 470)                                                                           | عالي        |
| 20  | `src/hooks/useSupportManagement.ts:587`                           | `'super_admin'` | فحص قدرات العميل — `roleSlug === 'super_admin'` ⇒ وكيل دعم + «مشرف»                                                                                         | عالي        |
| 21  | `src/pages/settings/BackupManagement.tsx:117-131`                 | `'super_admin'` | بوابة الشاشة — استعلام مباشر `user_roles → roles(slug)` و`entry.roles?.slug === 'super_admin'` (سطر 129)                                                    | عالي        |
| 22  | `src/pages/settings/UsersManagement.tsx:35,164`                   | `'super_admin'` | توثيق + تلوين شارة الدور `role.slug === 'super_admin'` (سطر 164)                                                                                            | منخفض (عرض) |
| 23  | `src/pages/settings/RolesPermissions.tsx:35,46`                   | `'super_admin'` | توثيق تعليقي للبوابة والثبات                                                                                                                                | منخفض       |
| 24  | `src/hooks/useRolesManagement.test.ts:48,180,252-254,294,298,403` | `'super_admin'` | اختبارات الثبات والحارسين                                                                                                                                   | متوسط       |
| 25  | `src/hooks/useUsersManagement.test.tsx:40`                        | `'super_admin'` | fixture — أدوار المستخدم                                                                                                                                    | متوسط       |
| 26  | `src/hooks/useSupportManagement.test.tsx:70,139,158`              | `'super_admin'` | fixture — طالب الدعم يحمل الدور                                                                                                                             | متوسط       |
| 27  | `src/pages/SettingsPage.audit.test.tsx:73,130,145`                | `'super_admin'` | mock استجابة `user_roles` + صف المستخدم                                                                                                                     | متوسط       |
| 28  | `src/pages/settings/RolesPermissions.test.tsx:47,124`             | `'super_admin'` | fixture + اختبار لوحة 403 لغير المشرف                                                                                                                       | متوسط       |

### 3.3 slugs حساسة أخرى تُفحص مباشرة

| #   | الملف:السطر                                                                          | slug المفحوص                                   | السياق                                                                                                                     | الخطورة             |
| --- | ------------------------------------------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 29  | `src/hooks/useSupportManagement.ts:591`                                              | `'admin'`                                      | **فحص دور مضمّن حرفياً** — `roleSlug === 'admin'` ⇒ صلاحية الدعم (`hasSupportPermission = true`) حتى بدون `support.manage` | عالي (انجراف محتمل) |
| 30  | `src/hooks/useRolesManagement.ts:197,441`                                            | `'roles.manage'`                               | قوائم الحماية الحرجة (`CRITICAL_SLUGS`) ومنع خفض الذات                                                                     | عالي                |
| 31  | `supabase/migrations/20260930160000_rbac_atomic_operations.sql:223,232,274`          | `'roles.manage'`                               | حرّاس الخفض الذاتي و«آخر مسؤول» (النسخة الأولى)                                                                            | عالي                |
| 32  | `supabase/migrations/20261001130000_core_security_hardening.sql:268,277,289`         | `'roles.manage'`                               | حرّاس الخفض الذاتي في `admin_set_user_roles`                                                                               | عالي                |
| 33  | `supabase/migrations/20261001140000_support_system_schema.sql:55-63`                 | `'support.manage'`                             | `is_support_agent()` = `is_active_user() AND (is_admin() OR has_permission('support.manage'))`                             | متوسط (صيغة سليمة)  |
| 34  | `supabase/migrations/20261001150000_app_identity_schema.sql:20-24`                   | `'settings.manage'`                            | `can_manage_app_identity()`                                                                                                | متوسط (صيغة سليمة)  |
| 35  | `supabase/migrations/20261001160000_localization_system_schema.sql:38-41,97-100`     | `'settings.manage'`                            | `can_manage_appearance()` + حارس `admin_update_appearance_settings`                                                        | متوسط (صيغة سليمة)  |
| 36  | `supabase/migrations/20261002120000_notification_transports_and_secrets.sql:593-596` | `'settings.manage'`                            | `can_manage_email_transport()`                                                                                             | متوسط (صيغة سليمة)  |
| 37  | `supabase/migrations/20261002150000_notification_templates_schema.sql:867-870`       | `'notifications.manage'`                       | `can_manage_notification_templates()`                                                                                      | متوسط (صيغة سليمة)  |
| 38  | `supabase/migrations/20261003110000_notification_bundle_rpc.sql:29-33,280-283`       | `'settings.manage'` / `'notifications.manage'` | بوابتا التصدير/الاستيراد                                                                                                   | متوسط (صيغة سليمة)  |
| 39  | `scripts/sql/test-account-bootstrap.sql:80-87,160-172`                               | `'qa_notifications_editor'`                    | دور اختبار غير نظامي يُنشأ عبر سكربت (slug مخصص)                                                                           | منخفض (بيئة QA)     |
| 40  | `src/hooks/useSupportManagement.ts:606` · `supabase/seed.sql:28`                     | `'support.manage'`                             | فحص مزدوج (عميل + خادم)                                                                                                    | متوسط               |

---

## 4. جرد RPCs المتعلقة بالأدوار

> **تصحيح مرجعي مهم (موثّق أصلاً في دراسة الدور المخفي §177):** لا توجد دوال باسم `admin_list_roles` أو `admin_create_role` أو `admin_delete_role` أو `admin_list_users` في المستودع إطلاقاً. مسارات القراءة الفعلية هي العرض `public.role_permission_matrix` واختيارات PostgREST المباشرة على `profiles` مع تضمين `user_roles(roles(...))`. التوثيق أدناه يعطي كل مطلوب مع حالته الحقيقية.

### 4.1 `admin_set_role_permissions`

- **التوقيع:** `admin_set_role_permissions(target_role_id uuid, permission_slugs text[]) RETURNS jsonb`
  - **المدخلات:** معرّف الدور + مصفوفة slugs الصلاحيات المطلوبة (حالة نهائية كاملة، diff-based).
  - **المخرجات:** `jsonb` = `{role_id, role_slug, granted[], revoked[], updated_at}` — أخطاء بـ SQLSTATEs مخصصة: `42501` ممنوع · `P0002` غير موجود · `RBA01` خفض ذاتي · `RBA02` آخر مسؤول · `RBA03` دور نظامي مقفل.
- **الموقع:** النسخة النهائية `supabase/migrations/20261001130000_core_security_hardening.sql:415-636` (النسخة الأولى `20260930160000_rbac_atomic_operations.sql:115-338` — استُبدلت لإضافة قفل `admin_authority_invariant` المشترك).
- **SECURITY DEFINER:** نعم (`search_path = pg_catalog, public`).
- **فحص الصلاحيات:** `is_admin()` فقط (أي امتلاك `'*'`) — **لا يقبل `roles.manage` وحدها** (ملاحظة F3 في التقرير الاستشاري). إضافة إلى حارس خفض ذاتي (`'*'` + `roles.manage` عبر كل أدوار المنادي) وحارس «آخر مسؤول» (حاملي `'*'` النشطين) وثبات `super_admin`-يحتفظ-بـ`'*'`.
- **يتفاعل مع `user_roles`:** نعم — **قراءة فقط** (لحساب قدرات المنادي وأدواره)، ويكتب في `role_permissions` و`roles.updated_at` و`audit_logs`. مسار الكتابة الوحيد المسموح لـ `role_permissions` (الجدول محجوب بـ REVOKE + حارس trigger `guard_role_permissions_writes` يسمح فقط لـ `postgres`/`supabase_admin`).
- **مستوى الخطورة:** **عالي** — لو أُسيئت استخدامها: تغيير كامل مصفوفة الصلاحيات؛ لكنها محروسة بأربعة حراسة متتالية + تدقيق، و`EXECUTE` لـ `authenticated` فقط (سُحبت من `public`/`anon`/`service_role` في النسخة النهائية).
- **ملاحظات:** يناديها الواجهة من `src/hooks/useRolesManagement.ts:916`. القفل المستشاري المزدوج (`admin_authority_invariant` + قفل الدور) يمنع السباقات مع تغييرات الأدوار/الحالات.

### 4.2 `admin_set_user_roles`

- **التوقيع:** `admin_set_user_roles(p_user_id uuid, p_role_slugs text[]) RETURNS jsonb`
  - **المدخلات:** معرّف المستخدم + مصفوفة slugs الأدوار (حالة نهائية — أي دور غير مذكور يُسحب).
  - **المخرجات:** `jsonb` = `{user_id, granted[], revoked[]}` — أخطاء: `42501` · `22023` · `P0002` · `RBA01` · `RBA02`.
- **الموقع:** `supabase/migrations/20261001130000_core_security_hardening.sql:165-410`.
- **SECURITY DEFINER:** نعم (`search_path = pg_catalog, public`).
- **فحص الصلاحيات:** `is_active_user() AND is_admin()` (أي `'*'` + ملف نشط) — **أيضاً لا تقبل `roles.manage` وحدها** (F3 نفسها). حرّاس إضافية: خفض ذاتي (إن عدّل المنادي أدواره)، «آخر مسؤول» مزدوج (بقاء `super_admin` نشط + بقاء حامل `'*'` نشط)، قفل `share row exclusive` على الجداول الأربعة + `FOR UPDATE` على الصف.
- **يتفاعل مع `user_roles`:** **نعم — الكتابة المباشرة الوحيدة المسموحة** (`insert`/`delete` diff-based مع `granted_by = auth.uid()` + سطرا تدقيق `role.granted`/`role.revoked`). الجدول نفسه: RLS مفعّل + **FORCE** + لا سياسات كتابة + REVOKE DML حتى من `service_role`.
- **مستوى الخطورة:** **عالي جداً** — منح أي دور (بما فيه `super_admin` المحمي بالاسم)؛ الحرّاسة تمنع الخفض الذاتي وانقراض المسؤول الأخير فقط.
- **ملاحظات:** ⚠️ **لا يناديها أي مكوّن في الواجهة الأمامية إطلاقاً** (فُحص `src/` كاملاً) — المستخدم الوحيد بعد الاختبارات هو `scripts/sql/test-account-bootstrap.sql:183` و`scripts/audit/database.mjs:267-291`. وبذلك **إدارة تعيين الأدوار غير متاحة من التطبيق نهائياً** اليوم (الشاشة تعرض الأدوار فقط).

### 4.3 `admin_set_user_status`

- **التوقيع:** `admin_set_user_status(p_user_id uuid, p_status public.user_status) RETURNS void` (الحالات: `invited`/`active`/`suspended`).
- **الموقع:** النسخة النهائية `supabase/migrations/20261001130000_core_security_hardening.sql:11-110` (النسخة الأولى `20260930120000_harden_profiles_and_definer_functions.sql:134-177`).
- **SECURITY DEFINER:** نعم.
- **فحص الصلاحيات:** `is_admin()` + منع تعليق الذات + **`last-admin-lockout` بعضوية slug**: لا يمكن تعليق آخر `super_admin` نشط (العدّ بـ `r.slug = 'super_admin'` — سطور 66-87). قفل `admin_authority_invariant` المشترك.
- **يتفاعل مع `user_roles`:** نعم — قراءة (حساب آخر مسؤول)، والكتابة الوحيدة في `profiles.status` (العمود محمي بـ REVOKE على مستوى العمود + حارس `guard_profile_protected_columns`).
- **مستوى الخطورة:** **عالي** — تعليق/تفعيل حسابات؛ محروس جيداً و`EXECUTE` لـ `authenticated` فقط.
- **ملاحظات:** يناديها `src/hooks/useUsersManagement.ts:513` مع إعادة فحص الحارس مسبقاً من ذاكرة التخزين المؤقت.

### 4.4 `admin_list_roles` — ❌ غير موجودة

- **الحالة:** لا توجد دالة بهذا الاسم (تأكيداً بالبحث الشامل + `src/lib/database.types.ts`).
- **المسار الفعلي للقراءة:** العرض `public.role_permission_matrix` (`supabase/migrations/20260930160000_rbac_atomic_operations.sql:72-105`) — `security_invoker = true`، `SELECT` لـ `authenticated, service_role` فقط، يعيد كامل الجداء (الأدوار × الصلاحيات + المنح + `held_by_actor` + `assigned_user_count`). يقرأه `src/hooks/useRolesManagement.ts:638`.
- **التوقيع البديل:** `SELECT` من view بأعمدة: `role_id, role_slug, role_name_ar, role_name_en, role_is_system, permission_id, permission_slug, permission_module, permission_name_ar, permission_name_en, permission_description, granted, held_by_actor, assigned_user_count`.
- **فحص الصلاحيات:** غير مباشر — RLS على `roles`/`permissions`/`role_permissions` (قراءة لـ `authenticated`) و`user_roles` (صفوف المنادي أو `is_support_agent`).
- **مستوى الخطورة:** متوسط — كشف كامل لكتالوج الأدوار (بما فيه `super_admin` و`assigned_user_count`) لأي مستخدم مُوثَّق. **ملاحظة:** عدّاد `assigned_user_count` هو «oracle تعداد» موثّق في التقرير الاستشاري (RISK-05) — لو أُخفي دور مستقبلاً يجب استبعاده من العدّاد.

### 4.5 `admin_create_role` / `admin_delete_role` — ❌ غير موجودتان

- **الحالة:** لا توجد أي دالة إنشاء/حذف دور. الكتابة المباشرة على `roles`/`permissions`/`role_permissions` مسحوبة من `public, anon, authenticated, service_role` (`20261001130000:125-135`) ومحفوظة بـ `guard_role_permissions_writes` (يسمح فقط `postgres`/`supabase_admin`).
- **المسار الوحيد لإنشاء دور اليوم:** SQL Editor بجلسة مالك القاعدة (كما في `scripts/sql/test-account-bootstrap.sql:80-87` الذي ينشئ `qa_notifications_editor`) أو seed. **لا توجد حماية من حذف `super_admin` كصف** سوى قيد `is_system` المعرَّفي (لا يوجد trigger يمنع الحذف) — سجل كفجوة في القسم 8.
- **مستوى الخطورة:** عالي (لو أُضيفت لاحقاً دون حراس) / حالي: خطر حذف عبر SQL Editor فقط.

### 4.6 `admin_list_users` — ❌ غير موجودة

- **الحالة:** لا توجد دالة. الشاشة تقرأ `public.profiles` مباشرة عبر PostgREST: `src/hooks/useUsersManagement.ts:341` بالأعمدة `id, email, full_name, status, created_at, updated_at, user_roles(roles(slug, name_ar, name_en))` (`PROFILE_COLUMNS` سطر 121-122).
- **كيف تعرض الأدوار؟** تضمين مدمج `user_roles(roles(...))` في نفس الاستعلام (بلا N+1)، ثم تسطيحها في `ManagedUserRole` واشتقاق `isSuperAdmin` **بمطابقة slug حرفية** (سطر 240) — لا بامتلاك `'*'`.
- **فحص الصلاحيات:** RLS فقط — `profiles`: قراءة الصف الخاص (`auth.uid() = id`) أو `is_admin()`؛ و`user_roles`: صفّي المنادي أو `is_support_agent()`.
- **مستوى الخطورة:** متوسط — أي `is_admin()` (حامل `'*'`) يرى كل الملفات وأدوار الجميع؛ حامل `support.manage` يرى أدوار طلاب الدعم (تضمين). لا حماية من `service_role` (تجاوز RLS).

### 4.7 RPCs أخرى تتعامل مع `user_roles` / `role_permissions` (قراءة عبر `has_permission`/`is_admin`)

| الدالة                                                                                                                                | التوقيع           | SECURITY DEFINER  | فحص المنادٍ                                                                            | تقرأ user_roles؟                             | الخطورة                      |
| ------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ----------------- | -------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------- |
| `has_permission(p_permission text)`                                                                                                   | `RETURNS boolean` | نعم (نواة كل شيء) | لا — هي نفسها النواة                                                                   | نعم (join كامل + `profiles.status='active'`) | عالي جداً (نقطة تفرّع واحدة) |
| `is_admin()`                                                                                                                          | `RETURNS boolean` | نعم               | لا                                                                                     | نعم (عبر `has_permission('*')`)              | عالي جداً                    |
| `is_active_user()`                                                                                                                    | `RETURNS boolean` | نعم               | لا                                                                                     | لا (profiles فقط)                            | متوسط                        |
| `is_support_agent()`                                                                                                                  | `RETURNS boolean` | نعم               | لا                                                                                     | نعم (عبر is_admin/has_permission)            | متوسط                        |
| `can_manage_app_identity()` / `can_manage_appearance()` / `can_manage_email_transport()`                                              | `RETURNS boolean` | نعم               | لا                                                                                     | نعم (غير مباشر)                              | منخفض (بوابات عرض)           |
| `can_manage_notification_templates()`                                                                                                 | `RETURNS boolean` | نعم               | لا                                                                                     | نعم (غير مباشر)                              | منخفض                        |
| `admin_trigger_manual_backup()`                                                                                                       | `RETURNS uuid`    | نعم               | **عضوية slug `super_admin`** (ليس قدرة!)                                               | نعم (exists على user_roles)                  | عالي (تعارض دلالات)          |
| `admin_update_backup_settings(p_enabled boolean, p_interval_working_days integer)`                                                    | `RETURNS void`    | نعم               | **عضوية slug `super_admin`**                                                           | نعم                                          | عالي (تعارض دلالات)          |
| `admin_set_user_status` / `admin_set_user_roles` / `admin_set_role_permissions`                                                       | (أعلاه)           | نعم               | `is_admin()`                                                                           | نعم                                          | عالي                         |
| `create_support_ticket` / `add_ticket_reply`                                                                                          | `RETURNS jsonb`   | نعم               | `is_active_user()` (+ `is_support_agent` للرد)                                         | نعم (غير مباشر)                              | متوسط                        |
| `update_ticket_status(p_ticket_id uuid, p_status ticket_priority, p_priority)`                                                        | `RETURNS jsonb`   | نعم               | `is_support_agent()`                                                                   | نعم (غير مباشر)                              | متوسط                        |
| `admin_export_notification_bundle()` / `admin_import_notification_bundle(p_bundle jsonb)`                                             | `RETURNS ...`     | نعم               | `is_admin() OR settings.manage OR notifications.manage` (استيراد: settings.manage فقط) | نعم (غير مباشر)                              | متوسط/عالي (استيراد)         |
| `admin_list_notification_templates` + بقية `admin_*` للقوالب والبريد و`admin_update_app_identity` و`admin_update_appearance_settings` | (متعددة)          | نعم               | `can_manage_*` المقابلة                                                                | نعم (غير مباشر)                              | متوسط                        |
| `admin_claim_next_backup_job()`                                                                                                       | `RETURNS ...`     | نعم               | `service_role` فقط (REVOKE من البقية)                                                  | لا                                           | منخفض (عامل خلفي)            |

---

## 5. جرد سياسات RLS

> الجداول المطلوبة: `public.roles` · `public.user_roles` · `public.role_permissions` · `public.permissions` · `public.profiles`. جميعها `ENABLE ROW LEVEL SECURITY` (`20260930000000:240-247`)، و`user_roles` عليها إضافة `FORCE ROW LEVEL SECURITY` (`20261001130000:117-118`).
> **ملاحظة جامعة حول `service_role`:** هو دور `BYPASSRLS` في Supabase — **لا سياسة RLS تحمي منه**. الحماية الفعلية منه تأتي من سحب صلاحيات الجداول (REVOKE) وحارسات triggers، والموضّحة في القسم 6.

### 5.1 جدول `public.profiles`

| السياسة                                                       | العملية | الدور                                       | USING                                  | WITH CHECK                             | تحمي من service_role؟                                                                                                                                                                               |
| ------------------------------------------------------------- | ------- | ------------------------------------------- | -------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Users read their own profile` (20260930000000:249-251)       | SELECT  | كل الأدوار ذات المنح (عملياً authenticated) | `auth.uid() = id or public.is_admin()` | —                                      | لا (لكن لا حاجة: القراءة مقصودة للعامل الخدمي)                                                                                                                                                      |
| `Users update their own preferences` (20260930000000:253-256) | UPDATE  | نفسه                                        | `auth.uid() = id or public.is_admin()` | `auth.uid() = id or public.is_admin()` | لا — والحماية الموازية: صلاحيات **عمودية** (`full_name, avatar_url, phone, preferred_theme, preferred_locale` فقط — `20260930120000:15-19`) + حارس `guard_profile_protected_columns` (status/email) |
| `Admins manage profiles` (20260930000000:258-261)             | ALL     | —                                           | `public.is_admin()`                    | `public.is_admin()`                    | ❌ **مُسحوبة** في `20261001130000:137` (لم تعد موجودة)                                                                                                                                              |
| `Support agents read profiles` (20261001140000:182-187)       | SELECT  | `authenticated`                             | `public.is_support_agent()`            | —                                      | لا                                                                                                                                                                                                  |

### 5.2 جدول `public.roles`

| السياسة                                               | العملية | الدور                         | USING                           | WITH CHECK          | تحمي من service_role؟                                                          |
| ----------------------------------------------------- | ------- | ----------------------------- | ------------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| `Signed-in users read roles` (20260930000000:263-265) | SELECT  | (الكل — عملياً authenticated) | `auth.role() = 'authenticated'` | —                   | لا — service_role احتفظ بـ SELECT                                              |
| `Admins manage roles` (20260930000000:267-270)        | ALL     | —                             | `public.is_admin()`             | `public.is_admin()` | ❌ **مُسحوبة** في `20261001130000:128` + REVOKE DML من الجميع حتى service_role |

### 5.3 جدول `public.permissions`

| السياسة                                                     | العملية | الدور           | USING                           | WITH CHECK          | تحمي من service_role؟                               |
| ----------------------------------------------------------- | ------- | --------------- | ------------------------------- | ------------------- | --------------------------------------------------- |
| `Signed-in users read permissions` (20260930000000:272-274) | SELECT  | (authenticated) | `auth.role() = 'authenticated'` | —                   | لا (SELECT مسموح لـ service_role)                   |
| `Admins manage permissions` (20260930000000:276-279)        | ALL     | —               | `public.is_admin()`             | `public.is_admin()` | ❌ **مُسحوبة** في `20261001130000:129` + REVOKE DML |

### 5.4 جدول `public.role_permissions`

| السياسة                                                          | العملية | الدور           | USING                           | WITH CHECK          | تحمي من service_role؟                                                                                                                                                     |
| ---------------------------------------------------------------- | ------- | --------------- | ------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Signed-in users read role permissions` (20260930000000:281-283) | SELECT  | (authenticated) | `auth.role() = 'authenticated'` | —                   | لا (SELECT مسموح)                                                                                                                                                         |
| `Admins manage role permissions` (20260930000000:285-288)        | ALL     | —               | `public.is_admin()`             | `public.is_admin()` | ❌ **مُسحوبة** في `20261001130000:130` + REVOKE DML + حارس trigger (يسمح فقط `postgres`/`supabase_admin` — نسخة 20261001130000 أشدّ من سابقتها التي سمحت لـ service_role) |

### 5.5 جدول `public.user_roles`

| السياسة                                                     | العملية | الدور           | USING                                       | WITH CHECK          | تحمي من service_role؟                                                                                                                  |
| ----------------------------------------------------------- | ------- | --------------- | ------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Users read their own assignments` (20260930000000:290-292) | SELECT  | (authenticated) | `auth.uid() = user_id or public.is_admin()` | —                   | لا (SELECT مسموح)                                                                                                                      |
| `Admins manage user roles` (20260930000000:294-297)         | ALL     | —               | `public.is_admin()`                         | `public.is_admin()` | ❌ **مُسحوبة** في `20261001130000:119` + REVOKE DML/TRUNCATE من `public, anon, authenticated, service_role` (سطور 121-123) + FORCE RLS |
| `Support agents read user roles` (20261001140000:189-194)   | SELECT  | `authenticated` | `public.is_support_agent()`                 | —                   | لا                                                                                                                                     |

> **الخلاصة:** 13 تعريف سياسة (8 نشطة). سياسات الكتابة (`Admins manage ...`) كلها مُسحوبة — الكتابة تمر حصراً عبر RPCs `SECURITY DEFINER` المدقّقة. لا شيء يحمي من `service_role` على مستوى RLS؛ الحماية منه = REVOKE + triggers (وهذا كافٍ عملياً للجداول الخمسة، مع ملاحظة القسم 6.3 حول default privileges).

---

## 6. جرد منح الصلاحيات (GRANT)

### 6.1 المنح العامة (نقطة الانطلاق — `20260930000000_init_core_schema.sql:324-328`)

| الجدول/النطاق                     | الدور                             | الصلاحيات                      | المصدر (ملف الترحيل)                                                                                   |
| --------------------------------- | --------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ |
| schema `public`                   | anon, authenticated, service_role | USAGE                          | `20260930000000:324`                                                                                   |
| `public.app_settings`             | anon                              | SELECT                         | `20260930000000:325`                                                                                   |
| **كل جداول public** (وقت الترحيل) | authenticated                     | SELECT, INSERT, UPDATE, DELETE | `20260930000000:326`                                                                                   |
| **كل جداول public** (وقت الترحيل) | service_role                      | ALL                            | `20260930000000:327`                                                                                   |
| **جداول public المستقبلية**       | service_role                      | ALL (افتراضي!)                 | `20260930000000:328` — `alter default privileges in schema public grant all on tables to service_role` |

### 6.2 المنح/السحب على الجداول الحساسة (تجميع زمني)

| الجدول                                 | الدور                                         | الصلاحيات                                                                                       | المصدر                   |
| -------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------ |
| `public.profiles`                      | authenticated, anon                           | UPDATE **مسحوب**                                                                                | `20260930120000:15-16`   |
| `public.profiles`                      | authenticated                                 | UPDATE (full_name, avatar_url, phone, preferred_theme, preferred_locale) — **على مستوى العمود** | `20260930120000:18-19`   |
| `public.profiles`                      | public, anon, authenticated, service_role     | INSERT, DELETE **مسحوبان**                                                                      | `20261001130000:138`     |
| `public.role_permissions`              | anon, authenticated                           | INSERT, UPDATE, DELETE **مسحوبة**                                                               | `20260930160000:34`      |
| `public.role_permission_matrix` (view) | authenticated, service_role                   | SELECT                                                                                          | `20260930160000:104-105` |
| `public.user_roles`                    | public, anon, authenticated, **service_role** | INSERT, UPDATE, DELETE, TRUNCATE **مسحوبة**                                                     | `20261001130000:121-123` |
| `public.roles`                         | public, anon, authenticated, **service_role** | INSERT, UPDATE, DELETE, TRUNCATE **مسحوبة**                                                     | `20261001130000:131-135` |
| `public.permissions`                   | public, anon, authenticated, **service_role** | INSERT, UPDATE, DELETE, TRUNCATE **مسحوبة**                                                     | `20261001130000:131-135` |
| `public.role_permissions`              | public, anon, authenticated, **service_role** | INSERT, UPDATE, DELETE, TRUNCATE **مسحوبة**                                                     | `20261001130000:131-135` |

### 6.3 إجابة السؤال المحوري: هل `service_role` لديه صلاحيات كتابة على `roles` أو `user_roles`؟

- **الجواب: لا** — بعد `20261001130000:121-135` سُحبت الكتابة (DML + TRUNCATE) من `service_role` على `user_roles` و`roles` و`permissions` و`role_permissions`، مع بقاء **SELECT** له عليها (وهو كافٍ لعمل العوامل الخلفية إن لزم).
- **التحفظان الموثّقان:**
  1. `alter default privileges in schema public grant all on tables to service_role` (`20260930000000:328`) **لا يزال سارياً** — أي جدول **جديد** يُنشأ في `public` يرث ALL تلقائياً لـ `service_role` ما لم يُصرَّح بخلافه في ترحيله (والترحيلات اللاحقة تفعل ذلك جيداً جدباً: backup/notifications إلخ).
  2. الجداول الخمسة محمية بـ REVOKE + triggers وليس RLS؛ مالك الجداول (`postgres`/`supabase_admin`) وجلسة SQL Editor تتجاوز كل ذلك بحكم التعريف (موثّق في `scripts/sql/admin-capability-audit.sql:15-22`).
- **منح الدوال (خلاصة):** كل دوال `SECURITY DEFINER` الإدارية `EXECUTE` لـ `authenticated` فقط (`admin_set_user_status` 20261001130000:107-110 · `admin_set_user_roles` 405-408 · `admin_set_role_permissions` 631-634)، مع سحب `public`/`anon`/`service_role`. دوال البوابات (`is_admin`، `has_permission`، `is_active_user`، `can_manage_*`) `EXECUTE` لـ `authenticated, service_role` (`20260930120000:25-33,58-59`).

---

## 7. جرد الواجهة الأمامية

> **ملاحظة عامة:** لا يوجد أي استخدام لـ `user.role` أو `permissions.includes(...)` في الواجهة (بُحث صراحة). الصلاحيات لا تأتي من JWT — `AuthContext` يدير جلسة Supabase فقط. الأنماط القائمة ثلاثة: (أ) اشتقاق من محتوى القوائم (slug/`'*'`)، (ب) استعلام عميل مباشر على `user_roles`، (ج) بوابة قدرة عبر RPC على الخادم (النمط الموصى به).

### 7.1 مكونات إدارة الأدوار

- **الملف:** `src/pages/settings/RolesPermissions.tsx` + `src/hooks/useRolesManagement.ts`
- **مصدر الصلاحيات:** استعلام واحد على العرض `role_permission_matrix` (`useRolesManagement.ts:638`) — لا Context ولا RPC.
- **يعتمد على slug:** نعم — `SUPER_ADMIN_SLUG = 'super_admin'` (سطر 188) في ثبات «يجب أن يحتفظ بـ `'*'`» (سطرا 438، 470).
- **يعتمد على `'*'`:** نعم — `actorIsSuperAdmin` يُشتق من امتلاك `'*'` عبر أي دور (`parseMatrix` سطور 575-580)، والبوابة تعرض 403 عند `!actorIsSuperAdmin` (`RolesPermissions.tsx:668`).
- **ماذا يحدث إذا أُخفي `super_admin` من الاستجابة؟** 🧨 ينطبق تحليل التقرير الاستشاري حرفياً: إذا أُخفي الدور/منحه عن المصفوفة، يصبح `actorIsSuperAdmin = false` للحامل نفسه (الوحيد غالباً) ⇒ **لوحة 403** ⇒ لا أحد يستطيع إدارة الأدوار من التطبيق إطلاقاً. (ولو أُخفي الدور فقط وبقيت منحه معلّقة على دور آخر ظاهر، فتبقى الشاشة تعمل — لكن الاسم المخفي يكسر ثبات `super_admin`-keeps-`'*'` في الواجهة.)

### 7.2 مكونات إدارة المستخدمين

- **الملف:** `src/pages/settings/UsersManagement.tsx` + `src/hooks/useUsersManagement.ts`
- **مصدر الصلاحيات:** PostgREST مباشر على `profiles` مع تضمين `user_roles(roles(...))` (`useUsersManagement.ts:341` و`PROFILE_COLUMNS:121-122`) + RPC `admin_set_user_status` للكتابة (سطر 513).
- **يعتمد على slug:** نعم — `isSuperAdmin = roles.some(slug === 'super_admin')` (سطر 240) و`SUPER_ADMIN_SLUG` (108)؛ والبوابة `!actorIsSuperAdmin` ⇒ 403 (`UsersManagement.tsx:583`)؛ والتلوين `role.slug === 'super_admin'` (164).
- **يعتمد على `'*'`:** لا مباشرة (لكن الخادم يعتمد عليه في RLS/RPC).
- **ماذا يحدث إذا أُخفي `super_admin` من الاستجابة؟** 🧨 لو أُخفي صف المستخدم المخفي من `profiles` (أو دوره من التضمين): `actorIsSuperAdmin = false` ⇒ **لوحة 403**، وتختفي أيضاً قوائم «آخر مسؤول»/`activeSuperAdmins` ⇒ تتعطّل حارسات الواجهة المسبقة. لو أُخفي الدور عن **الآخرين** فقط (V1′) فالشاشة تعمل للحامل لكن عدّاد `activeSuperAdmins` ينقص ⇒ قد يُسمح واجهياً بتعليق الحامل المخفي (الخادم يرفضه — ازدواجية موثّقة).

### 7.3 مكونات الحماية (ProtectedRoute / RequireAuth)

- **الملف:** `src/components/auth/RequireAuth.tsx`
- **مصدر الصلاحيات:** `useAuth()` — جلسة Supabase فقط (`session !== null`).
- **يعتمد على slug / `'*'`:** لا — لا يوجد أي فحص أدوار على مستوى المسارات كلياً (`nav-items.ts` شجرة ثابتة بلا ترشيح صلاحيات؛ كل الأوراق ظاهرة للجميع وتُحمى كل شاشة محلياً + على الخادم).
- **ماذا يحدث إذا أُخفي `super_admin`؟** لا شيء مباشرة — لكن غياب بوابة مسار يعني أن «الأمان» كله في بوابات الشاشات + RLS/RPC.

### 7.4 Hooks الصلاحيات

| Hook                                                                                   | مصدر القدرة                                                                                   | slug / `'*'`؟                                     | أثر إخفاء `super_admin`                                                                 |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `useNotificationAccess` (`src/hooks/useNotificationAccess.ts:63-64`)                   | RPCs خادمية: `can_manage_notification_templates()` + `can_manage_email_transport()` (Boolean) | لا — **النمط الموصى به**                          | لا شيء إن بقيت القدرة محسوبة خادمياً ✅                                                 |
| `useAppIdentity` (`src/hooks/useAppIdentity.ts:158`)                                   | RPC `can_manage_app_identity()`                                                               | لا                                                | لا شيء ✅                                                                               |
| `useLocalizationAdmin` (`src/hooks/useLocalizationAdmin.ts:127`)                       | RPC `can_manage_appearance()`                                                                 | لا                                                | لا شيء ✅                                                                               |
| `useRolesManagement` (الحارسات `getSaveBlocker`/`getPermissionProtection`)             | اشتقاق محلي من المصفوفة                                                                       | نعم — كلاهما                                      | الحارسات تُعطّل/تُخطئ ❌                                                                |
| `useUsersManagement` (`getStatusChangeBlocker` + `actorIsSuperAdmin`)                  | اشتقاق محلي من قائمة `profiles`                                                               | نعم — slug                                        | الحارسات تُعطّل ❌                                                                      |
| `useSupportManagement` (`resolveActorCapabilities` تقريباً 560-622)                    | استعلام عميل على `profiles` + `user_roles` + تضمين `role_permissions(permissions(slug))`      | **نعم — كلاهما + slug `'admin'` مضمّن** (سطر 591) | جزئي: الكشف عن `super_admin` ينهار، لكن القدرة قد تبقى عبر `'*'` أو `support.manage` ⚠️ |
| `BackupManagement` — `accessQuery` (`src/pages/settings/BackupManagement.tsx:116-131`) | استعلام عميل مباشر `profiles.status` + `user_roles → roles(slug)`                             | نعم — slug فقط (سطر 129)                          | **البوابة تُغلق** حتى لو كان الخادم سيقبل (الخادم يشترط slug أيضاً — اتساق مؤقت) ⚠️     |

### 7.5 مكونات أخرى

- **`SettingsPage.tsx`** — يوجّه الأقسام؛ القفل الوحيد المركزي للإشعارات عبر `NotificationsSection` + `useNotificationAccess` (سطور 130-160) وبقية الأقسام تُحمَّل ثم تحمي نفسها.
- **`SupportManagement.tsx`** — يعتمد `actorIsSupportAgent`/`actorIsActive` من hook الدعم (سطور 505-506، 727).
- **`GeneralSettings.tsx:539-553`** و**`LocalizationSettings.tsx:710-724`** — بوابة `admin.canManage` (RPC خادمي) و403 عند `!canManage`.
- **`AuthContext.tsx`** — جلسة فقط؛ الأدوار **ليست** في JWT ولا في Context.

---

## 8. تحليل المخاطر والثغرات

### 8.1 ثغرات حرجة (Critical)

1. **التماسك حول صلاحية واحدة: `is_admin()` ≡ `has_permission('*')`** (`20260930000000:155-162`).
   كل البوابات الإدارية (نحو 40 موضعاً في الترحيلات + 8 سياسات RLS + 3 سياسات تخزين) تمر من نقطة تفرّع واحدة مرتبطة بسطر بيانات واحد في `permissions` (`slug='*'`). أي تعديل مستقبلي لدلالات `'*'` أو حذفه أو نقله يُعطّل النظام كله دفعة واحدة؛ وأي منح خاطئ له يمنح «كل شيء» دفعة واحدة. تحديث `is_super_admin` سيطلب بالضرورة إعادة تعريف هذه النواة و40 موضعاً معتمداً عليها.
2. **العَرَض الجذري F3: دور `admin` يملك `roles.manage` لكن لا يستطيع استخدامها** (`seed.sql:46-56` مقابل `20261001130000:196-200,445-447`).
   كل RPCs إدارة الأدوار (`admin_set_user_roles`، `admin_set_role_permissions`، `admin_set_user_status`) تشترط `is_admin()` أي `'*'`. النتيجة: إدارة الأدوار محصورة فعلياً في `super_admin` — وهو السبب الجذري لفكرة «الحساب الإلهي المخفي» (موثّق في التقرير الاستشاري §الخلاصة). إصلاحه أولى من أي إخفاء.
3. **تعارض دلالات التفويض: قدرة (`'*'`) مقابل عضوية (`slug = 'super_admin'`)** داخل نفس النظام:
   - الخادم: بوابات النسخ (`admin_trigger_manual_backup`/`admin_update_backup_settings`/سياسات backup الثلاث) تشترط **عضوية slug** — حامل `'*'` عبر دور مخصص **مرفوض**.
   - الخادم: بوابات RBAC تشترط **القدرة `'*'`** — حامل slug `super_admin` بدور مُجرَّد من `'*'` (مستحيل اليوم بفضل `system-role-locked`) لكن حامل `'*'` بلا slug **مقبول**.
   - العميل: شاشتا الأدوار/النسخ تختلفان (إحداهما `'*'` والأخرى slug)، و`useSupportManagement` يخلط الثلاثة + slug `'admin'` مضمّناً (سطر 591).
     أي مسعى نحو `is_super_admin` فوق هذا التضارب يضاعف الالتباس — يجب توحيد الدلالة **قبل** أي تغيير.
4. **بوابة الواجهة تستمد الحقيقة من محتوى القوائم** (`useRolesManagement.ts:575-580` · `useUsersManagement.ts:240,401` · `BackupManagement.tsx:129`) — لا قناة قدرات مستقلة. إخفاء `super_admin` (V1) دون بناء `my_capabilities()`/`is_super_admin` أولاً **يكسر الشاشتين الإداريتين للحامل نفسه** (403 مؤكد — اختبارات `RolesPermissions.test.tsx:124` تثبّت السلوك). النمط السليم موجود فعلاً في `useNotificationAccess` ويجب تعميمه.
5. **لا يوجد مسار استعادة لفقدان `super_admin`** (RISK-10 في التقرير الاستشاري): `grant-first-super-admin.sql` يرفض أي رجوع (سطور 109-112، 128-136) ولا توجد أداة استعادة مقابلة — انقطاع الدور الوحيد = انقطاع الإدارة ما لم يُفتح SQL Editor.

### 8.2 ثغرات متوسطة (Medium)

6. **عدّادات/تجميعات تكشف وجود الدور:** `assigned_user_count` في `role_permission_matrix` (`20260930160000:97`) و`activeSuperAdmins` في العميل — أي إخفاء مستقبلي يجب أن يعالجها (RISK-05).
7. **`alter default privileges ... grant all on tables to service_role`** (`20260930000000:328`) — كل جدول مستقبلي يرث ALL لـ `service_role`؛ اعتماد على انضباط الترحيلات اللاحقة لا على سياسة صريحة.
8. **حارس «آخر مسؤول» غير موحّد المعنى:** `admin_set_role_permissions` يعدّ حاملي `'*'` فقط (`20261001130000:555-573`) بينما النسخة القديمة (`20260930160000:270-274`) كانت تعدّ `'*' or 'roles.manage'`، و`admin_set_user_roles` يعدّ **عضوية `super_admin`** وحاملي `'*'` معاً (317-348)، و`admin_set_user_status` يعدّ العضوية فقط (66-87). ثلاثة تعريفات مختلفة لـ «آخر مسؤول» = ثلاث مفاجآت محتملة عند أي تغيير نموذج.
9. **المنطق المكرر بين العميل والخادم:** حارسا `getStatusChangeBlocker` و`getSaveBlocker` + حساب `actorIsSuperAdmin` ثلاث نسخ منطق تطابق ما في SQL؛ انجراف أي نسخة = ثغرة عرض أو إنكار خدمة واجهية (الخادم يبقى الحد الفاصل الحقيقي).
10. **`service_role` يقرأ كل الجداول الخمسة الحساسة** (SELECT متروك عمداً) + تجاوز RLS — مقبول تشغيلياً (عامل النسخ/المهام) لكنه سطح تسريب دائم (RISK-09: ملفات النسخ).
11. **سلسلة التسريبات الجانبية الموثّقة في التقرير الاستشاري** (RISK-04..RISK-08): رسائل `unknown role slug(s)` (`20261001130000:237`) تُظهر الأسماء؛ تضمينات الدعم (`useSupportManagement.ts:564`) تكشف أدوار الآخرين؛ Realtime على `profiles` (`20260930150000`) بأحداث DELETE غير مصفّاة؛ seed يمنح `admin@example.com` دور `super_admin` تلقائياً (`seed.sql:108-113`).
12. **غياب MFA** على مستوى مشروع Supabase (`supabase/config.toml` — `[auth.mfa]` معطّل) مع وجود حساب `'*'` دائم (RISK-01).
13. **لا يوجد قيد يمنع منح `'*'` لدور غير نظامي:** `admin_set_role_permissions` يجبر `super_admin` على الاحتفاظ بـ `'*'` فقط، ولا يمنع إسناده لدور آخر — فتنهار مطابقات slug في الواجهة (القسم 8.1.3) وتتحول «الاستثناء» إلى «مجموعة».

### 8.3 ثغرات منخفضة (Low)

14. **غياب تدقيق تغييرات SQL Editor:** `write_audit_log` يرفض غير المستخدم النشط، ومنح `grant-first-super-admin` يكتب `actor_id = null` عمداً — أي تعديل يدوي على الأدوار غير مرئي للتطبيق (يُطلب Reconciler/triggers — مؤجل إلى مرحلة التنفيذ).
15. **`auth.role() = 'authenticated'`** في سياسات قراءة الكتالوج — تعمل لكنها أقل دقة من `to authenticated` الصريح (توحيد لاحق).
16. **اختبارات تثبّت الحالة الراهنة** (`useRolesManagement.test.ts` و`RolesPermissions.test.tsx` و`useUsersManagement.test.tsx`…) — أي تغيير نحو `is_super_admin` سيعطّلها؛ وهذا **مقصود** (حارسات انحدار) لكنه يجب أن يُدار بوعي في مرحلة التنفيذ.
17. **تعليقات ومساعدات تشخيصية** (admin-capability-audit وtest-account-*) تعيد بناء منطق `'*'` يدوياً — ستنجرف صامتاً إن تغيّرت النواة دون مزامنتها.

---

## 9. التوصيات والأولويات

### 9.1 الحد الأدنى القابل للنشر (Minimum Viable Hardening)

> ترتيب زمني مقترح؛ كل بند مستقل قابل للاختبار، ولا يُنشر أي إخفاء قبل البند 1.

1. **قناة قدرات خادمية أولاً** — دالة تعريفية واحدة مثل `my_capabilities()` (أو `is_super_admin()`) تعيد Booleanات فقط، وتُبنى عليها بوابات الشاشات (نمط `useNotificationAccess` جاهز للتعميم). **شرط مسبق إلزامي** لأي إخفاء (التقرير الاستشاري — النتيجة 1).
2. **إصلاح F3** — تمكين حاملي `roles.manage` فعلياً من `admin_set_user_roles`/`admin_set_role_permissions` (بوابات الدوال لا تتغير حراسها)، فتنحسر الحاجة إلى «حساب إلهي» اليومي. أثره محصور في بوابات RPC + الواجهة.
3. **توحيد دلالة التفويض** — قرار صريح: قدرة أم عضوية؟ ثم مواءمة: بوابات النسخ الخادمية + `BackupManagement.tsx:129` + `useUsersManagement.ts:240` + `useSupportManagement.ts:587-610` (وإزالة slug `'admin'` المضمّن في 591).
4. **حصار `'*'`** — منح `'*'` لغير الأدوار النظامية يُمنع بحارس في `admin_set_role_permissions` (وعدّاد `assigned_user_count` يُستثنى منه الدور المميَّز لاحقاً).
5. **ضبط `service_role`** — سحب `alter default privileges ... to service_role` العام واستبداله بمنح صريح لكل جدول جديد + مراجعة حاجة `service_role` لـ SELECT على `roles`/`user_roles`.
6. **مسار استعادة `super_admin`** — سكربت استعادة منفصل (لا يتعارض مع قفل `grant-first-super-admin`) + runbook + اعتماد ثنائي — يعالج RISK-10 (أخطر فجوة قائمة).
7. **تحديث الاختبارات بالتوازي** (خارج هذه المرحلة!) — كل fixture في القسمين 2.5 و3.2 تصبح حارس انحدار إلزامي عند أي تغيير.

### 9.2 المهام المؤجلة

- **الدور المخفي / JIT Elevation** (الخيار «د» المعتمد مبدئياً في التقرير الاستشاري) — بعد البند 1 و3 و4 أعلاه فقط؛ ويشمل: تماثل الأخطاء (`P0002`)، تنظيف العدّادات، تدقيق Realtime، و`is_super_admin` في كل مواضع القسمين 2 و3.
- **MFA إلزامي** على حسابات المشروع + مدير كلمات مرور.
- **Reconciler/Triggers للتدقيق** على `user_roles`/`role_permissions` (تنبيه عند أي منح/سحب) + إشعارات الاستخدام.
- **مواءمة تعريفات «آخر مسؤول»** الثلاثة (المادة 8.2.8) إلى ثبات واحد.
- **تنظيف التسريبات الجانبية** (رسائل الأخطاء، تضمينات الدعم، Realtime payload).
- **توحيد صيغ `to authenticated`** في السياسات + إعادة مراجعة `admin-capability-audit.sql` وسكربتات QA مع أي تغيير نواة.

---

## 10. الملاحق

### 10.1 قائمة الملفات المفحوصة

**قاعدة البيانات (قراءة كاملة):**

- `supabase/migrations/20260930000000_init_core_schema.sql`
- `supabase/migrations/20260930120000_harden_profiles_and_definer_functions.sql`
- `supabase/migrations/20260930150000_enable_profiles_realtime.sql`
- `supabase/migrations/20260930160000_rbac_atomic_operations.sql`
- `supabase/migrations/20260930170000_backup_system_schema.sql`
- `supabase/migrations/20260930180000_backup_atomic_lock.sql`
- `supabase/migrations/20261001130000_core_security_hardening.sql`
- `supabase/migrations/20261001140000_support_system_schema.sql`
- `supabase/migrations/20261001150000_app_identity_schema.sql`
- `supabase/migrations/20261001160000_localization_system_schema.sql`
- `supabase/migrations/20261002120000_notification_transports_and_secrets.sql`
- `supabase/migrations/20261002150000_notification_templates_schema.sql`
- `supabase/migrations/20261003100000_notification_deliveries_schema.sql`
- `supabase/migrations/20261003110000_notification_bundle_rpc.sql`
- `supabase/seed.sql` · `supabase/config.toml`

**سكربتات:**

- `scripts/sql/grant-first-super-admin.sql` · `scripts/sql/admin-capability-audit.sql` · `scripts/sql/test-account-bootstrap.sql` · `scripts/sql/test-account-teardown.sql`
- `scripts/audit/database.mjs` (استدعاءات `admin_set_user_roles`) · `scripts/audit/supabase-fixture.sql`

**الواجهة الأمامية (قراءة/بحث):**

- `src/hooks/useRolesManagement.ts` · `src/hooks/useUsersManagement.ts` · `src/hooks/useSupportManagement.ts` · `src/hooks/useNotificationAccess.ts` · `src/hooks/useBackupManagement.ts` · `src/hooks/useAppIdentity.ts` · `src/hooks/useLocalizationAdmin.ts`
- `src/pages/SettingsPage.tsx` · `src/pages/settings/RolesPermissions.tsx` · `src/pages/settings/UsersManagement.tsx` · `src/pages/settings/BackupManagement.tsx` · `src/pages/settings/SupportManagement.tsx` · `src/pages/settings/GeneralSettings.tsx` · `src/pages/settings/LocalizationSettings.tsx`
- `src/context/AuthContext.tsx` · `src/components/auth/RequireAuth.tsx` · `src/components/layout/nav-items.ts` · `src/lib/database.types.ts`

**الاختبارات (تشغيل + فحص — دون تعديل):**

- `src/hooks/useRolesManagement.test.ts` · `src/hooks/useUsersManagement.test.tsx` · `src/hooks/useSupportManagement.test.tsx` · `src/pages/SettingsPage.audit.test.tsx` · `src/pages/settings/RolesPermissions.test.tsx` · `src/pages/settings/SettingsPage.notificationsGate.test.tsx` — ومعها كامل حزمة الاختبارات (27 ملفاً / 186 اختباراً — كلها ناجحة).

**مراجع وثائقية:**

- `docs/consultations/2026-10-04-hidden-super-admin-design-study.md` · `docs/consultations/roles-permissions-design-study.md` · `docs/runbooks/first-time-admin-setup.md`

### 10.2 الاستعلامات المستخدمة في الجرد

> جميعها أوامر قراءة/بحث فقط (grep/find) — لم يُشغَّل أي SQL على قاعدة بيانات، ولم يُنشئ شيء:

```bash
# 1) مواضع '*' (كل الامتدادات)
grep -rn --include='*.sql' --include='*.ts' --include='*.tsx' -E "'\*'" .

# 2) مواضع super_admin / is_super_admin
grep -rn --include='*.sql' --include='*.ts' --include='*.tsx' -E "super_admin|super-admin|is_super_admin" .

# 3) كل دوال SQL (بناء سطري RPCs)
grep -rn --include='*.sql' -iE "create (or replace )?function" supabase scripts

# 4) كل سياسات RLS
grep -rn --include='*.sql' -iE "create policy|drop policy" supabase scripts

# 5) كل GRANT / REVOKE
grep -rn --include='*.sql' -iE "\bgrant\b|\brevoke\b" supabase scripts

# 6) استدعاءات RPC من الواجهة
grep -rn --include='*.ts' --include='*.tsx' -iE "rpc\(|\.rpc|admin_list|admin_set|admin_delete|admin_create" src scripts

# 7) فحوص slug/الصلاحية في الواجهة
grep -rn --include='*.ts' --include='*.tsx' -E "permissions\.includes|user\.role|hasPermission|roles\.includes|\.slug ===" src

# 8) تدفق has_permission / is_admin في SQL
grep -n "has_permission\|is_admin()\|is_active_user()\|is_support_agent()" supabase/migrations/*.sql supabase/seed.sql scripts/sql/*.sql

# 9) التحقق من عدم وجود واجهات مطلوبة
grep -rn "admin_set_user_roles\|admin_list_roles\|admin_create_role\|admin_delete_role\|admin_list_users" src scripts supabase

# 10) مسارات القراءة من الجداول الحساسة في الواجهة
grep -n "from('role_permission_matrix')\|from('profiles')\|from('user_roles')" src/hooks/*.ts src/pages/settings/*.tsx

# 11) الاختبارات (للتأكد من عدم الكسر — دون تعديل)
npm ci && npm test     # → 27 files / 186 tests passed
```

**إفصاح الامتثال للمرحلة (READ-ONLY):** أُنشئ هذا الملف وحده (`docs/consultations/2026-10-05-rbac-audit-report.md`). لم يُدخل أي تعديل على أي ملف قائم، ولم تُنشأ ترحيلات أو دوال RPC أو سياسات RLS، ولم تُشغَّل سوى الاختبارات الحالية كما هي.
