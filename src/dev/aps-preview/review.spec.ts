import { expect, test, type Page } from '@playwright/test';

// These browser tests use the in-memory review transport, not Supabase/RLS.
const issues = new WeakMap<Page, string[]>();
const id = '00000000-0000-4000-8000-000000000001';

test.beforeEach(async ({ page }) => {
  const seen: string[] = [];
  issues.set(page, seen);
  page.on('pageerror', (error) => seen.push(`page error: ${error.message}`));
  page.on('request', (request) => {
    const host = new URL(request.url()).hostname;
    if (host.endsWith('.supabase.co') || host === 'aps-review.invalid') {
      seen.push(`unexpected data request: ${request.url()}`);
    }
  });
  // Font availability is not part of the test; do not depend on external hosts.
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.route('https://fonts.gstatic.com/**', (route) => route.abort());
  await page.addInitScript(() => localStorage.setItem('admin-system:locale', 'ar'));
});

test.afterEach(({ page }) => {
  expect(issues.get(page)).toEqual([]);
});

async function expectNoHorizontalOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
}

test('Arabic list filters and details preserve the URL and show saved line names', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/workspaces/aps/letters');
  await expect(page.getByRole('heading', { name: 'سجل الخطابات' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'عرض التفاصيل 2458' })).toBeVisible();
  await page.getByRole('combobox', { name: 'نوع الخطاب', exact: true }).selectOption('inbound');
  await page.getByRole('combobox', { name: 'الحالة', exact: true }).selectOption('approved');
  await page.getByRole('textbox', { name: 'من تاريخ', exact: true }).fill('2026-10-25');
  await expect(page.getByRole('link', { name: 'عرض التفاصيل 2457' })).toHaveCount(0);
  await expect(page).toHaveURL(/type=inbound/);
  await expect(page).toHaveURL(/status=approved/);
  await expect(page).toHaveURL(/from=2026-10-25/);
  await page.getByRole('link', { name: 'عرض التفاصيل 2458' }).click();
  await expect(page.getByRole('heading', { name: 'سطور الخطاب' })).toBeVisible();
  await expect(page.getByText('مخزن المواد الخام').first()).toBeVisible();
  await expect(page.getByText('حديد وصلب')).toBeVisible();
  await expect(page.getByText('WH-001')).toHaveCount(0);
  await expect(page.getByText('CLS-006')).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
  await page.getByRole('link', { name: 'العودة إلى الخطابات' }).click();
  await expect(page.getByRole('link', { name: 'عرض التفاصيل 2458' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'نوع الخطاب', exact: true })).toHaveValue(
    'inbound',
  );
  await expect(page.getByRole('combobox', { name: 'الحالة', exact: true })).toHaveValue('approved');
  await expect(page.getByRole('textbox', { name: 'من تاريخ', exact: true })).toHaveValue(
    '2026-10-25',
  );
});

test('browser back and forward restore filters before the next edit', async ({ page }) => {
  await page.goto('/workspaces/aps/letters');
  await expect(page.getByRole('link', { name: 'عرض التفاصيل 2458' })).toBeVisible();
  await page.getByRole('combobox', { name: 'نوع الخطاب', exact: true }).selectOption('inbound');
  await expect(page).toHaveURL(/type=inbound/);
  await page.getByRole('combobox', { name: 'الحالة', exact: true }).selectOption('approved');
  await expect(page).toHaveURL(/status=approved/);
  await page.goBack();
  await expect(page.getByRole('combobox', { name: 'الحالة', exact: true })).toHaveValue('');
  await expect(page.getByRole('combobox', { name: 'نوع الخطاب', exact: true })).toHaveValue(
    'inbound',
  );
  await page.goForward();
  await expect(page.getByRole('combobox', { name: 'الحالة', exact: true })).toHaveValue('approved');
  await page.goBack();
  await expect(page.getByRole('combobox', { name: 'الحالة', exact: true })).toHaveValue('');
  await page.getByRole('textbox', { name: 'من تاريخ', exact: true }).fill('2026-10-25');
  await expect(page).toHaveURL(/type=inbound/);
  await expect(page).toHaveURL(/from=2026-10-25/);
  expect(new URL(page.url()).searchParams.has('status')).toBe(false);
});

