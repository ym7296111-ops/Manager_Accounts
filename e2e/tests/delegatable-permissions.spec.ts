import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createLocalAdminClient, readFixtures } from '../fixtures/data.ts';
import { LoginPage } from '../pages/LoginPage.ts';
import { UsersPage } from '../pages/UsersPage.ts';

/*
 * Owner-configured capability delegation, end to end:
 *   owner enables `settings.manage` as delegatable (Roles & Permissions)
 *   → it becomes grantable to a viewer (Manage delegations) and lands
 *   → owner disables it
 *   → it vanishes from the dialog AND the database refuses a direct grant.
 * Protected permissions (`*`, `roles.manage`) always show a badge, never a
 * toggle. The flag is restored to OFF and the grant revoked in `finally`,
 * whatever happens, because it is instance-wide policy.
 */

const SETTINGS_SLUG = 'settings.manage';
const SETTINGS_LABEL = 'Manage general settings';

async function signInFreshOwnerSession(page: Page): Promise<void> {
  const { owner } = await readFixtures();
  await page.goto('/login');
  await page.evaluate(() => localStorage.removeItem('admin-system:auth'));
  await page.reload();
  await expect(page.locator('#login-email')).toBeVisible();

  const login = new LoginPage(page);
  await login.signIn(owner.email, owner.password);
  await login.expectSignedIn();
}

async function createApprovedViewer(): Promise<{ id: string; email: string }> {
  const admin = await createLocalAdminClient();
  const { owner } = await readFixtures();
  const email = `delegatable-viewer-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: `E2e-${randomUUID()}-Viewer!`,
    email_confirm: true,
    user_metadata: { full_name: 'Delegatable viewer' },
  });
  if (error || !data.user) throw new Error(`Could not create viewer: ${error?.message}`);
  const { error: approveError } = await admin.rpc('admin_approve_user', {
    p_user_id: data.user.id,
    p_action: 'approve',
    p_executor_id: owner.id,
    p_target_role: 'viewer',
  });
  if (approveError) throw new Error(`Could not approve viewer: ${approveError.message}`);
  return { id: data.user.id, email };
}

async function readSettingsDelegatable(): Promise<boolean> {
  const admin = await createLocalAdminClient();
  const { data, error } = await admin
    .from('permissions')
    .select('is_delegatable')
    .eq('slug', SETTINGS_SLUG)
    .single();
  if (error || !data) throw new Error(`Could not read delegatable flag: ${error?.message}`);
  return data.is_delegatable;
}

async function findLiveGrantId(userId: string): Promise<string | null> {
  const admin = await createLocalAdminClient();
  const { data: permission, error: permissionError } = await admin
    .from('permissions')
    .select('id')
    .eq('slug', SETTINGS_SLUG)
    .single();
  if (permissionError || !permission)
    throw new Error(`Could not read permission: ${permissionError?.message}`);
  const { data, error } = await admin
    .from('user_capabilities')
    .select('id')
    .eq('user_id', userId)
    .eq('permission_id', permission.id)
    .is('revoked_at', null)
    .maybeSingle();
  if (error) throw new Error(`Could not read live grant: ${error.message}`);
  return data?.id ?? null;
}

test('owner toggles delegatability: grant works while on, refused while off', async ({ page }) => {
  const { owner } = await readFixtures();
  const viewerA = await createApprovedViewer();
  const viewerB = await createApprovedViewer();
  let grantId: string | null = null;
  try {
    await signInFreshOwnerSession(page);

    /* Roles & Permissions: protected badges, then enable settings.manage. */
    await page.goto('/settings/system/roles');
    const section = page.getByTestId('delegatable-permissions');
    await expect(section).toBeVisible();
    await expect(page.getByTestId('delegatable-protected-*')).toContainText('Protected');
    await expect(page.getByTestId('delegatable-protected-roles.manage')).toContainText('Protected');
    expect(await page.getByTestId('delegatable-toggle-*').count()).toBe(0);
    expect(await page.getByTestId('delegatable-toggle-roles.manage').count()).toBe(0);

    const toggle = page.getByTestId(`delegatable-toggle-${SETTINGS_SLUG}`);
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(section.getByText(/is now delegatable/)).toBeVisible();
    expect(await readSettingsDelegatable()).toBe(true);

    /* Users: the freshly enabled capability is grantable to viewer A. */
    const users = new UsersPage(page);
    await users.goto();
    await users
      .userRow(viewerA.email)
      .getByRole('button', { name: 'Manage delegations', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Manage individual delegations' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Capability').selectOption(SETTINGS_SLUG);
    await dialog.getByLabel('No expiration date').check();
    await dialog.getByRole('button', { name: 'Grant capability', exact: true }).click();
    await expect(dialog.getByText('Capability granted successfully.')).toBeVisible();
    /* Tag selector, not getByRole('listitem'): Tailwind's preflight removes
       list markers, which makes Chromium drop list semantics entirely. */
    await expect(dialog.locator('li').filter({ hasText: SETTINGS_LABEL })).toBeVisible();
    await dialog.locator('button', { hasText: 'Close' }).click();
    await expect(dialog).toBeHidden();

    grantId = await findLiveGrantId(viewerA.id);
    expect(grantId).not.toBeNull();

    /* Owner disables it again: new delegations stop immediately. */
    await page.goto('/settings/system/roles');
    await expect(section).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(await readSettingsDelegatable()).toBe(false);

    /* Viewer B's dialog no longer offers the capability... */
    await users.goto();
    await users
      .userRow(viewerB.email)
      .getByRole('button', { name: 'Manage delegations', exact: true })
      .click();
    const dialogB = page.getByRole('dialog', { name: 'Manage individual delegations' });
    await expect(dialogB).toBeVisible();
    await expect(dialogB.locator(`option[value="${SETTINGS_SLUG}"]`)).toHaveCount(0);
    await dialogB.locator('button', { hasText: 'Close' }).click();
    await expect(dialogB).toBeHidden();

    /* ...and the database refuses the grant even when the UI is bypassed. */
    const admin = await createLocalAdminClient();
    const { error } = await admin.rpc('admin_grant_capability', {
      p_user_id: viewerB.id,
      p_permission_slug: SETTINGS_SLUG,
      p_expires_at: null,
      p_executor_id: owner.id,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain('capability_not_delegatable');
  } finally {
    const admin = await createLocalAdminClient();
    if (grantId !== null) {
      await admin.rpc('admin_revoke_capability', {
        p_capability_id: grantId,
        p_executor_id: owner.id,
      });
    }
    await admin.rpc('admin_set_permission_delegatable', {
      p_permission_slug: SETTINGS_SLUG,
      p_is_delegatable: false,
      p_executor_id: owner.id,
    });
    await admin.auth.admin.deleteUser(viewerA.id);
    await admin.auth.admin.deleteUser(viewerB.id);
  }
});
