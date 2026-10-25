/**
 * Screenshot pass for the review (not part of the suite).
 *
 * Drives the preview harness on :4173 and captures the classifications tree and
 * the three «جهات الوارد والمنصرف» sub-tabs in Arabic (default), plus English,
 * dark and mobile frames. It also exercises the two rules the review asks
 * about: the outbound tab offers no type control, and a parent company with
 * branches cannot be deleted.
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

/* The Parties screen nests its own tablist inside the Project Settings tablist,
   so `getByRole('tab')` is ambiguous: pin the ids instead. */
async function openSettingsTab(tabId, heading) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator(`#project-settings-tab-${tabId}`).click();
  await page.getByRole('heading', { name: heading }).first().waitFor();
}

/* The sub-tab labels are buttons, not headings: wait for the panel itself. */
async function openPartiesSubTab(subTab) {
  await page.locator(`#parties-subtab-${subTab}`).click();
  await page.locator(`#parties-subtabpanel-${subTab}`).waitFor();
}

/* Review scratch state must not depend on a previous run: the harness keeps
   rows in memory only, and every reload starts from the seed. */

// ---------------------------------------------------------------------------
// Classifications (unchanged from the previous review, tab pinned by id).
// ---------------------------------------------------------------------------
await openSettingsTab('classifications', 'شجرة التصنيفات');
await page.screenshot({ path: `${OUT}/classifications-tree-actions.png` });

const toggleNamed = (name) =>
  page.locator('button[aria-expanded]').filter({ hasText: name }).first();

for (const name of ['مخزون', 'وقود', 'سولار', 'سولار تشغيل', 'ديزل معدات']) {
  await toggleNamed(name).click();
}
await page.getByText('ديزل آليات ثقيلة').waitFor();
await page.screenshot({ path: `${OUT}/classifications-deep-tree.png`, fullPage: true });

const deepRow = toggleNamed('ديزل آليات ثقيلة');
console.log('deep row tooltip:', await deepRow.getAttribute('title'));
await page.getByRole('button', { name: 'تعديل ديزل معدات' }).click();
await page.getByRole('dialog').waitFor();
await page.screenshot({ path: `${OUT}/classifications-deep-path.png` });
await page.getByRole('button', { name: 'إغلاق' }).click();

// ---------------------------------------------------------------------------
// Parties — inbound tab: the two supplier kinds, green, down-arrow.
// ---------------------------------------------------------------------------
await openSettingsTab('parties', 'جهات الوارد والمنصرف');
await openPartiesSubTab('inbound');
await page.getByText('شركة النيل للتوريدات الصناعية').waitFor();
await page.getByText('Nile Trading GmbH').waitFor();
const customerInInbound = await page.getByText('مؤسسة الأفق للتجارة والتوزيع').count();
expect(customerInInbound === 0, 'the inbound tab must not list customers');
console.log('inbound shows LOC-001 + FRN-001 and no customer rows');
await page.screenshot({ path: `${OUT}/parties-inbound.png` });

// 1b. The create dialog offers exactly the two inbound types.
await page.getByRole('button', { name: 'إضافة جهة' }).click();
await page.getByRole('dialog').waitFor();
const typeOptions = await page.getByLabel('نوع الجهة').locator('option').allTextContents();
console.log('inbound type options:', typeOptions);
expect(
  typeOptions.some((label) => label.includes('مورّد محلي')) &&
    typeOptions.some((label) => label.includes('مورّد أجنبي')) &&
    !typeOptions.some((label) => label.includes('عميل')) &&
    !typeOptions.some((label) => label.includes('داخلي')),
  'the inbound dialog must offer local + foreign suppliers only',
);
await page.screenshot({ path: `${OUT}/parties-add-inbound.png` });

/* 1c. Create a foreign supplier: the code comes from the FRN sequence on the
   server, so the form never shows a code field and the new row is FRN-002. */
await page.getByLabel('نوع الجهة').selectOption('foreign_supplier');
await page.getByLabel('اسم الجهة').fill('Delta Freight GmbH');
await page.getByLabel('الحد الائتماني').fill('120000');
await page.getByLabel('شروط الدفع').selectOption('60');
await page.getByRole('dialog').getByRole('button', { name: 'حفظ' }).click();
await page.getByText('تم الحفظ.').waitFor();
await page.getByText('FRN-002').waitFor();
await page.screenshot({ path: `${OUT}/parties-inbound-created.png` });
await page.getByRole('button', { name: 'إغلاق التنبيه' }).click();

// ---------------------------------------------------------------------------
// Parties — outbound tab: customers only, orange, up-arrow, no type control.
// ---------------------------------------------------------------------------
await openPartiesSubTab('outbound');
await page.getByText('مؤسسة الأفق للتجارة والتوزيع').waitFor();
const supplierInOutbound = await page.getByText('شركة النيل للتوريدات الصناعية').count();
expect(supplierInOutbound === 0, 'the outbound tab must not list suppliers');
await page.screenshot({ path: `${OUT}/parties-outbound.png` });

await page.getByRole('button', { name: 'إضافة جهة' }).click();
await page.getByRole('dialog').waitFor();
const outboundTypeSelects = await page.getByLabel('نوع الجهة').count();
expect(outboundTypeSelects === 0, 'the outbound dialog must not offer a type control');
await page.getByText('هذا التبويب يُنشئ عملاء فقط', { exact: false }).waitFor();
await page.screenshot({ path: `${OUT}/parties-add-outbound.png` });
await page.getByRole('dialog').getByRole('button', { name: 'إغلاق' }).click();

