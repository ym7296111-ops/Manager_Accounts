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

/** The type lives in the shell's sticky header; there is no second band. */
function pageHeader(page: Page) {
  return page.getByRole('banner').filter({ hasText: /خطاب|تحويل|letter|transfer/i });
}

/**
 * The letter code is not typed: the issuer is chosen from the register and the
 * number is typed beside it, with the colon printed between the two.
 */
async function fillHeader(page: Page, number: string, code = '63') {
  await page.getByLabel('رقم النظام (EPS)').fill(number);
  await page.getByLabel('المُصدر').selectOption('YM');
  await page.getByLabel('الرقم', { exact: true }).fill(code);
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
  await expect(pageHeader(page).getByText('خطاب وارد جديد')).toBeVisible();
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
  await expect(pageHeader(page).getByText('خطاب وارد جديد')).toBeVisible();
  await expect(page.getByRole('button', { name: /وارد/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: /تحويل داخلي/ }).click();
  await expect(page.getByLabel('المصدر — المخزن')).toBeVisible();
  await expect(page.getByLabel('الوجهة — التصنيف')).toBeVisible();
  // The merged header still fits: the four type labels in one row, the period
  // bar, then EPS above the letter code — all inside 390px, no sideways scroll.
  const typeSwitch = page.getByRole('group', { name: 'اختر نوع الخطاب' });
  await expect(typeSwitch.getByRole('button')).toHaveCount(4);
  const labels = await typeSwitch
    .getByRole('button')
    .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
  expect(new Set(labels).size).toBe(1);
  await expect(page.getByText(/عام مالي \d{4}\/\d{4}/)).toBeVisible();
  await expect(page.getByLabel('المُصدر')).toBeVisible();
  await expect(page.getByLabel('الرقم', { exact: true })).toBeVisible();
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

test('the sticky header states the letter type and does not duplicate the title', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/workspaces/aps/letters/new');
  const header = pageHeader(page);
  await expect(header.getByText('خطاب وارد جديد')).toBeVisible();
  await page.getByRole('button', { name: /منصرف/ }).click();
  await expect(header.getByText('خطاب منصرف جديد')).toBeVisible();
  await expect(page.getByRole('heading', { name: /جديد/ })).toHaveCount(0);
  await page.getByRole('button', { name: /تحويل داخلي/ }).click();
  await expect(header.getByText('تحويل داخلي جديد')).toBeVisible();
  await page.getByRole('button', { name: /تحويل خارجي/ }).click();
  await expect(header.getByText('تحويل خارجي جديد')).toBeVisible();
  /* Still the shell header, still pinned: scrolling must not take the type away. */
  await expect(header).toHaveCSS('position', 'sticky');
  await page.evaluate(() => window.scrollTo(0, 600));
  await expect(header.getByText('تحويل خارجي جديد')).toBeInViewport();
  await expectNoHorizontalOverflow(page);
});

test('type, period and numbers share one «بيانات الخطاب» paragraph', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/workspaces/aps/letters/new');

  const headerSection = page.locator('section', {
    has: page.getByRole('heading', { name: 'بيانات الخطاب' }),
  });
  await expect(headerSection).toHaveCount(1);
  /* The type used to be a paragraph of its own, headed «اختر نوع الخطاب» right
     under a sticky header that already names the type. It is a switch now. */
  await expect(page.getByRole('heading', { name: 'اختر نوع الخطاب' })).toHaveCount(0);
  const typeSwitch = headerSection.getByRole('group', { name: 'اختر نوع الخطاب' });
  await expect(typeSwitch).toBeVisible();
  await expect(typeSwitch.getByRole('button')).toHaveCount(4);

  // Line 2: the running period, read from the periodic settings. It is three
  // weights, not one sentence — a badge, the month, then a quiet fiscal year —
  // and the month's own year is not printed twice.
  const periodBar = headerSection.locator('[role="status"]');
  await expect(periodBar.getByText(/^فترة \d+$/)).toBeVisible();
  await expect(
    periodBar.getByText(
      /^(يناير|فبراير|مارس|أبريل|مايو|يونيو|يوليو|أغسطس|سبتمبر|أكتوبر|نوفمبر|ديسمبر)$/,
    ),
  ).toBeVisible();
  await expect(periodBar.getByText(/عام مالي \d{4}\/\d{4}$/)).toBeVisible();
  /* One year statement only: `أكتوبر 2026 — عام مالي 2026/2027` used to repeat it. */
  await expect(periodBar).not.toHaveText(/\d{4} — /);

  /* Reading order inside the paragraph: the switch, then the period, then the
     two typed numbers — the order the clerk works in. */
  const switchBox = await typeSwitch.boundingBox();
  const periodBox = await periodBar.boundingBox();
  const epsBox = await page.getByLabel('رقم النظام (EPS)').boundingBox();
  expect(switchBox!.y).toBeLessThan(periodBox!.y);
  expect(periodBox!.y).toBeLessThan(epsBox!.y);
  /* The switch is a row of labels, not four cards: one band, icon + text. */
  expect(switchBox!.height).toBeLessThan(60);
  expect(switchBox!.width).toBeLessThan(periodBox!.width);

  // The date and the fiscal year are gone from the screen.
  await expect(page.getByLabel('تاريخ الخطاب')).toHaveCount(0);
  await expect(page.getByLabel('السنة المالية')).toHaveCount(0);
  // Three lines only: the switch, the read-only period, the EPS number and the
  // two controls of the letter code.
  await expect(headerSection.getByRole('textbox')).toHaveCount(2);
  await expect(headerSection.getByRole('combobox')).toHaveCount(1);

  // Line 2: the letter code is `[ YM ▼ ] : [ 63 ]`. The dropdown lists the
  // active issuers as `code — name`, and the number field takes digits only.
  const issuer = page.getByLabel('المُصدر');
  const number = page.getByLabel('الرقم', { exact: true });
  await expect(issuer.locator('option')).toHaveText([
    'اختر المُصدر',
    'AA — أحمد عبد الله',
    'YM — ياسر',
  ]);
  await expect(number).toBeDisabled();
  await issuer.selectOption('YM');
  await expect(number).toBeEnabled();
  await number.fill('٦٣');
  await expect(number).toHaveValue('');
  await number.fill('63');
  await page.getByLabel('رقم النظام (EPS)').fill('9021');
  await expectNoHorizontalOverflow(page);
});

