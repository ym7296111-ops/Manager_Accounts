/**
 * Screenshot pass for the review (not part of the suite).
 *
 * Drives the preview harness on :4173 and captures the classifications tree,
 * the two «جهات الوارد والمنصرف» sub-tabs and the «الشركات الشقيقة» tab (a
 * top-level tab of its own) in Arabic (default), plus English, dark and mobile
 * frames. It also checks the fiscal tabs, cards and date inputs at 390px, and
 * exercises the two rules the review asks about: the outbound tab offers no
 * type control, and a parent company with branches cannot be deleted.
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

/* Top-level project-settings tabs are pinned by id: their labels are localized
   and the sister tree also uses headings with similar names. */
async function openSettingsTab(tabId, heading) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator(`#project-settings-tab-${tabId}`).click();
  await page.getByRole('heading', { name: heading }).first().waitFor();
}

/* Both roots render their panel: wait for it before shooting. */
async function openPartiesRoot(branch) {
  await page.locator(`#parties-root-panel-${branch}`).waitFor();
}

async function assertMobileViewport() {
  const measurements = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const pageWidth = document.documentElement.scrollWidth;
    const clippedTabs = Array.from(document.querySelectorAll('[role="tab"]'))
      .filter((tab) => {
        const bounds = tab.getBoundingClientRect();
        return (
          bounds.width > 0 &&
          (bounds.left < -1 ||
            bounds.right > viewportWidth + 1 ||
            tab.scrollWidth > tab.clientWidth + 1)
        );
      })
      .map((tab) => tab.id);
    return { viewportWidth, pageWidth, clippedTabs };
  });
  expect(
    measurements.pageWidth <= measurements.viewportWidth,
    `page has horizontal overflow at ${measurements.viewportWidth}px: ${measurements.pageWidth}px`,
  );
  expect(
    measurements.clippedTabs.length === 0,
    `clipped tabs: ${measurements.clippedTabs.join(', ')}`,
  );
  return measurements;
}

async function assertFieldsFit(selector, label) {
  const fields = await page.locator(selector).evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
      };
    }),
  );
  expect(fields.length > 0, `${label}: no fields found`);
  for (const field of fields) {
    expect(
      field.left >= 0 && field.right <= 390,
      `${label}: field outside viewport: ${JSON.stringify(field)}`,
    );
    expect(
      field.scrollWidth <= field.width + 1,
      `${label}: field content is clipped: ${JSON.stringify(field)}`,
    );
  }
  return fields;
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
// Parties — the two-root tree: inbound (green, down-arrow) and outbound
// (orange, up-arrow), one flat level of parties under each.
// ---------------------------------------------------------------------------
await openSettingsTab('parties', 'جهات الوارد وأغراض الصرف');
await openPartiesRoot('inbound');
await page.getByText('شركة النيل للتوريدات الصناعية').waitFor();
await page.getByText('Nile Trading GmbH').waitFor();
const customersUnderInbound = await page
  .locator('#parties-root-panel-inbound')
  .getByText('مؤسسة الأفق للتجارة والتوزيع')
  .count();
expect(customersUnderInbound === 0, 'the inbound root must not list outbound parties');
console.log('inbound shows IN-001 + IN-002 and no outbound rows');
await page.screenshot({ path: `${OUT}/parties-inbound.png` });

/* 1b. A party is a name: the create dialog has one field and no selects. */
await page.getByRole('button', { name: 'إضافة جهة داخل «جهات الوارد»' }).click();
await page.getByRole('dialog').waitFor();
const dialogFields = await page.getByRole('dialog').locator('input, select, textarea').count();
expect(dialogFields === 1, 'the party dialog must hold exactly one field');
await page.getByText('IN-###').waitFor();
await page.screenshot({ path: `${OUT}/parties-add-inbound.png` });

/* 1c. Create one: the code comes from the IN sequence on the server. */
await page.getByLabel('اسم الجهة').fill('مورّد الدلتا للتوريدات');
await page.getByRole('dialog').getByRole('button', { name: 'حفظ' }).click();
await page.getByText('تم الحفظ.').waitFor();
await page.getByText('IN-003', { exact: true }).waitFor();
await page.screenshot({ path: `${OUT}/parties-inbound-created.png` });
await page.getByRole('button', { name: 'إغلاق التنبيه' }).click();

// ---------------------------------------------------------------------------
// Parties — outbound root: orange, up-arrow, its own OUT sequence.
// ---------------------------------------------------------------------------
await page.getByText('مؤسسة الأفق للتجارة والتوزيع').waitFor();
const inboundRowsUnderOutbound = await page
  .locator('#parties-root-panel-outbound')
  .getByText('شركة النيل للتوريدات الصناعية')
  .count();
expect(inboundRowsUnderOutbound === 0, 'the outbound root must not list inbound parties');
await page.screenshot({ path: `${OUT}/parties-outbound.png` });