// ---------------------------------------------------------------------------
// Parties — sister companies: parent → branches tree, violet, building icon.
// ---------------------------------------------------------------------------
await openPartiesSubTab('sister');
await page.getByText('الشركة المتحدة للخدمات اللوجستية').waitFor();
await page.screenshot({ path: `${OUT}/parties-sister.png` });

await toggleNamed('الشركة المتحدة للخدمات اللوجستية').click();
await page.getByText('SIS-001-01', { exact: true }).waitFor();
await page.screenshot({ path: `${OUT}/parties-sister-tree.png` });

await page
  .getByRole('button', { name: 'إضافة فرع تحت «الشركة المتحدة للخدمات اللوجستية»' })
  .click();
await page.getByRole('dialog').waitFor();
await page.screenshot({ path: `${OUT}/parties-add-branch.png` });
await page.getByLabel('اسم الشركة').fill('المتحدة للشحن البحري');
await page.getByRole('dialog').getByRole('button', { name: 'حفظ' }).click();
await page.getByText('SIS-001-03', { exact: true }).waitFor();
await page.screenshot({ path: `${OUT}/parties-sister-created.png` });
await page.getByRole('button', { name: 'إغلاق التنبيه' }).click();

/* 3c. A branch under a branch is refused (22023): open the branch panel, count
   the "add branch" affordances. Branches never carry one. */
const branchToggle = await page
  .locator('button[aria-expanded]')
  .filter({ hasText: 'المتحدة للنقل الثقيل' })
  .count();
expect(branchToggle === 0, 'branches are leaves: they carry no expand control');
const nestedAdd = await page
  .getByRole('button', { name: 'إضافة فرع تحت «المتحدة للنقل الثقيل»' })
  .count();
expect(nestedAdd === 0, 'a branch must not offer to add a sub-branch');
console.log('branch rows are leaves: no expand control and no nested "add branch"');

/* 3d. 23503 translated: the delete affordance is hidden on a parent with
   branches, so provoke the race it protects against — add a branch underneath
   after the parent was created, then delete the (now stale) parent. */
const parentDelete = await page
  .getByRole('button', { name: 'حذف الشركة المتحدة للخدمات اللوجستية' })
  .count();
expect(parentDelete === 0, 'a parent with branches must not offer delete');

await page.getByRole('button', { name: 'إضافة شركة أم' }).click();
await page.getByLabel('اسم الشركة').fill('شركة تحت الاختبار');
await page.getByRole('dialog').getByRole('button', { name: 'حفظ' }).click();
await page.getByRole('button', { name: 'حذف شركة تحت الاختبار' }).waitFor();
await page.evaluate(() => window.__previewDb?.addBranch('شركة تحت الاختبار', 'فرع أُضيف للتو'));
await page.getByRole('button', { name: 'حذف شركة تحت الاختبار' }).click();
await page.getByRole('dialog').getByRole('button', { name: 'تأكيد الحذف' }).click();
await page.getByText('لا يمكن حذف هذه الشركة لأن لها فروعاً', { exact: false }).waitFor();
/* The refusal refetches the tree, so the stale row also stops offering delete:
   capture the message and the corrected row in the same frame. */
await page.screenshot({ path: `${OUT}/parties-sister-delete-refused.png`, fullPage: true });
await page.getByRole('button', { name: 'إغلاق التنبيه' }).click();
console.log('23503 surfaced as the has-branches message');

// ---------------------------------------------------------------------------
// English, dark and mobile frames.
// ---------------------------------------------------------------------------
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => window.localStorage.setItem('admin-system:locale', 'en'));
await page.reload({ waitUntil: 'networkidle' });
await page.locator('#parties-subtab-inbound').click();
await page.getByRole('heading', { name: 'Inbound & outbound parties' }).first().waitFor();
await page.screenshot({ path: `${OUT}/parties-inbound-en.png` });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  window.localStorage.removeItem('admin-system:locale');
  document.documentElement.classList.add('dark');
});
await page.reload({ waitUntil: 'networkidle' });
await page.evaluate(() => document.documentElement.classList.add('dark'));
await page.locator('#parties-subtab-sister').click();
await toggleNamed('الشركة المتحدة للخدمات اللوجستية').click();
await page.getByText('SIS-001-01', { exact: true }).waitFor();
await page.screenshot({ path: `${OUT}/parties-sister-dark.png` });

await page.evaluate(() => document.documentElement.classList.remove('dark'));
await page.setViewportSize({ width: 390, height: 844 });
await page.locator('#parties-subtab-inbound').click();
await page.getByText('LOC-001', { exact: true }).waitFor();
await page.screenshot({ path: `${OUT}/parties-inbound-mobile.png`, fullPage: true });

/* The table is wider than a phone on purpose (a badge cut in half would be
   worse than a scroll): the second frame scrolls it to the actions column. */
const scroller = page.locator('div.overflow-x-auto').first();
await scroller.evaluate((node) => {
  /* RTL scroll offsets run from 0 (natural start) down to -max: the actions
     column sits at the far end. */
  node.scrollLeft = -node.scrollWidth;
});
await page.screenshot({ path: `${OUT}/parties-inbound-mobile-actions.png` });

await browser.close();
console.log('screenshots written');
