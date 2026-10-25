/**
 * Screenshot pass for the Phase 3 review (not part of the suite).
 *
 * Drives the preview harness on :4173 and captures the CRUD dialogs in Arabic
 * (default), plus one English and one dark frame for the review write-up.
 */
import { chromium } from 'playwright-core';

const BASE = 'http://localhost:4173/';
const OUT = '/home/user';

/** Minimal stand-in for `expect`, so a broken screenshot run fails loudly. */
function expect(actual, message) {
  if (!actual) {
    throw new Error(`assertion failed: ${message} (got ${JSON.stringify(actual)})`);
  }
  return actual;
}

/* Playwright's bundled browser is not downloadable in this sandbox: the binary
   comes from the `@sparticuz/chromium` npm package (inflated to /tmp/chromium,
   ephemeral) and NSS/NSPR are resolved from /tmp/nsslibs. See
   docs/notes/local-browser.md for how those are built. */
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/tmp/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote'],
});

const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 2,
});
const page = await context.newPage();

async function openTab() {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByRole('tab').nth(1).click();
  await page.getByRole('heading', { name: 'شجرة التصنيفات' }).waitFor();
}

// 1. Tree with the row actions in place.
await openTab();
await page.screenshot({ path: `${OUT}/classifications-tree-actions.png` });

/* 1b. The deep branch, all five levels open: مخزون ← وقود ← سولار ←
   سولار تشغيل ← ديزل معدات ← ديزل آليات ثقيلة. This is the shape the old
   three-level ceiling forbade, so it is the screenshot that proves the change. */
const toggleNamed = (name) =>
  page.locator('button[aria-expanded]').filter({ hasText: name }).first();

for (const name of ['مخزون', 'وقود', 'سولار', 'سولار تشغيل', 'ديزل معدات']) {
  await toggleNamed(name).click();
}
await page.getByText('ديزل آليات ثقيلة').waitFor();
await page.screenshot({ path: `${OUT}/classifications-deep-tree.png`, fullPage: true });

// 1c. The breadcrumb: hovering a deep row exposes its full path, and the rename
//     dialog repeats it as text.
const deepRow = toggleNamed('ديزل آليات ثقيلة');
console.log('deep row tooltip:', await deepRow.getAttribute('title'));
await page.getByRole('button', { name: 'تعديل ديزل معدات' }).click();
await page.getByRole('dialog').waitFor();
await page.screenshot({ path: `${OUT}/classifications-deep-path.png` });
await page.getByRole('button', { name: 'إغلاق' }).click();
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('tab').nth(1).click();
await page.getByRole('heading', { name: 'شجرة التصنيفات' }).waitFor();

// 2. Add-category dialog: name only, code previewed as read-only.
await page.getByRole('button', { name: 'إضافة تصنيف أساسي' }).click();
await page.getByRole('dialog').waitFor();
await page.screenshot({ path: `${OUT}/classifications-add-category.png` });

