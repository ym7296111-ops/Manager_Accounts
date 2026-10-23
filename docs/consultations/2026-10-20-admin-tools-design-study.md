# أدوات إدارة المستخدمين: الدعوة المباشرة وإعادة تعيين كلمة المرور

> **حالة الوثيقة:** دراسة تصميم جديدة، أُلِّفت بعد اعتماد القرارات D1–D6 وبعد تنفيذها
> والتحقق منها. ليست نسخة محفوظة من تقرير سابق — لا يوجد في `docs/consultations/` تقرير
> سابق عن أدوات الأدمن، وقد كُتب هذا الملف من القرارات المعتمدة ومن قراءة الكود الفعلي.
>
> **التاريخ:** 2026-10-20 · **الفرع:** `arena/854d5919-admin-system`
> **الترحيل:** `supabase/migrations/20261024000000_admin_invite_and_set_password.sql`

---

## 1. المشكلة

لم يكن أمام مسؤول النظام إلا مساران لإدخال شخص إلى النظام، وكلاهما غير كافٍ:

1. **الانتظار** حتى يسجّل الشخص نفسه، ثم اعتماده من قائمة المعلّقين. هذا يفترض أن
   الشخص يعرف أن النظام موجود وأن عنوانه مفتوح للتسجيل.
2. **مسار الاستعادة المؤجَّل** (`password_reset_requests`)، وهو مصمَّم لحالة مختلفة
   أصلاً: مستخدم **قائم** نسي كلمته، لا مستخدم **جديد** يجب إنشاؤه.

النتيجة أن المسؤول لم يكن يملك طريقة مباشرة لإنشاء حساب وتسليمه لصاحبه، ولا طريقة
لمساعدة مستخدم معتمد فقد الوصول دون انتظار طلب استعادة.

## 2. القرارات المعتمدة

| #   | القرار                                                 | أثره التنفيذي                                                      |
| --- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| D1  | كلمة المرور تُعرض على الشاشة **مرة واحدة** ولا تُخزَّن | مكوّن `PasswordRevealDialog` مشترك، والقيمة تعيش في حالة React فقط |
| D2  | الدعوة وإعادة التعيين لـ `owner` / `super_admin` فقط   | الزر **غائب** لا معطّل، وإعادة الفحص في SQL                        |
| D3  | لا علم «إجباري التغيير»                                | سطر تنبيه ثابت في الحوارين، لا حقل ولا عمود في المخطط              |
| D4  | ١٦ حرفاً `A-Za-z0-9` بدون رموز ملتبسة                  | أبجدية من ٥٦ رمزاً في `_shared/temp-password.ts`                   |
| D5  | دور `executive` يُعرض في قائمة الدعوة                  | `INVITE_ROLES = ['viewer','editor','admin','executive']`           |
| D6  | إعادة تعيين كلمة مرور المالك الأصلي ممنوعة             | إعادة استخدام `public.is_original_owner(uuid)` القائمة             |

## 3. الوضع الحالي — مُتحقَّق منه من الكود

> كل سطر أدناه قُرئ من المستودع، لا من الذاكرة. الأسطر مذكورة لأن بعضها غيّر قراراً
> تنفيذياً أثناء العمل (انظر §6).

| العنصر                    | الواقع                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| دور `executive`           | **موجود** — `20261020000000_add_executive_dashboard_role.sql:3`، صلاحية واحدة `dashboard:read`                                          |
| دور `owner`               | **موجود** بـ `is_super_admin = true` — `20261016120000_add_owner_role_and_grant_all_permissions.sql`                                    |
| حماية المالك الأصلي       | **دالة جاهزة** `public.is_original_owner(uuid)` في `20261017010000_protect_original_owner.sql`، ممنوحة لـ `authenticated, service_role` |
| صلاحيات المنفّذ           | «نشط + معتمد + يملك `owner` أو `super_admin`» — نفس predicate في `admin_approve_user` و`admin_claim_password_reset_request`             |
| إنشاء البروفايل           | محفّز `on_auth_user_created` → `handle_new_user()`                                                                                      |
| **الدور عند التسجيل**     | **لا شيء** — «Later signups receive NO role until an authorized approval» (`20261017000000_add_user_approval_workflow.sql`)             |
| `audit_logs.action`       | نوع **enum** (`public.audit_action`)، فلا يُضاف حدث جديد في نفس المعاملة؛ العرف هو وضع اسم الحدث في `metadata.event`                    |
| `audit_logs` أعمدة إضافية | `actor_type`, `actor_ref` — قابلة للفراغ (`20261005120000_harden_super_admin.sql:66-67`)                                                |
| Edge Functions            | `approve-user`, `admin-reset-password` — نمط موحَّد: JWT ← عميل service ← RPC                                                           |
| فحص Edge Functions        | **لا يوجد** — `eslint` يتجاهل `supabase/functions/**`، و`tsconfig` يشمل `src` فقط، و`vitest` يشمل `src/**/*.test.*`                     |

