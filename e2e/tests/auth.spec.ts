import { expect, test } from '@playwright/test';
import { readFixtures } from '../fixtures/data.ts';
import { LoginPage } from '../pages/LoginPage.ts';

test.describe('public authentication & default post-login routing', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('admin-system:locale', 'en'));
  });

  test('signs in an approved owner and lands directly on "/"', async ({ page }) => {
    const { owner } = await readFixtures();

    /* Visit a deep route unauthenticated first; post-login must still route to `/`. */
    await page.goto('/settings/system/roles');
    await expect(page.locator('#login-email')).toBeVisible();

    const login = new LoginPage(page);
    await login.signIn(owner.email, owner.password);
    await login.expectSignedIn();
    await expect(page).toHaveURL(/\/$/);
  });

  test('returns cleanly to "/" from the 403 Access Denied screen', async ({ page }) => {
    const { delegate } = await readFixtures();
    const login = new LoginPage(page);
    await login.goto();
    await login.signIn(delegate.email, delegate.password);
    await login.expectSignedIn();
    await expect(page).toHaveURL(/\/$/);

    await page.goto('/settings/system/roles');
    await expect(page.getByText('403')).toBeVisible();
    await page.getByRole('button', { name: 'Back to dashboard', exact: true }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Welcome');
  });

  test('shows a clear error for a wrong password', async ({ page }) => {
    const { owner } = await readFixtures();
    const login = new LoginPage(page);
    await login.goto();
    await login.signIn(owner.email, 'wrong-password-for-e2e');
    await login.expectError('Invalid login credentials');
  });

  test('rejects a confirmed account while its profile is pending approval', async ({ page }) => {
    const { pending } = await readFixtures();
    const login = new LoginPage(page);
    await login.goto();
    await login.signIn(pending.email, pending.password);
    // Auth confirms the credentials but must keep a pending profile outside the protected app.
    await expect(page.locator('#login-email')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Account menu' })).toHaveCount(0);
  });
});
