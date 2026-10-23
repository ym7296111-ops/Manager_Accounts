import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createLocalAdminClient, readFixtures } from '../fixtures/data.ts';
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

test('owner edits all project identity fields, uploads both assets, and writes an audit event', async ({
  page,
}) => {
  const { owner, supabaseUrl, anonKey } = await readFixtures();
  expect(supabaseUrl).toBeTruthy();
  expect(anonKey).toBeTruthy();

  await page.goto('/settings/project');
  await expect(page.getByRole('heading', { name: 'Project Settings', exact: true })).toBeVisible();

  const nameAr = page.getByLabel('Application name in Arabic', { exact: true });
  const nameEn = page.getByLabel('Application name in English', { exact: true });
  const email = page.getByLabel('Administrative email', { exact: true });
  const phone = page.getByLabel('Contact phone', { exact: true });
  const logo = page.getByLabel('Application logo', { exact: true });
  const favicon = page.getByLabel('Site icon (Favicon)', { exact: true });

  await expect(nameAr).toBeVisible();
  await expect(nameEn).toBeVisible();
  await expect(email).toBeVisible();
  await expect(phone).toBeVisible();
  await expect(logo).toBeAttached();
  await expect(favicon).toBeAttached();

  await nameAr.fill('هوية مشروع الاختبار');
  await nameEn.fill('Project E2E Identity');
  await email.fill('Project.Owner@Example.com');
  await phone.fill('+201000000123');

  const logoSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#155eef"/></svg>',
  );
  const faviconSvg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="15" fill="#12b76a"/></svg>',
  );
  await logo.setInputFiles({
    name: 'project-e2e-logo.svg',
    mimeType: 'image/svg+xml',
    buffer: logoSvg,
  });
  await favicon.setInputFiles({
    name: 'project-e2e-favicon.svg',
    mimeType: 'image/svg+xml',
    buffer: faviconSvg,
  });

  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Confirm identity save' });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Confirm save', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Public identity saved.' }),
  ).toBeVisible();
  await expect(page).toHaveTitle('Project E2E Identity');

  const service = await createLocalAdminClient();
  const { data: identity, error: identityError } = await service
    .from('app_identity_settings')
    .select(
      'name_ar,name_en,admin_email,phone,logo_path,logo_hash,favicon_path,favicon_hash,updated_by',
    )
    .eq('id', true)
    .single();
  if (identityError !== null || identity === null) {
    throw new Error(`Could not verify saved identity: ${identityError?.message ?? 'row missing'}`);
  }
  expect(identity).toMatchObject({
    name_ar: 'هوية مشروع الاختبار',
    name_en: 'Project E2E Identity',
    admin_email: 'project.owner@example.com',
    phone: '+201000000123',
    updated_by: owner.id,
  });
  expect(identity.logo_path).toMatch(/^identity\/logo\/.+\.svg$/);
  expect(identity.favicon_path).toMatch(/^identity\/favicon\/.+\.svg$/);
  expect(identity.logo_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(identity.favicon_hash).toMatch(/^[0-9a-f]{64}$/);

  const { data: audit, error: auditError } = await service
    .from('audit_logs')
    .select('actor_id,action,entity,entity_id,metadata')
    .eq('actor_id', owner.id)
    .eq('action', 'settings.updated')
    .eq('entity', 'app_identity_settings')
    .eq('entity_id', 'singleton')
    .order('id', { ascending: false })
    .limit(1)
    .single();
  if (auditError !== null || audit === null) {
    throw new Error(
      `Could not verify project audit event: ${auditError?.message ?? 'row missing'}`,
    );
  }
  expect(audit.metadata).toMatchObject({
    event: 'project.settings_updated',
    changed_fields: ['name_ar', 'name_en', 'admin_email', 'phone', 'logo_path', 'favicon_path'],
    after: {
      name_ar: 'هوية مشروع الاختبار',
      name_en: 'Project E2E Identity',
    },
  });
  const serializedAudit = JSON.stringify(audit.metadata);
  expect(serializedAudit).not.toContain('project.owner@example.com');
  expect(serializedAudit).not.toContain('+201000000123');
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
    await expect(page.getByLabel('Application name in Arabic', { exact: true })).toHaveCount(0);
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
