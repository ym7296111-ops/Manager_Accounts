# التفويض الجزئي للصلاحيات — خطة Phase 1

**الحالة:** معتمدة للتنفيذ في Phase 1 وفق القرارات D1–D5 أدناه. هذه الوثيقة تحدّث المقترح الأصلي بعد دمج PR #71 وفحص التنفيذ الحالي.
**النطاق:** `users.approve` و`password_reset.manage` فقط. `settings.manage` مؤجل إلى Phase 2 بعد حصر سياسات RLS المتأثرة.

## القرارات المعتمدة

- **D1 — النطاق:** `users.approve` و`password_reset.manage` فقط. الدعوات (`admin_invite_user`) وتعيين كلمة مرور إداري (`admin-set-password`) يبقيان محصورين في `owner`/`super_admin`.
- **D2 — الإعدادات:** `settings.manage` مؤجل إلى Phase 2.
- **D3 — إدارة التفويضات:** `owner` و`super_admin` فقط يمنحان ويسحبان الصلاحيات.
- **D4 — الانتهاء:** `expires_at` اختياري؛ تقترح الواجهة 90 يوماً افتراضياً مع إمكانية إزالة التاريخ.
- **D5 — إزالة كلمة المرور من قاعدة البيانات:** يحذف `new_password` من `password_reset_requests`. يرسل المسؤول كلمة المرور عند اعتماد الطلب؛ يتولى Edge Function الكتابة إلى GoTrue، ولا تخزن SQL كلمة المرور أو تكتب مباشرة إلى `auth.users`.

## الحالة الحالية المصححة

- يوجد ستة أدوار نظامية: `owner`, `super_admin`, `admin`, `editor`, `viewer`, `executive`.
- `public.has_permission(text)` يفحص صلاحيات الأدوار فقط (`user_roles → role_permissions → permissions`) ويقبل `*` من الدور. `public.is_admin()` يعتمد على `has_permission('*')`.
- `public.get_my_capabilities()` يعيد حالياً صلاحيات الأدوار فقط. كما أن `has_permission()` يفحص `status = 'active'` ولا يطابق حالياً شرط `is_active_user()` الذي يتطلب أيضاً `approval_status = 'approved'`.
- اعتماد المستخدم يمر عبر Edge Function `approve-user` ثم RPC `admin_approve_user`، وله تواقيع قديمة/متوافقة. الفحص النهائي في SQL يتطلب `owner` أو `super_admin`؛ تحديث `has_permission()` وحده لن يفتح هذا المسار.
- استعادة كلمة المرور اليدوية تمر عبر `admin-reset-password` وRPCs `admin_claim_password_reset_request` و`admin_finalize_password_reset_request`. يوجد أيضاً `is_password_reset_admin()` وسياسات RLS للجدول.
- `admin-set-password` مسار مختلف لتغيير كلمة مرور حساب موجود؛ فحص SQL فيه هو `admin_verify_password_reset_authority` ويتبعه `admin_record_password_reset`. هذا المسار يبقى دون تغيير في Phase 1.
- `admin_invite_user` ينشئ حساباً ويمنحه دوراً كاملاً من قائمة مسموحة؛ لا تمنح `users.approve` قدرة الدعوة أو اختيار دور مرتفع.
- `UsersManagement` يطلب حالياً `*`، و`RolesPermissions` يبقى مصفوفة دور × صلاحية محمية بـ`*`. لا نضيف بُعد المستخدم إلى مصفوفة الأدوار.
- سياسات `profiles` تسمح بقراءة الملف الشخصي للذات أو لمن يملك `is_admin()`. يجب عدم توسيعها عموماً لمجرد تفويض اعتماد المستخدمين.

## تصميم Phase 1

### 1. حماية طلبات إعادة تعيين كلمة المرور

الجدول الحالي يخزن كلمة المرور المطلوبة كنص صريح بينما الطلب pending. الترحيل الأمامي:

1. يعرّف حالة الطلب كـenum بالقيم `awaiting_password`, `pending_approval`, `approved`, `rejected`، ويحوّل البيانات القائمة: `pending` إلى `pending_approval` مع إزالة أي كلمة مرور قديمة؛ تبقى الحالات المنتهية `approved`/`rejected`.
2. يزيل قيد دورة حياة كلمة المرور وعمود `new_password` من الجدول. لا تعدّل ملفات الترحيل التاريخية؛ الإزالة نفسها تتم بترحيل جديد.
3. يمنع `anon` و`authenticated` من قراءة الجدول أو تحديثه مباشرة. ينشئ `password_reset_requests_safe` بأعمدة `id`, `email`, `created_at`, `status` فقط، ويمنح قراءته للمالك/مدير النظام وللمفوّضين بـ`password_reset.manage` عبر شرط صلاحية مقيد. لا توجد كلمة مرور في الجدول أو الـview.
4. يبقى إدخال طلب الاستعادة العام مقتصراً على البريد الإلكتروني، ويبدأ بـ`pending_approval`.
5. عند اعتماد الطلب، يرسل المسؤول كلمة المرور الجديدة مباشرة إلى Edge Function. تتحقق دالة SQL من الصلاحية وتحجز الطلب بحالة `awaiting_password` وتعيد معرّف حساب GoTrue؛ تكتب Edge Function كلمة المرور عبر `auth.admin.updateUserById`؛ وبعد النجاح تنهي SQL الطلب وتكتب التدقيق وتحل إشعار الطلب الموجود. عند فشل الكتابة يعاد الطلب إلى `pending_approval` ليبقى قابلاً لإعادة المحاولة.
6. الرفض لا يقرأ أو يكتب كلمة مرور؛ ينهي الطلب ويرفضه ويحفظ التدقيق ويحِل الإشعار.

