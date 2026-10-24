import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFixtures } from '../fixtures/data.ts';
import type { E2EDatabase } from '../fixtures/database.types.ts';
import { LoginPage } from '../pages/LoginPage.ts';

const IDENTITY_ADMIN_RPCS = new Set([
  'can_manage_app_identity',
  'can_manage_project_settings',
  'admin_update_app_identity',
  'admin_update_project_settings',
]);

async function signInAsOrdinaryAdmin(page: Page): Promise<void> {
  const { admin } = await readFixtures();
  await page.addInitScript(() => localStorage.setItem('admin-system:locale', 'en'));
  const login = new LoginPage(page);
  await login.goto();
  await login.signIn(admin.email, admin.password);
  await login.expectSignedIn();
}

test('owner sees an empty project settings page with no form fields', async ({ page }) => {
  await page.goto('/settings/project');

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Project Settings', exact: true })).toBeVisible();
  await expect(
    main.getByText('Project identity, administrator contact details, logo and favicon.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    main.getByRole('heading', { name: 'Nothing to show yet', exact: true }),
  ).toBeVisible();
  await expect(
    main.getByText('This screen is ready to be wired to Supabase data.', { exact: true }),
  ).toBeVisible();
  await expect(main.locator('input, select, textarea, form')).toHaveCount(0);
});

test.describe('ordinary admin without project.settings:manage', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('receives UI 403 without mounting identity-admin access or update RPCs', async ({
    page,
  }) => {
    const identityAdminRpcCalls: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      const rpcName = url.pathname.startsWith('/rest/v1/rpc/')
        ? url.pathname.slice('/rest/v1/rpc/'.length)
        : null;
      if (rpcName !== null && IDENTITY_ADMIN_RPCS.has(rpcName)) {
        identityAdminRpcCalls.push(rpcName);
      }
    });

    await signInAsOrdinaryAdmin(page);
    await page.goto('/settings/project');

    await expect(page).toHaveURL(/\/settings\/project$/);
    await expect(page.getByRole('alert').filter({ hasText: '403' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Access denied/i })).toBeVisible();
    await expect(page.getByRole('main').locator('input, select, textarea, form')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Project Settings', exact: true })).toHaveCount(0);
    expect(identityAdminRpcCalls).toEqual([]);
  });

  test('receives SQLSTATE 42501 from a direct authenticated project update RPC', async () => {
    const { admin, supabaseUrl, anonKey } = await readFixtures();
    const client = createClient<E2EDatabase>(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: signInError } = await client.auth.signInWithPassword({
      email: admin.email,
      password: admin.password,
    });
    expect(signInError).toBeNull();

    const { data: canManage, error: accessError } = await client.rpc('can_manage_project_settings');
    expect(accessError).toBeNull();
    expect(canManage).toBe(false);

    const { error } = await client.rpc('admin_update_project_settings', {
      p_name_ar: 'تحديث ممنوع',
      p_name_en: 'Denied ordinary admin',
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe('42501');
  });
});
