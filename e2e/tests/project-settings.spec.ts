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

test('owner sees the stations accordion over the seeded directory', async ({ page }) => {
  await page.goto('/settings/project');

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Project Settings', exact: true })).toBeVisible();
  await expect(
    main.getByText(
      "Manage the project's master data: stations and warehouses, classifications, parties, and general settings.",
      { exact: true },
    ),
  ).toBeVisible();

  // Four tabs in the specified order, directly under the header.
  const tablist = main.getByRole('tablist');
  await expect(tablist).toBeVisible();
  const tabs = tablist.getByRole('tab');
  await expect(tabs).toHaveCount(4);
  await expect(tabs.nth(0)).toHaveText('Stations & Warehouses');
  await expect(tabs.nth(1)).toHaveText('Classifications');
  await expect(tabs.nth(2)).toHaveText('Parties');
  await expect(tabs.nth(3)).toHaveText('General');

  // First tab is active and renders the accordion over `supabase/seed.sql`.
  // Codes are asserted rather than labels: they are language-independent.
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(main.getByText('ST-01')).toBeVisible();
  await expect(main.getByText('ST-02')).toBeVisible();
  await expect(main.getByText('ST-03')).toBeVisible();

  // The write path is live, so the affordance is enabled — but nothing is
  // revealed, and no field is mounted, until the user acts.
  const addStation = main.getByRole('button', { name: /إضافة محطة|Add station/ });
  await expect(addStation).toBeVisible();
  await expect(addStation).toBeEnabled();
  await expect(main.getByText('WH-001')).toHaveCount(0);
  await expect(main.locator('input, select, textarea, form')).toHaveCount(0);

  /* Expanding the first station reveals its seeded warehouses. `aria-expanded`
     targets the header toggle specifically: the row's Edit / Deactivate /
     Delete buttons carry the station name in their accessible names too, so a
     name-only match is ambiguous under strict mode. */
  await main.locator('button[aria-expanded]').filter({ hasText: 'المحطة الرئيسية' }).click();
  await expect(main.getByText('WH-001')).toBeVisible();
  await expect(main.getByText('WH-002')).toBeVisible();
  await expect(main.getByText('WH-003')).toBeVisible();
  await expect(main.getByRole('button', { name: /إضافة مخزن|Add warehouse/ })).toBeEnabled();

  // The classifications tab renders the seeded tree over `supabase/seed.sql`.
  // Codes are asserted rather than labels: they are language-independent.
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(
    main.getByRole('heading', { name: /شجرة التصنيفات|Classifications tree/ }),
  ).toBeVisible();
  await expect(main.getByText('CLS-001')).toBeVisible();
  await expect(main.getByText('CLS-002')).toBeVisible();

  // Collapsed by default: no group or item exists in the DOM before the
  // category is opened. The add affordance is live (Phase 3), and each row
  // carries its own edit / activate / delete controls.
  await expect(main.getByText('CLS-003')).toHaveCount(0);
  await expect(main.getByRole('button', { name: /إضافة فئة رئيسية|Add category/ })).toBeEnabled();
  await expect(
    main.getByRole('button', { name: /تعديل المواد والمستلزمات|Edit المواد والمستلزمات/ }),
  ).toBeVisible();
  // A category with children offers no delete: the FK is the real guard, the
  // hidden button is the courtesy. (Covered in depth in classifications-crud.)
  await expect(
    main.getByRole('button', { name: /حذف المواد والمستلزمات|Delete المواد والمستلزمات/ }),
  ).toHaveCount(0);

  await main.locator('button[aria-expanded]').filter({ hasText: 'المواد والمستلزمات' }).click();
  await expect(main.getByText('CLS-003')).toBeVisible();
  await expect(main.getByText('CLS-004')).toBeVisible();
  await expect(main.getByText('CLS-006')).toHaveCount(0);
  await expect(main.getByRole('button', { name: /إضافة مجموعة|Add group/ }).first()).toBeEnabled();

  await main.locator('button[aria-expanded]').filter({ hasText: 'المواد الخام' }).click();
  await expect(main.getByText('CLS-006')).toBeVisible();
  await expect(main.getByRole('button', { name: /إضافة صنف|Add item/ }).first()).toBeEnabled();

  // The tree itself mounts no field: every write goes through a dialog that is
  // mounted only on demand (dialogs portal to <body>, outside <main>).
  await expect(main.locator('input, select, textarea, form')).toHaveCount(0);

  // The remaining tabs are still placeholders and issue no queries.
  await tabs.nth(2).click();
  await expect(main.getByText('Parties content — coming soon.', { exact: true })).toBeVisible();

  await tabs.nth(3).click();
  await expect(
    main.getByText('General settings content — coming soon.', { exact: true }),
  ).toBeVisible();

  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(main.getByText('ST-01')).toBeVisible();
  // Dialogs portal to <body>, so `main` stays free of form controls until one
  // is deliberately opened.
  await expect(main.locator('input, select, textarea, form')).toHaveCount(0);
});

test('hard load of /settings/project serves the screen, never a 404', async ({ page }) => {
  /* Regression guard for the production incident: a direct navigation to a
     client route fell through to the hosting SPA fallback and answered
     Vercel 404 NOT_FOUND. Click navigation always worked; only the hard
     load / first-visit deep link was broken. */
  const response = await page.goto('/settings/project');

  /* A hard load that dropped to the platform 404 would answer 404. */
  expect(response?.status()).toBeLessThan(400);

  await expect(page).toHaveURL(/\/settings\/project$/);

  /* Neither the hosting 404 nor the app's own 404 screen may appear. */
  await expect(page.getByText('Page not found')).toHaveCount(0);
  await expect(page.getByText('الصفحة غير موجودة')).toHaveCount(0);

  /* The real screen — header plus the four tabs — is what loads. */
  await expect(page.getByRole('heading', { name: 'Project Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('tablist')).toBeVisible();
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