**حدّ أمني مهم:** لا تنفذ تحديث `auth.users` أو `encrypted_password` من SQL. تغيير كلمة المرور يجب أن يمر عبر GoTrue داخل Edge Function؛ كلمة المرور لا تمر كمعامل إلى RPC ولا تحفظ أو تسجل في قاعدة البيانات أو السجلات. لذلك سيكون RPC للاعتماد/الحجز وRPC للإنهاء، بينما يستقبل Edge Function `p_new_password` وينفذ خطوة GoTrue بينهما.

### 2. جدول التفويضات

إنشاء `public.user_capabilities` بحد أدنى:

- `id`, `user_id`, `permission_id`, `granted_by`, `granted_at`, `expires_at`, `revoked_at`, `revoked_by`.
- فهرس فريد جزئي `(user_id, permission_id) where revoked_at is null`، مع فهرس قراءة حسب المستفيد.
- RLS مفعّل: القراءة الذاتية فقط من الجدول، ولا صلاحية API مباشرة للإدراج أو التحديث أو الحذف. أدوات الإدارة تمر عبر RPCs محمية.
- يسجل المنح والسحب في `audit_logs`. يظل سجل التفويض المسحوب موجوداً؛ السحب يملأ `revoked_at` و`revoked_by` ولا يحذف السجل.

### 3. دلالات الصلاحيات

- `has_permission(p_permission)` يتطلب أن يكون صاحب `auth.uid()` نشطاً ومعتمداً، ثم يعيد true إذا امتلك صلاحية الدور المطلوبة أو `*` من دور، أو امتلك تفويضاً مباشراً سارياً غير مسحوب للصلاحية المطابقة.
- التفويض المباشر يستثني دائماً `*`؛ يبقى `is_admin()` كما هو ويعني wildcard من دور فقط.
- `get_my_capabilities()` يعيد اتحاد صلاحيات الأدوار والتفويضات المباشرة السارية. لا تُخزن الصلاحيات في JWT.
- يضاف `users.approve` و`password_reset.manage` إلى الكتالوج دون إسنادها إلى الأدوار العادية. تظل أدوار `owner` و`super_admin` قادرة بحكم wildcard/الحماية القائمة.

### 4. RPCs والبوابات

**RPCs جديدة/معدلة:**

- `admin_grant_capability(target, slug, expires_at, executor)` و`admin_revoke_capability(capability_id, executor)`: تتحقق من أن المنفذ `owner`/`super_admin`، وترفض التفويض الذاتي، و`*`، و`roles.manage`، والصلاحيات خارج قائمة Phase 1؛ وتتحقق من حالة المستفيد ومن تاريخ الانتهاء. لا يقبل المنفذ المرسل من العميل دون مطابقته لهوية JWT الموثقة عبر Edge Function.
- `get_user_capabilities(target, executor)`: للعرض الإداري فقط عبر Edge Function موثّقة؛ لا يفتح قراءة سجلات الآخرين من الجدول.
- `get_approval_queue()`: يعيد الحقول اللازمة فقط للطلبات المعلقة لمن يملك `users.approve`، بدلاً من توسيع قراءة جدول `profiles` كله.
- `has_permission`, `get_my_capabilities`, `admin_approve_user` بجميع التواقيع، `is_password_reset_admin`, `admin_claim_password_reset_request`, و`admin_finalize_password_reset_request` تتغير لاستخدام الصلاحية المناسبة.
- `admin_invite_user`, `admin_verify_password_reset_authority`, `admin_record_password_reset`, وتغيير الحالة/الأدوار تبقى مقيدة بالبوابات الحالية في Phase 1.
- تمنح وظائف كتابة التفويضات وقراءة تفويضات مستخدم آخر لـ`service_role` فقط، وتستدعيها الواجهة عبر Edge Function تتحقق من JWT. لا يصل مفتاح الخدمة إلى المتصفح.

### 5. الواجهة