test('390px filters open and close accessibly; details do not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/workspaces/aps/letters');
  await expect(page.getByRole('link', { name: 'عرض التفاصيل 2458' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: 'الفلاتر', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'تصفية الخطابات' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('نوع الخطاب')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'الفلاتر', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'الفلاتر', exact: true }).click();
  await dialog.getByLabel('نوع الخطاب').selectOption('inbound');
  await dialog.getByLabel('الحالة').selectOption('approved');
  await dialog.getByRole('button', { name: 'تطبيق الفلاتر' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'عرض التفاصيل 2457' })).toHaveCount(0);
  await page.getByRole('link', { name: 'عرض التفاصيل 2458' }).click();
  await expect(page.getByRole('heading', { name: 'سطور الخطاب' })).toBeVisible();
  await expect(page.getByText('حديد وصلب')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('saved names remain visible in the simulated directory-denied scenario', async ({ page }) => {
  await page.goto(`/workspaces/aps/letters/${id}?scenario=restricted`);
  await expect(page.getByRole('heading', { name: 'سطور الخطاب' })).toBeVisible();
  await expect(page.getByText('مخزن المواد الخام').first()).toBeVisible();
  await expect(page.getByText('حديد وصلب')).toBeVisible();
  await expect(page.getByText('مستلزمات التشغيل')).toBeVisible();
});

test('empty, forbidden and network scenarios are distinct', async ({ page }) => {
  for (const [scenario, heading] of [
    ['empty', 'لا توجد خطابات متاحة'],
    ['forbidden', 'لا تملك صلاحية استعراض الخطابات'],
    ['network', 'تعذّر الاتصال'],
  ]) {
    await page.goto(`/workspaces/aps/letters?scenario=${scenario}`);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  }
});

test('English switches the document direction and keeps details readable', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('admin-system:locale', 'en'));
  await page.goto('/workspaces/aps/letters');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('heading', { name: 'Letter register' })).toBeVisible();
  await page.getByRole('link', { name: 'View details 2458' }).click();
  await expect(page.getByRole('heading', { name: 'Letter lines' })).toBeVisible();
  await expect(page.getByText('حديد وصلب')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

async function fillHeader(page: Page, number: string) {
  await page.getByLabel('تاريخ الخطاب').fill('2026-03-04');
  await page.getByLabel('رقم النظام (EPS)').fill(number);
}

/** The warehouse is a searchable combobox; the option carries the station. */
async function pickWarehouse(page: Page, label: string, option: string) {
  await page.getByLabel(label, { exact: true }).click();
  await page.getByRole('option', { name: option }).click();
}

test('entry creates an inbound draft and approves it through the existing transition', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/workspaces/aps/letters/new');
  await expect(page.getByRole('heading', { name: 'خطاب وارد جديد' })).toBeVisible();
  for (const name of [/وارد/, /منصرف/, /تحويل داخلي/, /تحويل خارجي/]) {
    await expect(page.getByRole('button', { name })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /تسوية/ })).toHaveCount(0);
  await fillHeader(page, '9001');
  await page.getByLabel('جهة الوارد').selectOption({ label: 'شركة النيل للمستلزمات — IN-014' });
  await pickWarehouse(page, 'المخزن', 'مخزن المواد الخام - محطة غرب القاهرة');
  await page.getByLabel('التصنيف').selectOption({ label: 'حديد وصلب — CL-001' });
  await page.getByLabel('القيمة').fill('120.50');
  await expect(page.getByText('١٢٠٫٥٠')).toBeVisible();
  await page.getByRole('button', { name: 'حفظ كمسودة' }).click();
  await expect(page.getByText(/حُفظت المسودة بنجاح/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'حفظ التعديلات' })).toBeVisible();
  await page.getByRole('button', { name: 'اعتماد الخطاب' }).click();
  await expect(page.getByText('تم اعتماد الخطاب بنجاح.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'إنشاء خطاب آخر' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  // Opening the detail of the approved letter confirms approval reached the register.
  await page.getByRole('link', { name: 'العودة إلى سجل الخطابات' }).click();
  await expect(page.getByRole('link', { name: 'عرض التفاصيل 9001' })).toBeVisible();
});

