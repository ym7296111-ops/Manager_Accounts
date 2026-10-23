import { expect, test } from '@playwright/test';

const WORKSPACE_REDIRECTS = [
  {
    legacyPath: '/workspaces/1',
    canonicalPath: '/workspaces/aps',
    slug: 'aps',
    title: 'APS',
  },
  {
    legacyPath: '/workspaces/2',
    canonicalPath: '/workspaces/workshops-10th',
    slug: 'workshops-10th',
    title: 'المنتج التام — ورش العاشر',
  },
  {
    legacyPath: '/workspaces/3',
    canonicalPath: '/workspaces/reports',
    slug: 'reports',
    title: 'التقارير والاستعلامات',
  },
] as const;

for (const workspace of WORKSPACE_REDIRECTS) {
  test(`redirects ${workspace.legacyPath} to ${workspace.canonicalPath} with visual evidence`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem('admin-system:locale', 'ar'));
    await page.goto(workspace.legacyPath);

    await expect(page).toHaveURL(new RegExp(`${workspace.canonicalPath}/?$`));
    const heading = page.getByRole('heading', { name: workspace.title, exact: true });
    await expect(heading).toBeVisible();
    await expect(page).toHaveTitle(new RegExp(`^${workspace.title} \\| `));

    const screenshotPath = testInfo.outputPath(`workspace-${workspace.slug}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach(`workspace-${workspace.slug}`, {
      path: screenshotPath,
      contentType: 'image/png',
    });
  });
}