- زر «إدارة التفويضات» في صف مستخدم غير محمي داخل `UsersManagement` يفتح `DelegationDialog`، مع الصلاحيات المسموحة فقط، وتاريخ انتهاء اختياري مع اقتراح 90 يوماً، وعرض المنح السارية والسحب.
- تبقى `RolesPermissions` مخصصة لمصفوفة الأدوار.
- تسمح بوابة `UsersManagement` بـ`*` أو `users.approve`. صاحب `users.approve` وحدها يرى قائمة انتظار اعتماد محدودة ويعتمد بدور `viewer` فقط؛ لا تظهر له أزرار التعليق أو تعديل الأدوار أو الدعوة أو تعيين كلمة مرور إداري.
- تسمح صفحة طلبات الاستعادة بـ`password_reset.manage`، وتعرض بيانات الـview الآمن فقط. عند الاعتماد تطلب كلمة مرور جديدة داخل حوار مؤقت، وتمسح القيمة من الحالة بعد العملية أو الإغلاق.
- بعد المنح/السحب، يعاد جلب `get_my_capabilities()` وتُبطل ذاكرة العرض. يبقى الخادم المصدر النهائي للصلاحية؛ فالسحب يمنع RPC فوراً حتى لو لم تتحدث الواجهة بعد.

## RLS وتحديات التنفيذ

1. `is_admin()` و`profiles` RLS يجب ألا يتسعا نتيجة التفويض. لذلك تستخدم قائمة اعتماد آمنة محدودة بدلاً من منح `users.approve` وصولاً عاماً إلى ملفات المستخدمين.
2. `password_reset_requests_safe` هي سطح القراءة الوحيد للمستخدمين؛ لا تمنح `authenticated` صلاحية `SELECT` أو `UPDATE` على الجدول الأصلي. لا يعيد أي RPC كلمة المرور.
3. سياسات RLS التي تستدعي `has_permission('password_reset.manage')` ستسمح للمفوّض بالوصول المقصود فقط؛ السياسات التي تعتمد `is_admin()` تبقى مقصورة على wildcard الدور. يؤجل أثر `settings.manage` إلى Phase 2.
4. تستمر حماية المالك الأصلي، وأدوار `owner`/`super_admin`، ومنح الأدوار الكاملة في مسارات مستقلة. لا يحل التفويض المباشر محل حواجز الأدوار المحمية.
5. تمر عمليات كلمة المرور عبر أكثر من خدمة (Postgres وGoTrue)، لذا لا تكون معاملة موزعة واحدة. حالات `awaiting_password` وإعادة الطلب إلى `pending_approval` عند فشل GoTrue ضرورية لتفادي طلب عالق أو اعتماد غير مكتمل.

## الاختبارات ومعايير القبول

- `scripts/audit/database.mjs`: owner/super_admin يمنح ويسحب؛ viewer يُرفض؛ رفض self-delegation و`*` و`roles.manage`؛ اعتماد مفوض ورفض العمليات غير الممنوحة؛ انتهاء الصلاحية؛ سريان السحب فوراً؛ غياب `new_password` من الجدول والـview.
- Vitest لـ`useAuthCapabilities`, `useUsersManagement`, `usePasswordResetRequests`, `DelegationDialog`، وتدفق طلب/اعتماد إعادة التعيين.
- `e2e/tests/delegated-user.spec.ts`: المالك يفوض viewer بـ`users.approve`؛ viewer يعتمد حساباً معلقاً بدور viewer ولا يستطيع تعليق الحساب أو تعديل أدواره؛ السحب يجعل محاولات الاعتماد التالية مرفوضة.
- E2E لإدخال كلمة المرور عند الاعتماد والتحقق من عدم وجود كلمة مرور في جدول/استجابة قراءة طلبات الاستعادة.
- تظل اختبارات المصادقة والتسجيل الحالية دون تعديل خارج نموذج طلب الاستعادة المرتبط مباشرة بإزالة تخزين كلمة المرور.

## مراحل التنفيذ

0. تحديث هذه الوثيقة وتثبيت حدود D1–D5.
1. ترحيل إزالة كلمة المرور وتحديث تدفق طلب/اعتماد الاستعادة والـview الآمن.
2. جدول التفويض وRPCs المنح/السحب/القراءة والتدقيق.
3. توسيع `has_permission` و`get_my_capabilities`.
4. تحويل بوابات الاعتماد وطابور الاستعادة فقط، مع إبقاء الدعوة وتعيين كلمة المرور الإداري مقيدين.
5. الواجهات وتحديث ذاكرة القدرات.
6. تدقيق قاعدة البيانات وVitest وE2E وفحوص CI الكاملة.
7. توثيق الفرق بين الأدوار الكاملة والتفويضات الفردية في README.

## Phase 2 وما بعده

- تقييم `settings.manage` بعد جرد كل سياسة RLS وRPC تعتمد عليه، وتوثيق الأثر قبل إدخاله إلى قائمة التفويض.
- لا تشمل هذه الخطة صلاحيات صفية، أو أدواراً مخصصة، أو تفويضاً متسلسلاً، أو تغيير صلاحيات الدعوة وتعيين كلمات المرور الإدارية.