// 3. Validation state: the disabled save + inline error on a one-character name.
await page.getByLabel('اسم تصنيف أساسي').fill('ا');
await page.getByRole('dialog').getByRole('button', { name: 'حفظ' }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/classifications-validation.png` });
await page.getByRole('button', { name: 'إغلاق' }).click();

// 4. Add-group dialog: shows where the node lands, parent not editable.
await page.locator('button[aria-expanded]').filter({ hasText: 'المواد والمستلزمات' }).click();
await page.getByRole('button', { name: 'إضافة تصنيف فرعي داخل «المواد والمستلزمات»' }).click();
await page.getByRole('dialog').waitFor();
await page.screenshot({ path: `${OUT}/classifications-add-group.png` });
await page.getByRole('button', { name: 'إغلاق' }).click();

// 5. Rename dialog: code visible, not editable; level caption.
await page.getByRole('button', { name: 'تعديل المواد الخام' }).click();
await page.getByRole('dialog').waitFor();
await page.screenshot({ path: `${OUT}/classifications-rename.png` });
await page.getByRole('button', { name: 'إغلاق' }).click();

// 6. Delete confirmation for a leaf.
await page.locator('button[aria-expanded]').filter({ hasText: 'المواد الخام' }).click();
await page.getByRole('button', { name: 'حذف حديد وصلب' }).click();
await page.getByRole('dialog').waitFor();
await page.screenshot({ path: `${OUT}/classifications-delete-confirm.png` });
await page.getByRole('button', { name: 'إغلاق' }).click();

// 7. 23503 translated. The delete button is hidden for any node with children,
//    so the only honest way to see the message is the race it protects
//    against: create a leaf, then have a second writer add a child underneath
//    it, then delete the (now stale) leaf.
const parentDelete = await page.getByRole('button', { name: 'حذف المواد والمستلزمات' }).count();
console.log('delete affordances on a parent (must be 0):', parentDelete);
expect(parentDelete === 0, 'a node with children must not offer delete');

await page.getByRole('button', { name: 'إضافة تصنيف أساسي' }).click();
await page.getByLabel('اسم تصنيف أساسي').fill('تصنيف تحت الاختبار');
await page.getByRole('dialog').getByRole('button', { name: 'حفظ' }).click();
await page.getByRole('button', { name: 'حذف تصنيف تحت الاختبار' }).waitFor();

await page.evaluate(() =>
  window.__previewDb?.addChild('تصنيف تحت الاختبار', 'تصنيف فرعي أُضيف للتو'),
);
await page.getByRole('button', { name: 'حذف تصنيف تحت الاختبار' }).click();
await page.getByRole('dialog').getByRole('button', { name: 'تأكيد الحذف' }).click();
await page
  .getByText('لا يمكن حذف هذا التصنيف لاحتوائه على تصنيفات فرعية', { exact: false })
  .waitFor();

/* The refusal triggers a refetch: the stale row must stop offering delete, and
   the child that caused the refusal must show up once the row is opened. */
await page.getByRole('button', { name: 'حذف تصنيف تحت الاختبار' }).waitFor({ state: 'detached' });
await page.locator('button[aria-expanded]').filter({ hasText: 'تصنيف تحت الاختبار' }).click();
await page.getByText('تصنيف فرعي أُضيف للتو').waitFor();
await page.screenshot({ path: `${OUT}/classifications-delete-refused.png`, fullPage: true });
await page.getByRole('button', { name: 'إغلاق التنبيه' }).click();
console.log('23503 surfaced as the has-children message');

// 8. English, RTL mirrored check.
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => window.localStorage.setItem('admin-system:locale', 'en'));
await page.reload({ waitUntil: 'networkidle' });
await page.getByRole('tab').nth(1).click();
await page.getByRole('heading', { name: 'Classifications tree' }).waitFor();
await page.getByRole('button', { name: 'Add main classification' }).click();
await page.getByRole('dialog').waitFor();
await page.screenshot({ path: `${OUT}/classifications-add-category-en.png` });
await page.getByRole('button', { name: 'Close' }).click();

// 9. Dark theme. The harness mounts the screen without `ThemeProvider`, so the
//    `dark` class is toggled on <html> directly, in the same page (no reload,
//    so the locale stays where the previous step left it — reset to Arabic).
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  window.localStorage.removeItem('admin-system:locale');
  document.documentElement.classList.add('dark');
});
await page.reload({ waitUntil: 'networkidle' });
await page.evaluate(() => document.documentElement.classList.add('dark'));
await page.getByRole('tab').nth(1).click();
await page.getByRole('heading', { name: 'شجرة التصنيفات' }).waitFor();
await page.getByRole('button', { name: 'إضافة تصنيف أساسي' }).click();
await page.getByRole('dialog').waitFor();
await page.screenshot({ path: `${OUT}/classifications-add-category-dark.png` });

// 10. Mobile width, light theme again.
await page.getByRole('button', { name: 'إغلاق' }).click();
await page.evaluate(() => document.documentElement.classList.remove('dark'));
await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: `${OUT}/classifications-mobile-actions.png`, fullPage: true });

await browser.close();
console.log('screenshots written');