await page.getByRole('button', { name: 'إضافة جهة داخل «أغراض الصرف»' }).click();
await page.getByRole('dialog').waitFor();
await page.getByText('OUT-###').waitFor();
await page.screenshot({ path: `${OUT}/parties-add-outbound.png` });
await page.getByLabel('اسم الجهة').fill('جهة صرف الدلتا');
await page.getByRole('dialog').getByRole('button', { name: 'حفظ' }).click();
await page.getByText('OUT-002', { exact: true }).waitFor();
await page.screenshot({ path: `${OUT}/parties-outbound-created.png` });
await page.getByRole('button', { name: 'إغلاق التنبيه' }).click();

/* 2b. Collapsing a root leaves the other exactly where it was. */
await page.locator('#parties-root-inbound').click();
await page.locator('#parties-root-panel-inbound').waitFor({ state: 'detached' });
await page.screenshot({ path: `${OUT}/parties-collapsed-inbound.png` });
await page.locator('#parties-root-inbound').click();
await openPartiesRoot('inbound');

// ---------------------------------------------------------------------------
// Sister companies — a top-level tab now: the parent → branches tree opens
// directly, with no sub-tabs of its own.
// ---------------------------------------------------------------------------
await openSettingsTab('sisterCompanies', 'شجرة الشركات الشقيقة');
const partyRootsOnSisterTab = await page.locator('[id^="parties-root-"]').count();
expect(partyRootsOnSisterTab === 0, 'the sister-companies tab must not mount the parties tree');
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
await page.locator('#project-settings-tab-parties').click();
await openPartiesRoot('inbound');
await page.getByRole('heading', { name: 'Inbound parties & outbound purposes' }).first().waitFor();
await page.screenshot({ path: `${OUT}/parties-inbound-en.png` });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => {
  window.localStorage.removeItem('admin-system:locale');
  document.documentElement.classList.add('dark');
});
await page.reload({ waitUntil: 'networkidle' });
await page.evaluate(() => document.documentElement.classList.add('dark'));
await page.locator('#project-settings-tab-sisterCompanies').click();
await toggleNamed('الشركة المتحدة للخدمات اللوجستية').click();
await page.getByText('SIS-001-01', { exact: true }).waitFor();
await page.screenshot({ path: `${OUT}/parties-sister-dark.png` });

await page.evaluate(() => document.documentElement.classList.remove('dark'));
await page.setViewportSize({ width: 390, height: 844 });
await page.locator('#project-settings-tab-parties').click();
await openPartiesRoot('inbound');
await page.getByText('IN-001', { exact: true }).waitFor();
await page.screenshot({ path: `${OUT}/parties-inbound-mobile.png`, fullPage: true });

// General → opening balances on a real 390px RTL viewport. The cards are
// expanded so the mobile capture includes the numeric fields, not just the
// empty accordion headers.
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.setViewportSize({ width: 390, height: 844 });
await page.locator('#project-settings-tab-general').click();
const annualViewport = await assertMobileViewport();
console.log('annual settings mobile layout:', annualViewport);
await page.locator('#fiscal-settings-tab-periods').click();
await page.locator('#current-fiscal-period').waitFor();
const periodViewport = await assertMobileViewport();
console.log('period settings mobile layout:', periodViewport);
const periodFields = await assertFieldsFit('#current-fiscal-period', 'current period');
console.log('period field bounds:', periodFields);
await page.locator('#fiscal-settings-tab-openingBalances').click();
await page.locator('#opening-station-toggle-s-1').click();
await page.locator('#opening-warehouse-toggle-w-1').click();
const openingViewport = await assertMobileViewport();
console.log('opening balances mobile layout:', openingViewport);
const openingFields = await assertFieldsFit(
  '#opening-warehouse-panel-w-1 input',
  'opening-balance inputs',
);
console.log('opening-balance input count:', openingFields.length);
await page.screenshot({ path: `${OUT}/fiscal-opening-balances-mobile-390.png`, fullPage: true });

// The shared date inputs also remain inside the modal at phone width.
await page.locator('#fiscal-settings-tab-annual').click();
await page.getByRole('button', { name: 'إضافة سنة مالية' }).click();
const fiscalDateFields = await page
  .getByRole('dialog')
  .locator('input[type="date"]')
  .evaluateAll((fields) =>
    fields.map((field) => {
      const bounds = field.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        width: field.clientWidth,
        scrollWidth: field.scrollWidth,
      };
    }),
  );
expect(fiscalDateFields.length === 2, 'the fiscal-year modal should have two date fields');
for (const field of fiscalDateFields) {
  expect(
    field.left >= 0 && field.right <= 390,
    `date field outside viewport: ${JSON.stringify(field)}`,
  );
  expect(
    field.scrollWidth <= field.width + 1,
    `date field text is clipped: ${JSON.stringify(field)}`,
  );
}
const modalViewport = await assertMobileViewport();
console.log('fiscal-year date modal mobile layout:', modalViewport);
await page.screenshot({ path: `${OUT}/fiscal-year-date-modal-mobile-390.png`, fullPage: true });

await browser.close();
console.log('screenshots written');
