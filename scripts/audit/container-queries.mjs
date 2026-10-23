// Real Chromium layout assertions over DOM exported by SettingsPage.audit.test.tsx.
// Adapters are mocked in that test; CSS is the actual production build output.
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import chromium from '../../.cache/live-audit/tooling/node_modules/@sparticuz/chromium/build/index.js';
import { inflate } from '../../.cache/live-audit/tooling/node_modules/@sparticuz/chromium/build/lambdafs.js';
import { chromium as playwright } from '../../.cache/live-audit/tooling/node_modules/playwright-core/index.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const toolPath = join(root, '.cache/live-audit/tooling/node_modules/@sparticuz/chromium');
const libraries = await inflate(join(toolPath, 'bin/al2023.tar.br'));
const cssFiles = (await readdir(join(root, 'dist/assets'))).filter((name) => name.endsWith('.css'));
assert.ok(cssFiles.length > 0, 'Run npm run build first.');
const css = (
  await Promise.all(cssFiles.map((name) => readFile(join(root, 'dist/assets', name), 'utf8')))
).join('\n');
const browser = await playwright.launch({
  executablePath: await chromium.executablePath(),
  args: chromium.args,
  headless: true,
  env: { ...process.env, LD_LIBRARY_PATH: `${libraries}/lib:${process.env.LD_LIBRARY_PATH ?? ''}` },
});
const results = [];

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
  await page.route('**/*', (route) => route.abort());
  for (const locale of ['ar', 'en']) {
    for (const section of ['users', 'roles', 'backup', 'support']) {
      const dom = await readFile(
        join(root, `.cache/live-audit/layouts/${section}-${locale}.html`),
        'utf8',
      );
      await page.setContent(
        `<!doctype html><html lang="${locale}" dir="${locale === 'ar' ? 'rtl' : 'ltr'}"><head><style>${css}</style></head><body><div id="audit-host">${dom}</div></body></html>`,
      );
      // Keep the VIEWPORT fixed. Change ONLY the available container width,
      // including both sides of every relevant query boundary (16px root font).
      for (const width of [400, 447, 448, 511, 512, 671, 672, 895, 896, 1000]) {
        await page.locator('#audit-host').evaluate((node, value) => {
          node.style.width = `${value}px`;
        }, width);
        const metrics = await page.evaluate((section) => {
          const container = document.querySelector('[class~="@container"]');
          const grid =
            section === 'users'
              ? container.querySelector('[role="rowgroup"] + [role="rowgroup"] [role="row"]')
              : section === 'backup'
                ? container.querySelector('.backup-row')
                : container.firstElementChild;
          const header =
            section === 'users'
              ? container.querySelector('[role="rowgroup"]')
              : section === 'backup'
                ? container.querySelector('[role="columnheader"]')?.parentElement
                : null;
          const label = container.querySelector('.backup-label');
          const schedule =
            section === 'backup' ? container.querySelector('section div.grid') : null;
          const manual =
            section === 'backup' ? container.querySelectorAll(':scope > section')[1] : null;
          const columns = (node) => getComputedStyle(node).gridTemplateColumns.split(/\s+/).length;
          return {
            viewport: innerWidth,
            containerWidth: container.getBoundingClientRect().width,
            containerType: getComputedStyle(container).containerType,
            gridColumns: columns(grid),
            headerDisplay: header ? getComputedStyle(header).display : null,
            labelDisplay: label ? getComputedStyle(label).display : null,
            scheduleColumns: schedule ? columns(schedule) : null,
            manualDirection: manual ? getComputedStyle(manual).flexDirection : null,
          };
        }, section);
        assert.equal(metrics.viewport, 1600);
        assert.equal(metrics.containerWidth, width);
        assert.equal(metrics.containerType, 'inline-size');
        assert.equal(
          metrics.gridColumns,
          section === 'roles' || section === 'support'
            ? width >= 896
              ? 2
              : 1
            : width >= 672
              ? section === 'users'
                ? 5
                : 4
              : 1,
          `${section}/${locale}/${width}: grid`,
        );
        if (section === 'users')
          assert.equal(metrics.headerDisplay, width >= 672 ? 'block' : 'none');
        if (section === 'backup') {
          assert.equal(metrics.headerDisplay, width >= 672 ? 'grid' : 'none');
          assert.equal(metrics.labelDisplay, width >= 672 ? 'none' : 'block');
          assert.equal(metrics.scheduleColumns, width >= 512 ? 3 : 1);
          assert.equal(metrics.manualDirection, width >= 448 ? 'row' : 'column');
        }
        results.push({ section, locale, width, ...metrics });
      }
      console.log(
        `PASS ${section}/${locale}: real container-width switching at a fixed 1600px viewport`,
      );
    }
  }
  await writeFile(
    join(root, '.cache/live-audit/container-results.json'),
    JSON.stringify(
      {
        browser: browser.version(),
        scope: 'Actual screen DOM, mocked data adapters, compiled production CSS',
        results,
      },
      null,
      2,
    ),
  );
  console.log(`${results.length} real-browser layout cases passed.`);
} finally {
  await browser.close();
}
