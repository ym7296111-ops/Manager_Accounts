/**
 * Screenshot pass for the external-transfer party review (not part of the suite).
 *
 * 01 the renamed field, closed      02 the open list, both types
 * 03 «شقيقة فقط»                    04 «غير شقيقة فقط»
 * 05 a chosen non-sister company    06 English, left to right
 * 07 the same section at 390px
 *
 * Run the harness first (`npm run preview:aps`, port 4174), then:
 *   CHROME_PATH=/path/to/chromium node scripts/preview/external-party.mjs
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const OUT = new URL('../../docs/reviews/aps-external-party', import.meta.url).pathname;
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

/* `load`, not `networkidle`: the harness keeps a Vite HMR socket open, so the
   network never goes idle. */
await page.goto('http://localhost:4174/workspaces/aps/letters/new', { waitUntil: 'load' });
await page
  .getByRole('group', { name: 'اختر نوع الخطاب' })
  .getByRole('button', { name: 'تحويل خارجي', exact: true })
  .click();
const field = page.getByLabel('جهة التحويل الخارجية', { exact: true });
await field.waitFor();
const filter = page.getByRole('group', { name: 'تصفية جهات التحويل الخارجية' });
const list = page.getByRole('listbox');

/* A letter header with real numbers reads better in a review shot. */
await page.getByLabel('رقم النظام (EPS)').fill('2458');
await page.getByLabel('المُصدر').selectOption('YM');
await page.getByLabel('الرقم', { exact: true }).fill('63');
await field.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
await noOverflow(page);

/* 01 — the field is «جهة التحويل الخارجية», with the type filter above it. */
await page.screenshot({ path: `${OUT}/01-entry-external-field-ar.png` });

/* 02 — the open list: every company carries its type glyph (Handshake for a
   sister company, Globe for a non-sister one; the hover tooltip is the native
   `title`, asserted by the review suite rather than drawn here). */
await field.click();
expect((await list.getByRole('option').count()) === 4, 'four companies under «الكل»');
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/02-dropdown-all-types-ar.png` });

/* 03 — sister only. */
await filter.getByRole('button', { name: 'شقيقة فقط', exact: true }).click();
expect((await list.getByRole('option').count()) === 2, 'two sister companies');
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/03-filter-sister-only-ar.png` });

/* 04 — non-sister only. */
await filter.getByRole('button', { name: 'غير شقيقة فقط', exact: true }).click();
expect((await list.getByRole('option').count()) === 2, 'two non-sister companies');
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/04-filter-non-sister-only-ar.png` });

/* 05 — a chosen non-sister company keeps its Globe in the closed field. */
await list.getByRole('option', { name: /الدلتا للمقاولات/ }).click();
expect((await field.inputValue()) === 'شركة الدلتا للمقاولات', 'the chosen non-sister company');
await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/05-selected-non-sister-ar.png` });

/* 06 — English: «External Transfer Party», left to right. The filter is
   presentation state and survives the locale switch, so return it to «All». */
await page.getByRole('button', { name: 'التبديل إلى English' }).click();
const enField = page.getByLabel('External Transfer Party', { exact: true });
await enField.waitFor();
await page
  .getByRole('group', { name: 'Filter external transfer parties' })
  .getByRole('button', { name: 'All', exact: true })
  .click();
await enField.click();
expect((await list.getByRole('option').count()) === 4, 'four companies in English too');
await page.waitForTimeout(200);
await noOverflow(page);
await page.screenshot({ path: `${OUT}/06-entry-external-en.png` });
await page.keyboard.press('Escape');

/* 07 — 390px: back to Arabic, the filter row and the open list fit. */
await page.getByRole('button', { name: 'Switch to العربية' }).click();
await field.waitFor();
await page.setViewportSize({ width: 390, height: 844 });
await field.scrollIntoViewIfNeeded();
await field.click();
await page.waitForTimeout(300);
await noOverflow(page);
await page.screenshot({ path: `${OUT}/07-entry-external-mobile-ar.png` });

await browser.close();
console.log(`saved 7 screenshots to ${OUT}`);
