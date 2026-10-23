# تحقق مستقل من إصلاحات اعتمادات المستخدمين ورسائل التسجيل

| البند          | القيمة                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| التاريخ        | 2026-10-18                                                                                                                                                                  |
| الفرع          | `arena/df1effa3-admin-system` (مبني على `main` عند `bfe9013`)                                                                                                               |
| النطاق         | التحقق من صحة الإصلاحات المُدمجة عبر PR #47 (المرحلة 1) وPR #48 (المرحلة 2) من [تقرير الـ RCA](../consultations/2026-10-18-approval-visibility-and-signup-messaging-rca.md) |
| النتيجة        | **كل الفحوصات خضراء** — vitest 214/214 · typecheck · lint · Prettier · build · تدقيق قاعدة 35/35 على PostgreSQL 17                                                          |
| إصلاحات إضافية | لا حاجة لأي إصلاح وظيفي؛ أُضيف تصحيحان توثيقيان فقط (§4)                                                                                                                    |

---

## 1) مصفوفة التحقق (الإصلاح ← الدليل ← النتيجة)

| #   | الإصلاح (المصدر)                      | الدليل المُتحقَّق منه                                                                                                                                                                                                                     | النتيجة                             |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | تلميح `user_roles!user_id` — PR #47   | `PROFILE_COLUMNS` (`useUsersManagement.ts`) و`TICKET_COLUMNS`/`REPLY_COLUMNS` (`useSupportManagement.ts`) + استعلام `fetchActorAccess` — كلها تحمل التلميح، ولا يوجد أي دمج خالٍ منه في `src/`                                            | ✅                                  |
| 2   | اختبار تراجعي ضد PGRST201 — PR #47    | `postgrest-embeds.test.ts` (9 اختبارات): يثبّت وجود `user_roles!user_id(`، ويرفض أي `user_roles(` غامض، ويمنع إعادة تسمية مفتاح الاستجابة                                                                                                 | ✅                                  |
| 3   | اختيار الدور لحظة الاعتماد — PR #48   | `admin_approve_user` 4-arg (`p_target_role`) في `20261018120000_approval_role_selection.sql`: منح الدور المختار في نفس المعاملة، رفض `owner` و`is_super_admin` بـ `invalid_role`، و`viewer` افتراضيًا                                     | ✅ مُثبت بفحصي القاعدة #4 و#5 أدناه |
| 4   | Edge Function `approve-user` — PR #48 | تمرير `targetRole` اختياريًا مع تحقق من الصيغة `/^[a-z][a-z0-9_]{0,29}$/` قبل التسليم                                                                                                                                                     | ✅                                  |
| 5   | حوار الاعتماد في الواجهة — PR #48     | `ConfirmApprovalDialog` (portal + focus trap + Escape) بقائمة `viewer`/`editor`/`admin` (`APPROVAL_ROLES`)، والرفض يبقى بنقرة واحدة                                                                                                       | ✅                                  |
| 6   | استقرار `actorCanApprove` — PR #48    | `fetchActorAccess` يقرأ صف المُعتمد **نفسه** عبر `usersActorAccessQueryKey` (RLS: قابل للقراءة الذاتية حتى `pending`) — مستقل تمامًا عن الفلتر/الكاش، ويطابق بوابة الخادم `owner`/`super_admin`                                           | ✅                                  |
| 7   | رسائل التسجيل — PR #48                | `SignupOutcome = 'first-owner' \| 'pending-approval'` في `AuthContext.tsx` (التمييز عبر التأكيد التلقائي + قراءة `approval_status`)، و`Login.tsx` يوجّه للتنبيه المناسب، و`signup.firstOwner`/`signup.pendingApproval` في `ar.ts`/`en.ts` | ✅                                  |
| 8   | رسائل نجاح الاعتماد/الرفض — PR #48    | `users.success.approved` («تمت الموافقة على {name} ومنحه دور {role}.») و`users.success.rejected` («تم رفض طلب تسجيل {name}.») — بدلًا من `statusUpdated` العام، بتوازي en/ar                                                              | ✅                                  |
| 9   | ثوابت الأمان دون تغيير                | بوابة الاعتماد `owner`/`super_admin` في القاعدة (فحص #5)، حماية المالك الأصلي `is_original_owner` (فحص #3)، رفض كتابة الأدوار المحمية (فحص #2)                                                                                            | ✅                                  |

---

## 2) الفحوصات المنفَّذة (كلها من داخل المستودع، بلا TCP وبلا أي سرّ)

### 2.1 الواجهة/الجودة

```bash
npm ci
npm run test          # 214 passed (29 files)  ← يطابق عدّاد PR #48
npm run typecheck     # نظيف
npm run lint          # نظيف
npm run format:check  # All matched files use Prettier code style!
npm run build         # ✓ built successfully
```

### 2.2 قاعدة البيانات — قاعدة fixture مضمّنة (PostgreSQL 17.10)

أُعيد بناء العنقود وأُعيد تشغيل **كل** الهجرات (24 ترحيلًا) ثم شُغِّل التدقيق وفق الدليل المعتمد في
[runbook التحقق](../consultations/2026-10-02-notification-transports-phase1-verification-runbook.md) §4:

```bash
node scripts/audit/database.mjs --reset-fixture
# → 35 database checks passed. Evidence: .cache/live-audit/database-results.json
```

أبرز الفحوص المباشرة عن هذا العمل:

1. `approval grants the chosen non-protected role and refuses protected roles` — فحص جديد من #48.
2. `only owner/super_admin may approve; viewer is denied; rejections are audited`.
3. `first Auth signup is confirmed and elevated once; later signups ignore role metadata`.
4. `owner is protected and explicitly holds every permission while super_admin remains unchanged`.
5. `owner role, account, permissions and Auth identity reject SQL and RPC writes`.
6. `every migration and seed replay on PostgreSQL 17` — سلامة سلسلة الهجرات كاملة بعد `20261018120000`.
7. `RLS on every public table and no anonymous SECURITY DEFINER execution`.
8. `users RPC rejects self-suspension and non-admin callers`.

(وقائمة الفحوص الـ 35 كاملة محفوظة في `.cache/live-audit/database-results.json` — مسار تجاهله Git عمدًا؛ أدوات القاعدة المضمّنة ليست اعتمادًا للتطبيق.)

---

## 3) ما تبقّى اختياريًا على جهة المشروع الحي (خارج نطاق هذا الفرع)

1. **فحص `curl` الحي** من §4.6.1 في تقرير الـ RCA — يؤكد السلوك قبل/بعد على المشروع المُستضاف (يحتاج وصول المشروع؛ لا تُمرَّر الأسرار في المستودع أو المحادثة).
2. **E2E يدوي:** تسجيل مستخدم ← ظهوره في «المعلقون» ← اعتماده بدور `editor` ← دخوله بدوره ← ثم تجربة الرفض.

---

## 4) الإصلاحات التوثيقية المضافة على هذا الفرع

1. `src/hooks/useSupportManagement.ts` — تعليق الترويسة كان يصف الدمج القديم `user_roles(roles(...))`؛ صُحِّح إلى `user_roles!user_id(roles(...))` مع الإشارة إلى سبب التلميح (الكود نفسه كان سليمًا منذ #47).
2. [تقرير الـ RCA](../consultations/2026-10-18-approval-visibility-and-signup-messaging-rca.md) — تحديث صف «الحالة» و«الخطوة التالية» ليعكسا الإدماج (#47/#48) ورابط التحقق هذا (كانتا تقولان «بانتظار الموافقة»).