test('English entry screen renders left to right', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('admin-system:locale', 'en'));
  await page.goto('/workspaces/aps/letters/new');
  await expect(pageHeader(page).getByText('New inbound letter')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(page.getByRole('button', { name: /Inbound/ })).toBeVisible();
  await expectNoHorizontalOverflow(page);
});

/**
 * The letter code is chosen, not typed — so the list it is chosen from has to be
 * real. This walks the whole loop in one in-memory session (the preview keeps
 * its rows per page load, so navigation stays inside the app): a code added in
 * the issuer register appears in the entry dropdown, deactivating it removes it
 * again, and a chosen code plus a number is stored as `issuer_reference`.
 */
test('an issuer added in settings reaches the entry dropdown, and disabling it removes it', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/workspaces/aps/letters/new');
  const issuerOptions = () => page.getByLabel('المُصدر').locator('option');

  // 1) Add the code in the register (client-side navigation keeps the rows).
  await page.getByRole('link', { name: 'أكواد المُصدرين', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'أكواد المُصدرين' })).toBeVisible();
  await page.getByRole('button', { name: 'إضافة كود جديد' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('الحرفان (مثال: YM)').fill('ab');
  await expect(dialog.getByLabel('الحرفان (مثال: YM)')).toHaveValue('AB');
  await dialog.getByLabel('الاسم / الوصف (اختياري)').fill('بدر');
  await dialog.getByRole('button', { name: 'حفظ' }).click();
  await expect(page.getByRole('alert')).toContainText('أُضيف الكود');
  await expect(page.getByRole('rowheader', { name: 'AB' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'بدر', exact: true })).toBeVisible();
  await expectNoHorizontalOverflow(page);

  // 2) The entry dropdown is the same register, printed as `code — name`.
  await page.goBack();
  await expect(page.getByLabel('المُصدر')).toBeVisible();
  await expect(issuerOptions().filter({ hasText: 'AB — بدر' })).toHaveCount(1);

  // 3) Deactivating it removes it from the dropdown — the row and the letters
  //    already recorded with it stay.
  await page.getByRole('link', { name: 'أكواد المُصدرين', exact: true }).click();
  await page.getByRole('button', { name: 'تعطيل AB — بدر' }).click();
  await expect(page.getByRole('alert')).toContainText('عُطّل الكود');
  await expect(page.getByRole('rowheader', { name: 'AB' })).toBeVisible();

  await page.goBack();
  await expect(page.getByLabel('المُصدر')).toBeVisible();
  await expect(issuerOptions().filter({ hasText: 'AB — بدر' })).toHaveCount(0);
  await expect(issuerOptions().filter({ hasText: 'YM — ياسر' })).toHaveCount(1);

  // 4) A chosen issuer and a number are saved as one column: `YM:63`.
  await page.getByLabel('رقم النظام (EPS)').fill('9100');
  await page.getByLabel('المُصدر').selectOption('YM');
  await page.getByLabel('الرقم', { exact: true }).fill('63');
  await page.getByLabel('جهة الوارد').selectOption({ label: 'شركة النيل للمستلزمات — IN-014' });
  await pickWarehouse(page, 'المخزن', 'مخزن المواد الخام - محطة غرب القاهرة');
  await page.getByLabel('التصنيف').selectOption({ label: 'حديد وصلب — CL-001' });
  await page.getByLabel('القيمة').fill('10');
  await page.getByRole('button', { name: 'حفظ كمسودة' }).click();
  await expect(page.getByText(/حُفظت المسودة بنجاح/)).toBeVisible();

  await page
    .getByRole('navigation', { name: 'أقسام مساحة APS' })
    .getByRole('link', { name: 'استعراض الخطابات' })
    .click();
  await page.getByRole('link', { name: 'عرض التفاصيل 9100' }).click();
  await expect(page.getByText('YM:63')).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
