/**
 * Screenshot pass for the «بيانات الخطاب» period bar (not part of the suite).
 *
 * It captures the section at 1440px and 390px, in Arabic, and asserts the three
 * things the review asked for: no repeated year, the month is the emphasis, and
 * the field labels are dark.
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const OUT = new URL('../../docs/reviews/aps-period-bar', import.meta.url).pathname;
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
const bar = header.locator('[role="status"]');

/* One year statement, and it is the fiscal year — not the month's own year. */
const text = (await bar.textContent()) ?? '';
expect(!/\d{4}\s*—/.test(text), `the bar still repeats a year: "${text}"`);
expect(/عام مالي \d{4}\/\d{4}/.test(text), `no fiscal year in "${text}"`);

/* The month is the only bold, dark item in the bar. */
const monthWeight = await bar
  .locator('span.text-foreground.font-semibold')
  .first()
  .evaluate((el) => getComputedStyle(el).fontWeight);
expect(Number(monthWeight) >= 600, `the month is not semibold (${monthWeight})`);

/* The two field labels are dark, full-strength foreground. */
for (const label of ['رقم النظام (EPS)', 'كود الخطاب']) {
  const color = await header
    .getByText(label, { exact: true })
    .evaluate((el) => getComputedStyle(el).color);
  const muted = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.className = 'text-muted-foreground';
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  });
  expect(color !== muted, `the label "${label}" is still muted (${color})`);
}

await page.getByLabel('رقم النظام (EPS)').fill('2458');
await page.getByLabel('المُصدر').selectOption('YM');
await page.getByLabel('الرقم', { exact: true }).fill('63');
await page.waitForTimeout(300);
await noOverflow(page);
await header.screenshot({ path: `${OUT}/01-period-bar-desktop-ar.png` });

await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
await page.waitForTimeout(600);
await noOverflow(page);
await header.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await header.screenshot({ path: `${OUT}/02-period-bar-mobile-ar.png` });

await context.close();
await browser.close();
console.log('done');
