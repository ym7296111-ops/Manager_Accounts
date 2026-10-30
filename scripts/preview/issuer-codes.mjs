/**
 * Screenshot pass for the issuer-code review (not part of the suite).
 *
 * 01 settings tab, desktop    02 the row just added      03 the rename dialog
 * 04 settings tab, mobile     05 entry page, desktop     06 the chosen code
 * 07 entry page, mobile       08 the same section at 390px
 */
import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const OUT = new URL('../../docs/reviews/aps-issuer-codes', import.meta.url).pathname;
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

/* One context for both harnesses: launching a second one after closing the
   first is what the single-process Lambda build cannot do. */
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 2,
});
await context.addInitScript(() => localStorage.setItem('admin-system:locale', 'ar'));
const page = await context.newPage();

/* ---------------------------------------------------------------- settings */
await page.goto('http://localhost:4173/?tab=issuers', { waitUntil: 'load' });
await page.getByRole('heading', { name: 'أكواد المُصدرين' }).first().waitFor();
await page.waitForTimeout(400);
await noOverflow(page);
await page.screenshot({ path: `${OUT}/01-settings-issuers-desktop-ar.png` });

/* The add dialog: two letters and an optional name. */
await page.getByRole('button', { name: 'إضافة كود جديد' }).click();
await page.getByRole('dialog').waitFor();
await page.getByLabel('الحرفان (مثال: YM)').fill('ab');
await page.getByLabel('الاسم / الوصف (اختياري)').fill('بدر');
await page.getByRole('dialog').getByRole('button', { name: 'حفظ' }).click();
await page.getByRole('alert').waitFor();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/02-settings-issuers-row-added-ar.png` });

/* The rename dialog shows the two letters read-only. */
await page.getByRole('button', { name: 'تعديل اسم AB — بدر' }).click();
await page.getByRole('dialog').waitFor();
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/03-settings-issuers-edit-dialog-ar.png` });
await page.getByRole('dialog').getByRole('button', { name: 'إلغاء' }).click();

/* Mobile: the same table at 390px, with no horizontal page scroll. */
await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
await page.waitForTimeout(500);
await noOverflow(page);
await page.screenshot({ path: `${OUT}/04-settings-issuers-mobile-ar.png` });

/* ------------------------------------------------------------------- entry */
await page.setViewportSize({ width: 1440, height: 1000 });
/* `load`, not `networkidle`: the harness keeps a Vite HMR socket open, so the
   network never goes idle. */
await page.goto('http://localhost:4174/workspaces/aps/letters/new', { waitUntil: 'load' });
await page.getByLabel('المُصدر').waitFor();
await page.getByLabel('رقم النظام (EPS)').fill('2458');
await page.waitForTimeout(300);
await noOverflow(page);
await page.screenshot({ path: `${OUT}/05-entry-letter-code-desktop-ar.png` });

/* A chosen issuer plus a typed number: the stored value is `YM:63`. */
await page.getByLabel('المُصدر').selectOption('YM');
await page.getByLabel('الرقم', { exact: true }).fill('63');
const header = page.locator('section', {
  has: page.getByRole('heading', { name: 'بيانات الخطاب' }),
});
await page.waitForTimeout(300);
await header.screenshot({ path: `${OUT}/06-entry-letter-code-filled-ar.png` });

/* Mobile: the two controls stay on one line and nothing overflows. */
await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
await page.waitForTimeout(600);
await noOverflow(page);
await page.screenshot({ path: `${OUT}/07-entry-mobile-top-ar.png` });
/* The section itself, so the new field is in the frame at 390px. */
await header.scrollIntoViewIfNeeded();
await page.waitForTimeout(400);
await header.screenshot({ path: `${OUT}/08-entry-letter-code-mobile-ar.png` });

await browser.close();
console.log('done');
