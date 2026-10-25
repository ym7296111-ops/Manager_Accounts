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

  // Five tabs in the specified order, directly under the header. The parties
  // panel mounts a nested tablist of its own, so the top-level tabs are
  // selected by their stable ids rather than by role.
  const tablist = main.getByRole('tablist').first();
  await expect(tablist).toBeVisible();
  const tabs = main.locator('[id^="project-settings-tab-"]');
  await expect(tabs).toHaveCount(5);
  await expect(tabs.nth(0)).toHaveText('Stations & Warehouses');
  await expect(tabs.nth(1)).toHaveText('Classifications');
  await expect(tabs.nth(2)).toHaveText('Inbound & Outbound');
  // Sister companies sits at the top level now, as a peer of the directories;
  // General remains last.
  await expect(tabs.nth(3)).toHaveText('Sister companies');
  await expect(tabs.nth(4)).toHaveText('General');

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
  await expect(
    main.getByRole('button', { name: /إضافة تصنيف أساسي|Add main classification/ }),
  ).toBeEnabled();
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
  await expect(
    main.getByRole('button', { name: /إضافة تصنيف فرعي|Add sub-classification/ }).first(),
  ).toBeEnabled();

  await main.locator('button[aria-expanded]').filter({ hasText: 'المواد الخام' }).click();
  await expect(main.getByText('CLS-006')).toBeVisible();
  await expect(
    main.getByRole('button', { name: /إضافة تصنيف فرعي|Add sub-classification/ }).first(),
  ).toBeEnabled();

  // The tree itself mounts no field: every write goes through a dialog that is
  // mounted only on demand (dialogs portal to <body>, outside <main>).
  await expect(main.locator('input, select, textarea, form')).toHaveCount(0);

  // The parties tab renders two sub-tabs. Inbound is open first and holds the
  // two seeded supplier kinds, each with the code its own sequence minted; the
  // customer belongs to the outbound tab.
  await tabs.nth(2).click();
  const partiesTabs = main.getByRole('tablist', { name: 'Inbound & outbound parties' });
  await expect(partiesTabs.getByRole('tab')).toHaveCount(2);
  await expect(partiesTabs.getByRole('tab', { name: 'Sister companies' })).toHaveCount(0);
  await expect(partiesTabs.getByRole('tab', { name: 'Inbound parties' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(main.getByText('شركة النيل للتوريدات الصناعية')).toBeVisible();
  await expect(main.getByText('LOC-001')).toBeVisible();
  await expect(main.getByText('FRN-001')).toBeVisible();
  await expect(main.getByText('CUS-001')).toHaveCount(0);

  await partiesTabs.getByRole('tab', { name: 'Outbound parties' }).click();
  await expect(main.getByText('CUS-001')).toBeVisible();
  await expect(main.getByText('LOC-001')).toHaveCount(0);

  // The sister-companies tab opens the tree directly — no sub-tabs of its own.
  await tabs.nth(3).click();
  await expect(tabs.nth(3)).toHaveAttribute('aria-selected', 'true');
  /* Exact: the section description also names SIS-001 as the code shape. */
  await expect(main.getByText('SIS-001', { exact: true })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Sister companies tree' })).toBeVisible();
  await expect(main.getByRole('tablist')).toHaveCount(1);

  // Writes again go through dialogs that portal to <body>, so `main` itself
  // holds no form controls.
  await expect(main.locator('input, select, textarea, form')).toHaveCount(0);

  // The remaining tab is still a placeholder and issues no queries.

  await tabs.nth(4).click();
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

  /* The real screen — header plus the five tabs — is what loads. */
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