## 4. البنية المنفَّذة

```
الشاشة (UsersManagement.tsx)
  ├─ زر «إضافة مستخدم»        → InviteUserDialog
  └─ زر «إعادة تعيين كلمة المرور» → ResetPasswordDialog
                                        ↓
Hook (useUsersManagement)      inviteUser / resetUserPassword
                                        ↓  functions.invoke
Edge Function                  admin-invite-user      admin-set-password
  │  إنشاء الحساب                   │                       │
  │  auth.admin.createUser         │                       │
  └─ توليد كلمة المرور      _shared/temp-password.ts       │
                                        ↓  service_role     ↓
SQL (SECURITY DEFINER)      admin_invite_user    admin_verify_password_reset_authority
                                                  → auth.admin.updateUserById
                                                  → admin_record_password_reset
```

**لماذا SQL هي نقطة التحكيم لا الواجهة؟** لأن الواجهة تُخفي الزر فقط. أي مستخدم يملك
مفتاح `anon` يستطيع استدعاء Edge Function مباشرة، وكل ما يوقفه هو أن `EXECUTE` ممنوح
لـ `service_role` وحدها — فـ `anon` و`authenticated` لا يصلان إلى جسم الدالة أصلاً. لهذا
لا يوجد فحص `request.jwt.claim.role` في الدوال الجديدة: لقد أُزيل من `admin_approve_user`
لهذا السبب تحديداً في `20261019000000_remove_service_role_check.sql`.

### ترتيب مراحل إعادة التعيين — مقصود

```
١. admin_verify_password_reset_authority   (بوابة، بلا كتابة)
٢. auth.admin.updateUserById               (الكتابة الفعلية في GoTrue)
٣. admin_record_password_reset             (سجل التدقيق)
```

إذا فشلت المرحلة ٣ بعد نجاح ٢، فإن كلمة المرور **قد تغيّرت فعلاً**. إخفاؤها في تلك
اللحظة يترك حساباً لا يعرف أحد كلمته — وهو أسوأ من سطر تدقيق ناقص يمكن تداركه. لذلك
يعيد الخادم الكلمة مع `auditRecorded: false`، وتعرض الواجهة تحذيراً بجانبها.

## 5. كلمة المرور المؤقتة

الأبجدية (٥٦ رمزاً) بعد استبعاد `0 1 O o I l`:

```
23456789 ABCDEFGHJKMNPQRSTUVWXYZ abcdefghijkmnpqrstuvwxyz
```

- ٥٦¹⁶ ≈ ٢⁹³ من الإنتروبيا.
- **أخذ بالرفض (rejection sampling)** لا `byte % 56`: لأن ٢٥٦ ليس مضاعفاً لـ ٥٦، فالقسمة
  البسيطة تجعل أول ٣٢ رمزاً أرجح بنحو ١٤٪. البايتات في الذيل المنحاز تُتجاهل.
- المصدر `crypto.getRandomValues` (CSPRNG)، لا `Math.random`.

**أين لا توجد الكلمة:** لا جدول، لا `metadata` في `audit_logs`، لا سطر سجل، لا
`localStorage`. اختبار التدقيق يفحص ذلك صراحةً:

```js
assert.deepEqual(Object.keys(logged[0].metadata).sort(), ['event', 'executor_role']);
```

## 6. انحرافات عن المواصفة الأصلية — وأسبابها

### ٦.١ أسماء الـRPCs (معتمد مسبقاً)

`claim` في هذا المستودع يعني **قفل صف معلّق وأخذه ذرّياً** — راجع
`admin_claim_password_reset_request` («locks the pending row») و`admin_claim_next_backup_job`.
والدالة المطلوبة لا تقفل ولا تكتب شيئاً، فاسم `claim` فيها يوهم بوجود صف مقفل. كذلك لا
توجد بين الـ٢٦ دالة `admin_*` أي دالة تحمل بادئة مكرّرة.

| الاسم المقترح                       | الاسم المنفَّذ                              |
| ----------------------------------- | ------------------------------------------- |
| `admin_claim_admin_password_reset`  | **`admin_verify_password_reset_authority`** |
| `admin_record_admin_password_reset` | **`admin_record_password_reset`**           |

### ٦.٢ عدّاد الهجرات

