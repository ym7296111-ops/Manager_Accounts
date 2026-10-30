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
