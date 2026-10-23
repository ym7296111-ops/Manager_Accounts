import { expect, test as setup } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { readFixtures } from './fixtures/data.ts';
import { LoginPage } from './pages/LoginPage.ts';

const ownerState = fileURLToPath(new URL('../.auth/owner.json', import.meta.url));

setup('authenticate the owner once and save the browser session', async ({ page }) => {
  const { owner } = await readFixtures();
  await page.addInitScript(() => localStorage.setItem('admin-system:locale', 'en'));

  const login = new LoginPage(page);
  await login.goto();
  await login.signIn(owner.email, owner.password);

  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();
  await page.context().storageState({ path: ownerState });
});
