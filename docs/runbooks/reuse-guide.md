# دليل إعادة استخدام القالب (Reuse Guide)

دليل عملي خطوة بخطوة لإعادة استخدام هذا القالب الإداري الإنتاجي (`v1.0.1+`) وإطلاق مشروع جديد مستقل من الصفر — شاملاً قاعدة البيانات، الدوال الخلفية (Edge Functions)، الاستضافة على Vercel، خطوط CI/CD، وتأمين حساب المالك الأول — في **أقل من 30 دقيقة**.

---

## المتطلبات المسبقة

تأكد من توفر الأدوات والحسابات التالية قبل البدء:

- **Node.js 20+** و **npm** _(يوصى بـ `Node.js 22.12+` لمطابقة `.nvmrc` وبيئة CI)_.
- **حساب Supabase** ([supabase.com](https://supabase.com)).
- **حساب Vercel** ([vercel.com](https://vercel.com)).
- **Supabase CLI** — للتثبيت عالمياً:

  ```bash
  npm install -g supabase
  ```

- _(اختياري للأتمتة السريعة)_ **GitHub CLI (`gh`)** مسجّل الدخول (`gh auth login`).

---

## الخطوة 1: إنشاء مستودع جديد (اختياري لكن موصى به)

1. **الخيار الموصى به (Template Repository):**
   - من صفحة المستودع الأصلي على GitHub، اضغط **Use this template → Create a new repository** لإنشاء مستودع نظيف خاص بمشروعك الجديد بدون تاريخ الـ commits السابق.
   - استنسخ مستودعك الجديد محلياً:

     ```bash
     git clone https://github.com/<your-org>/<your-new-repo>.git
     cd <your-new-repo>
     ```

2. **أو الاستنساخ اليدوي وإعادة ربط الـ Remote:**

   ```bash
   git clone --depth 1 https://github.com/ym7296111-ops/admin_system.git <your-new-repo>
   cd <your-new-repo>
   rm -rf .git
   git init -b main
   git add .
   git commit -m "chore: initialize project from admin-system template v1.0.1"
   git remote add origin https://github.com/<your-org>/<your-new-repo>.git
   git push -u origin main
   ```

---

## الخطوة 2: إنشاء مشروع Supabase جديد

1. اذهب إلى [supabase.com](https://supabase.com) ← **New Project**.
2. اختر اسماً للمشروع، وحدد كلمة مرور قوية لقاعدة البيانات (**Database Password** — احتفظ بها، ستحتاجها في الخطوة 6)، واختر المنطقة الأقرب لمستخدميك.
3. بعد اكتمال تهيئة المشروع، اذهب إلى **Project Settings → General** و **Project Settings → API** واحفظ القيم الأربع التالية في مدير كلمات المرور لديك:
   - **Project Ref** (معرّف مكون من 20 حرفاً صغيراً وأرقام، مثل `abcdefghijklmnopqrst`).
   - **Project URL** (`https://<project-ref>.supabase.co`).
   - **anon / public key** (`VITE_SUPABASE_ANON_KEY`).
   - **service_role key** (`SUPABASE_SERVICE_ROLE_KEY`).

> ⚠️ **ملاحظة أمنية حرجة:** لا تشارك `service_role key` أبداً، ولا تضعه في ملفات `.env.local` الخاصة بالواجهة، ولا تسبقه ببادئة `VITE_`، ولا ترفعه إلى Vercel. هذا المفتاح يتجاوز سياسات RLS ويُستخدم حصرياً على الخادم داخل **Supabase Edge Functions** (حيث تحقنه منصة Supabase تلقائياً في بيئة الدوال).

---

## الخطوة 3: إعداد البيئة المحلية

1. انسخ ملف المتغيرات النموذجي إلى `.env.local` (المستثنى من Git):

   ```bash
   cp .env.example .env.local
   ```

2. افتح `.env.local` واملأ المتغيرات الأساسية للواجهة:

   ```dotenv
   VITE_SUPABASE_URL=https://<your-project-ref>.supabase.co
   VITE_SUPABASE_ANON_KEY=<your-anon-public-key>
   VITE_APP_NAME="اسم مشروعك الجديد"
   VITE_APP_URL=http://localhost:5173
   ```

3. ثبّت الحزم البرمجية:

   ```bash
   npm install
   ```

---

## الخطوة 4: ربط Supabase ودفع الترحيلات ونشر الدوال

1. سجّل الدخول في Supabase CLI واربط المستودع بمشروعك السحابي الجديد:

   ```bash
   supabase login
   supabase link --project-ref <your-project-ref>
   ```

2. ادفع جميع الترحيلات إلى قاعدة البيانات (يطبّق **40 ترحيلاً** تشمل الجداول، سياسات RLS، أدوار RBAC، وحماية المالك الأصلي):

   ```bash
   supabase db push
   ```

3. انشر الدوال الخلفية الخمس (**Edge Functions**) بعد نجاح الترحيلات:

   ```bash
   supabase functions deploy approve-user admin-reset-password admin-invite-user admin-set-password admin-user-capabilities
   ```

   _(إذا كان إصدار Supabase CLI لديك يقبل اسماً واحداً في كل أمر، نفّذها تباعاً)_:

   ```bash
   supabase functions deploy approve-user
   supabase functions deploy admin-reset-password
   supabase functions deploy admin-invite-user
   supabase functions deploy admin-set-password
   supabase functions deploy admin-user-capabilities
   ```

> ⚠️ **تحقق:** شغّل الأمر التالي وتأكد من ظهور **الدوال الخمس جميعها** بحالة `ACTIVE`:
>
> ```bash
> supabase functions list
> ```
>
> غياب أي دالة سيؤدي إلى ظهور رسالة خطأ عامة في الواجهة عند استدعاء الميزة المرتبطة بها.

---

## الخطوة 5: نشر الواجهة على Vercel

1. من لوحة [Vercel](https://vercel.com) اختر **Add New… → Project** واربط مستودع GitHub الجديد (سيقرأ Vercel إعدادات البناء وإعادة التوجيه تلقائياً من `vercel.json`).
2. قبل الضغط على Deploy، أضف متغيرات البيئة (**Environment Variables**) في إعدادات مشروع Vercel:
   - `VITE_SUPABASE_URL` = `https://<your-project-ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = `<your-anon-public-key>`
   - `VITE_APP_NAME` = `اسم مشروعك الجديد`
   - `VITE_APP_URL` = `https://<your-vercel-domain>.vercel.app` _(بدون شرطة مائلة `/` في النهاية)_
3. اضغط **Deploy** وانتظر اكتمال النشر.

> ⚠️ **تحقق:** بعد أول نشر ومعرفة النطاق النهائي (أو بعد ربط نطاقك المخصص Custom Domain)، تأكد من تحديث قيمة `VITE_APP_URL` في Vercel لتطابق دومين الإنتاج الفعلي ثم أعد النشر (**Redeploy**) حتى تُحقن القيمة وقت البناء.

---

## الخطوة 6: إعداد GitHub Secrets و CI/CD

يعتمد سير العمل `.github/workflows/supabase-migration.yml` على بيئة GitHub محمية باسم **`Production`** لنشر أي ترحيلات أو دوال مستقبلية تلقائياً عند الدمج في `main`:

1. في مستودع GitHub اذهب إلى **Settings → Environments → New environment** وأنشئ بيئة باسم **`Production`** (وقيّد Deployment branches بفرع `main` فقط).
2. داخل بيئة **`Production`**، أضف القيم الثلاث التالية:
   - `SUPABASE_ACCESS_TOKEN` _(Environment Secret — أنشئه من [Supabase Account Tokens](https://supabase.com/dashboard/account/tokens))_.
   - `SUPABASE_DB_PASSWORD` _(Environment Secret — كلمة مرور قاعدة البيانات من الخطوة 2)_.
   - `SUPABASE_PROJECT_REF` _(Environment Variable أو Secret — معرّف المشروع ذو الـ 20 حرفاً)_.
3. _(اختياري)_ إذا أردت استخدام السكربت المساعد `scripts/configure-production-environment.sh` لضبط القيم آلياً عبر `gh`، حدّث قيمة `REPO_DEFAULT` في السطر 30 من السكربت إلى `<your-org>/<your-new-repo>` (أو مرّر الراية `--repo <your-org>/<your-new-repo>` عند تشغيله).
4. اضبط حماية الفرع الرئيسي (**Settings → Branches → Add branch protection rule** على `main`):
   - فعّل **Require a pull request before merging**.
   - فعّل **Require status checks to pass before merging** وأضف الفحوصات الإلزامية:
     - `Lint, typecheck and build`
     - `Chromium against local Supabase`
     - _(موصى به أيضاً عند تعديل قاعدة البيانات)_ `Test migrations on an ephemeral database`

> ⚠️ **تحقق:** تأكد من أن Branch Protection مفعل فعلياً على `main` ويشمل `Chromium against local Supabase` و `Lint, typecheck and build` حتى لا يمر أي تغيير يكسر البناء أو تدقيق PostgreSQL أو اختبارات E2E.

---

## الخطوة 7: تأمين المالك الأول (⚠️ حرج!)

يمنح القالب دور المالك الأصلي المحمي (`owner`) ذرياً **لأول حساب يُنشأ في جدول `auth.users` عندما يكون فارغاً**، ويغلق هذه البوابة للأبد بعد أول مستخدم.

لتجنّب سباق أي زائر عشوائي إلى التسجيل الأول، طبّق التسلسل الآمن التالي **قبل مشاركة رابط الموقع للجمهور**:

1. **قبل فتح الموقع للجمهور:** اذهب إلى لوحة Supabase → **Authentication → Providers → Email** (أو **Authentication → Sign In / Up**) وأوقف التسجيل العام مؤقتاً (**Disable Sign Ups** / إيقاف _Allow new users to sign up_).
2. **سجّل حساب المالك الأول** بأحد المسارين الآمنين:
   - **المسار أ (مباشرة من لوحة Supabase والـ Sign Ups مغلق):** من **Authentication → Users → Add user → Create new user** أدخل بريد المالك وكلمة مروره مع تفعيل **Auto Confirm User** — سيعمل Trigger قاعدة البيانات تلقائياً ويمنحه دور `owner` واعتماد `approved`.
   - **المسار ب (من واجهة `/login` قبل نشر الرابط علناً):** شغّل الواجهة محلياً (`npm run dev`) أو افتح رابط المعاينة الخاص بك بمفردك، وفعّل التسجيل لحظياً لإنشاء حساب المالك من `/login` ثم أغلقه فوراً إن لم ترغب بالتسجيل المفتوح.
3. **تحقق من Supabase SQL Editor** أن حسابك أنت وحدك هو المالك المعتمد:

   ```sql
   SELECT p.id, p.email, p.status, p.approval_status, r.slug AS role
   FROM public.profiles p
   LEFT JOIN public.user_roles ur ON ur.user_id = p.id
   LEFT JOIN public.roles r ON r.id = ur.role_id
   WHERE p.approval_status = 'approved';
   ```

   _(يجب أن ترى **صفاً واحداً فقط** يحمل بريدك وحالة `active` و`approved` ودور `owner`)_.

4. **الآن يمكنك تفعيل Sign Ups مجدداً** إن أردت السماح للمستخدمين بطلب التسجيل الذاتي _(سيحصل أي مسجّل لاحق على حالة `pending` بلا أي صلاحيات حتى تعتمده يدوياً)_، أو إبقاؤه مغلقاً والاعتماد على ميزة «إضافة مستخدم» الإدارية فقط.

> ⚠️ **تحذير أمني:** إذا فتحت الموقع للجمهور قبل تسجيل المالك الأول، فإن **أول شخص يسجّل سيصبح المالك الأصلي (`owner`) غير القابل للحذف أو العزل من الواجهة!** لا تشارك الرابط العام أبداً قبل إتمام هذه الخطوة والتحقق بالاستعلام أعلاه.

---

## الخطوة 8: اختبار الدخان (Smoke Test)

نفّذ الاختبارات السريعة التالية على بيئة الإنتاج للتأكد من تكامل الواجهة وقاعدة البيانات والدوال الخلفية:

1. **تسجيل الدخول كمالك:** افتح `/login` وسجّل الدخول بحساب المالك ← يجب أن تنتقل تلقائياً إلى `/` وتظهر لوحة المؤشرات التنفيذية (Executive Dashboard) دون أي أخطاء.
2. **دعوة مستخدم جديد:** اذهب إلى **الإعدادات ← المستخدمون ← إضافة مستخدم** (`Settings → Users → Invite`)، وأنشئ مستخدماً بدور `viewer` أو `editor` ← تأكد من ظهور كلمة المرور المؤقتة مرة واحدة في `PasswordRevealDialog` ونجاح الدخول بها في نافذة متصفح خفية (Incognito).
3. **منح تفويض صلاحية:** من جدول المستخدمين، افتح **إدارة التفويضات** للمستخدم الجديد وامنحه صلاحية `users.approve` بتاريخ انتهاء ← تأكد من ظهور شارة الدرع ومؤقت الانتهاء بجانب اسمه، ثم جرّب سحب التفويض.
4. **طلب إعادة تعيين كلمة المرور:** من نافذة خفية في `/login` اختر «نسيت كلمة المرور؟» وأرسل بريد المستخدم التجريبي ← تأكد من وصول إشعار فوري في جرس التنبيهات لدى المالك، وافتح **الإعدادات ← طلبات إعادة التعيين** واعتمد الطلب، وتأكد من ظهور كلمة المرور المؤقتة الجديدة وعملها.

---

## الخطوة 9: تخصيص القالب

بعد التأكد من عمل البنية التحتية، خصّص القالب ليطابق هوية مشروعك الجديد:

- **الهوية البصرية والنصوص:**
  - عدّل `src/i18n/locales/ar.ts` و `src/i18n/locales/en.ts` لتخصيص اسم التطبيق والمصطلحات _(ملاحظة: المعجمان متطابقان بنيوياً عبر TypeScript؛ أي مفتاح تضيفه في `ar.ts` يجب إضافته في `en.ts`)_.
  - لتخصيص لوحة الألوان ومتغيرات التصميم (Light / Dark tokens)، عدّل `src/styles/globals.css`.
  - يمكنك أيضاً تعديل اسم التطبيق والشعار والمنطقة الزمنية مباشرة من داخل النظام عبر شاشتي `/settings/app/general` و `/settings/app/appearance`.
- **الشعار والأيقونة:**
  - استبدل الشعار/الأيقونة في `public/` (مثل `public/logo.svg` و `public/favicon.svg`) وحدّث الإشارة في `index.html` عند الحاجة، أو ارفع الشعار مباشرة من شاشة الإعدادات العامة.
- **البيانات الأولية للتطوير المحلي (اختياري):**
  - عدّل `supabase/seed.sql` لإضافة بيانات تجريبية خاصة بمجال مشروعك عند تشغيل `supabase db reset --local`.
  - ⚠️ **تنبيه:** لا تُدرج في `supabase/seed.sql` أي صفوف في جداول `roles` أو `permissions` أو `role_permissions` أو `auth.users` أو `user_roles` (خط الأساس الأمني يُدار حصراً عبر الترحيلات، وتتحقق بوابة CI من ذلك آلياً).

---

## قائمة التحقق النهائية (Final Checklist)

- [ ] Supabase مربوط و40 ترحيلاً مطبقاً (`supabase db push`).
- [ ] 5 Edge Functions منشورة ونشطة (`supabase functions list`).
- [ ] Vercel ينشر بنجاح و `VITE_APP_URL` يطابق دومين الإنتاج.
- [ ] GitHub Secrets / Variables مضبوطة داخل بيئة `Production`.
- [ ] Branch Protection مفعل على `main` ويشمل `Lint, typecheck and build` و `Chromium against local Supabase`.
- [ ] المالك الأول مسجل ومؤكد بدور `owner` (صف واحد فقط في فحص SQL).
- [ ] Smoke Test ناجح (الدخول، الدعوة، التفويض، واستعادة كلمة المرور).