test('internal entry pairs source and destination and requires a reclassification reason', async ({
  page,
}) => {
  await page.goto('/workspaces/aps/letters/new?scenario=approval-fails');
  await page.getByRole('button', { name: /تحويل داخلي/ }).click();
  await fillHeader(page, '9002');
  await pickWarehouse(page, 'المصدر — المخزن', 'مخزن المواد الخام - محطة غرب القاهرة');
  await page.getByLabel('المصدر — التصنيف').selectOption({ label: 'حديد وصلب — CL-001' });
  await pickWarehouse(page, 'الوجهة — المخزن', 'مخزن التشغيل الرئيسي - محطة شرق القاهرة');
  await page.getByLabel('الوجهة — التصنيف').selectOption({ label: 'مستلزمات التشغيل — CL-002' });
  await page.getByLabel('قيمة الزوج').fill('75');
  await expect(page.getByLabel(/سبب إعادة التصنيف/)).toBeVisible();
  await expect(page.getByText('المصدر والوجهة متساويان')).toBeVisible();
  await page.getByRole('button', { name: 'اعتماد الخطاب' }).click();
  await expect(page.getByText(/أدخل سبب إعادة التصنيف/)).toBeVisible();
  await page.getByLabel(/سبب إعادة التصنيف/).fill('إعادة تصنيف أثناء النقل');
  await page.getByRole('button', { name: 'اعتماد الخطاب' }).click();
  await expect(page.getByText(/حُفظت المسودة، لكن تعذّر اعتمادها/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'عرض المسودة' })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('entry stays usable at 390px with the paired layout', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/workspaces/aps/letters/new');
  await expect(page.getByRole('heading', { name: 'خطاب وارد جديد' })).toBeVisible();
  await expect(page.getByRole('button', { name: /وارد/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: /تحويل داخلي/ }).click();
  await expect(page.getByLabel('المصدر — المخزن')).toBeVisible();
  await expect(page.getByLabel('الوجهة — التصنيف')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

test('entry options refusal and lost results are reported honestly', async ({ page }) => {
  await page.goto('/workspaces/aps/letters/new?scenario=forbidden');
  await expect(page.getByRole('alert')).toContainText('لا تملك صلاحية إنشاء الخطابات');
  await page.goto('/workspaces/aps/letters/new?scenario=save-unknown');
  await fillHeader(page, '9003');
  await page.getByLabel('جهة الوارد').selectOption({ label: 'شركة النيل للمستلزمات — IN-014' });
  await pickWarehouse(page, 'المخزن', 'مخزن المواد الخام - محطة غرب القاهرة');
  await page.getByLabel('التصنيف').selectOption({ label: 'حديد وصلب — CL-001' });
  await page.getByLabel('القيمة').fill('10');
  await page.getByRole('button', { name: 'حفظ كمسودة' }).click();
  await expect(page.getByRole('alert')).toContainText('قد يكون الحفظ اكتمل');
  await expect(page.getByRole('link', { name: 'عرض المسودة' })).toBeVisible();
});

test('entry reads the running period, the issuer list and the station label', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/workspaces/aps/letters/new');
  await expect(page.getByText(/تاريخ الخطاب لا يقع في شهر مهيأ/)).toBeVisible();
  await page.getByLabel('تاريخ الخطاب').fill('2026-10-15');
  await expect(page.getByText(/أنت تدخل خطاباً في: أكتوبر 2026 — الفترة 4/)).toBeVisible();

  const issuer = page.getByLabel('كود المُصدر', { exact: true });
  await issuer.fill('ياسر');
  await expect(page.getByRole('option', { name: 'YM — ياسر' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'AA — أحمد عبد الله' })).toHaveCount(0);
  await page.getByRole('option', { name: 'YM — ياسر' }).click();
  await expect(issuer).toHaveValue('YM — ياسر');
  await page.getByLabel('رقم المُصدر').fill('0042');

  const warehouse = page.getByLabel('المخزن', { exact: true });
  await warehouse.fill('غرب');
  await expect(
    page.getByRole('option', { name: 'مخزن المواد الخام - محطة غرب القاهرة' }),
  ).toBeVisible();
  await expect(
    page.getByRole('option', { name: 'مخزن التشغيل الرئيسي - محطة شرق القاهرة' }),
  ).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

test('English entry screen renders left to right', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('admin-system:locale', 'en'));
  await page.goto('/workspaces/aps/letters/new');
  await expect(page.getByRole('heading', { name: 'New inbound letter' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('button', { name: /Inbound/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