كان في المواصفة «29 → 30». عند بدء التنفيذ كان `origin/main` قد تقدّم إلى `a3d6a23`
(PR #66)، فأصبح الواقع **29 هجرة و38 فحصاً**. الهدف الصحيح إذن **29 → 30** هجرة،
والنتيجة النهائية **40 فحصاً**.

### ٦.٣ منطق أُضيف ثم حُذف — أخطأ التدقيق افتراضاً

كُتبت في المسودة الأولى كتلة تحذف دور `viewer` من المستخدم المدعوّ، استناداً إلى أن
`handle_new_user()` يمنح `viewer` تلقائياً. **هذا صحيح لنسخة `20261016000000` من
المحفّز فقط**؛ فقد استُبدلت في `20261017000000` بنسخة تنصّ صراحةً:

```sql
-- Later signups receive NO role until an authorized approval. Owner only.
```

أثبت التدقيق ذلك عملياً قبل أن يُدمج أي شيء:

```
profile: [{"approval_status":"pending","status":"active"}]
roles:   []          ← لا viewer أصلاً
```

فحُذفت الكتلة. إبقاؤها كان سيعني كوداً ميتاً يحمل تعليقاً يجزم بواقعة غير صحيحة —
وهو أسوأ من غياب الكود، لأنه يوثّق وهماً. **هذا بالضبط سبب وجود فحص التدقيق قبل
الدمج لا بعده.**

### ٦.٤ `invalid-email` — إضافة صغيرة على تصنيف الأخطاء

المواصفة حدّدت أربعة أخطاء للدالة: `email_exists`, `invalid_role`, `permission_denied`,
`unavailable`. أُضيف `invalid_email` لأن نفس الفحص يعمل **متزامناً في المتصفح قبل
إرسال الطلب**، وإظهار «خطأ غير متوقع» لعنوان ناقص رسالة كاذبة. التصنيف في الـhook
اختياري أصلاً (المواصفة قالت «نفس نمط `changeApproval`»).

### ٦.٥ وحدة مشتركة بدل تكرار المولِّد

الدالتان تحتاجان سياسة كلمة مرور متطابقة. تكرار مولِّد سرّي في ملفين يعني أن أي تعديل
أحدهما يُسكت الآخر. لذلك أُنشئت `supabase/functions/_shared/temp-password.ts` — وهو
المسار الذي تدعمه Supabase لمشاركة الكود بين الدوال دون نشره كدالة مستقلة.

## 7. التحقق

| البوابة                      | النتيجة                                                 |
| ---------------------------- | ------------------------------------------------------- |
| `npm run typecheck`          | نظيف                                                    |
| `npm run lint`               | نظيف (بعد إصلاح `no-unnecessary-type-assertion` واحد)   |
| `npm test`                   | **448/448** في 46 ملفاً                                 |
| `npm run build`              | نجح                                                     |
| `scripts/audit/database.mjs` | **40 فحصاً** · PostgreSQL 17.10 · 30 هجرة مُعاد تشغيلها |
| `npm run format:check`       | نظيف                                                    |

### ما يغطيه فحص التدقيق الجديد

- الدوال الثلاث مغلقة على `anon` و`authenticated`، ومفتوحة لـ `service_role` — بفحص
  `has_function_privilege` لكل دالة × كل دور.
- `viewer` يفشل بـ `42501` في الدعوة.
- **دور يملك `*` فقط (`audit_admin`) يفشل أيضاً** — فـ D2 تشترط الـslug لا الصلاحية
  الشاملة.
- `owner` / `super_admin` / دور غير موجود / سلسلة فارغة → `22023` قبل أي كتابة.
- بعد الدعوة: `approved` + `active` + بريد مؤكَّد + **دور واحد بالضبط**.
- `user.invited` يُسجَّل مرة واحدة، منسوباً إلى المنفّذ.
- المالك الأصلي: الدوال الثلاث ترفضه بـ `42501`، دون إضافة سطر تدقيق.
- `metadata` سجل إعادة التعيين لا يحوي أي مادة سرّية.

## 8. ما لم يُنفَّذ — وعن قصد

- **لا علم «إجباري التغيير»** (D3). إضافة عمود إلى `auth.users` أو `profiles` كانت
  ستلمس كود المصادقة، وهو خارج نطاق المهمة.
- **لا إرسال بريد** بكلمة المرور. التسليم عبر قناة آمنة يختارها المسؤول.
- **لا تعديل على RLS القائمة** ولا على دوال المصادقة أو الإشعارات.
- **لا اختبارات لـEdge Functions** — لا بنية اختبار لها في المستودع أصلاً (§3).
  التغطية الفعلية للسلوك الخادمي جاءت من فحص التدقيق على مستوى SQL، وهو ما يمكن
  تشغيله في CI دون Supabase حيّ.

## 9. خطوات النشر

```bash
supabase db push                      # يطبّق 20261024000000
supabase functions deploy admin-invite-user
supabase functions deploy admin-set-password
```

الترحيل forward-only ولا يعدّل أي كائن قائم: ثلاث دوال جديدة، ومنح `EXECUTE`
لـ `service_role`، وسحب من `public, anon, authenticated`. لا يوجد `DROP` ولا تعديل
على جدول أو سياسة RLS.
