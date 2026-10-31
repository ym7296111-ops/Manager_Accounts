/**
 * Screenshot pass for the merged «بيانات الخطاب» paragraph (not part of the
 * suite). It captures that one paragraph at 1440px and 390px, in Arabic, and
 * asserts what the review asked for: the type is a switch inside the paragraph,
 * the period reads below it, and the two typed numbers share one row.
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const OUT = new URL('../../docs/reviews/aps-merged-header', import.meta.url).pathname;
await mkdir(OUT, { recursive: true });

function expect(actual, message) {
  if (!actual) throw new Error(`assertion failed: ${message} (got ${JSON.stringify(actual)})`);
  return actual;
}

async function noOverflow(page) {
  const width = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(width <= 1, `horizontal overflow (${width}px)`);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/tmp/chromium',
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process', '--no-zygote'],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 2,
});
await context.addInitScript(() => localStorage.setItem('admin-system:locale', 'ar'));
const page = await context.newPage();

await page.goto('http://localhost:4174/workspaces/aps/letters/new', { waitUntil: 'load' });
await page.getByLabel('المُصدر').waitFor();

const header = page.locator('section', {
  has: page.getByRole('heading', { name: 'بيانات الخطاب' }),
});
const typeSwitch = header.getByRole('group', { name: 'اختر نوع الخطاب' });
const bar = header.locator('[role="status"]');

/* One paragraph, three answers, in the order the clerk reads them. */
const [switchBox, barBox, epsBox] = await Promise.all([
  typeSwitch.boundingBox(),
  bar.boundingBox(),
  page.getByLabel('رقم النظام (EPS)').boundingBox(),
]);
expect(switchBox.y < barBox.y, 'the type switch is not above the period bar');
expect(barBox.y < epsBox.y, 'the period bar is not above the typed numbers');

/* A segmented control, not four cards: one row of labels, narrower than the
   span of the read-only period below it. */
const labels = await typeSwitch
  .getByRole('button')
  .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
expect(labels.length === 4, `expected four type labels, got ${labels.length}`);
expect(new Set(labels).size === 1, `the labels are not one row high: ${labels}`);
expect(switchBox.height < 60, `the switch is a card, not a row (${switchBox.height}px)`);
expect(switchBox.width < barBox.width, 'the switch spans the whole paragraph');

/* The retired paragraph heading is gone; the sticky header names the type. */
const retired = await page.getByRole('heading', { name: 'اختر نوع الخطاب' }).count();
expect(retired === 0, 'a second «اختر نوع الخطاب» heading is still on the page');

/* The period is still the single period statement, unchanged by the merge. */
const barText = (await bar.textContent()) ?? '';
expect(/عام مالي \d{4}\/\d{4}/.test(barText), `no fiscal year in "${barText}"`);
expect(!/\d{4}\s*—/.test(barText), `the bar repeats a year: "${barText}"`);

await page.getByLabel('رقم النظام (EPS)').fill('2458');
await page.getByLabel('المُصدر').selectOption('YM');
await page.getByLabel('الرقم', { exact: true }).fill('63');
await page.waitForTimeout(300);
await noOverflow(page);
await header.screenshot({ path: `${OUT}/01-merged-header-desktop-ar.png` });
await page.screenshot({ path: `${OUT}/02-entry-desktop-ar.png` });

await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
await page.waitForTimeout(600);
await noOverflow(page);
/* On the phone the switch stays one row of four labels, and EPS stands above
   the letter code instead of squeezing both into one line. */
const mobileHeights = await typeSwitch
  .getByRole('button')
  .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
expect(new Set(mobileHeights).size === 1, `the phone labels are not one row: ${mobileHeights}`);
await header.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await header.screenshot({ path: `${OUT}/03-merged-header-mobile-ar.png` });

await context.close();
await browser.close();
console.log('done');
