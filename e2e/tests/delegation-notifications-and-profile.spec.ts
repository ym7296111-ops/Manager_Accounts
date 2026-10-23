import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createLocalAdminClient, readFixtures } from '../fixtures/data.ts';
import { DashboardPage } from '../pages/DashboardPage.ts';
import { LoginPage } from '../pages/LoginPage.ts';
import { UsersPage } from '../pages/UsersPage.ts';

interface TempViewer {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

async function createApprovedViewer(): Promise<TempViewer> {
  const admin = await createLocalAdminClient();
  const { owner } = await readFixtures();
  const email = `profile-delegate-${randomUUID()}@example.com`;
  const password = `E2e-${randomUUID()}-Viewer!`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'Delegation lifecycle viewer' },
  });
  if (error || !data.user) {
    throw new Error(`Could not create viewer fixture: ${error?.message}`);
  }
  const { error: approveError } = await admin.rpc('admin_approve_user', {
    p_user_id: data.user.id,
    p_action: 'approve',
    p_executor_id: owner.id,
    p_target_role: 'viewer',
  });
  if (approveError) {
    throw new Error(`Could not approve viewer fixture: ${approveError.message}`);
  }
  return { id: data.user.id, email, password };
}

async function signInAs(
  page: Page,
  email: string,
  password: string,
  locale: 'en' | 'ar' = 'en',
): Promise<void> {
  await page.goto('/login');
  await page.evaluate((nextLocale) => {
    localStorage.removeItem('admin-system:auth');
    localStorage.setItem('admin-system:locale', nextLocale);
  }, locale);
  await page.reload();
  const login = new LoginPage(page);
  await login.signIn(email, password);
  await login.expectSignedIn();
}

test('owner grants viewer capability via UI → viewer receives bell notification and sees delegation on /profile', async ({
  page,
}) => {
  const { owner } = await readFixtures();
  const viewer = await createApprovedViewer();
  const admin = await createLocalAdminClient();

  try {
    await signInAs(page, owner.email, owner.password, 'en');

    const users = new UsersPage(page);
    await users.goto();
    await users
      .userRow(viewer.email)
      .getByRole('button', { name: 'Manage delegations', exact: true })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Manage individual delegations' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Capability').selectOption('users.approve');
    await dialog.getByRole('button', { name: 'Grant capability', exact: true }).click();
    await expect(dialog.getByText('Capability granted successfully.')).toBeVisible();
    await dialog.locator('button', { hasText: 'Close' }).click();
    await expect(dialog).toBeHidden();

    /* Viewer signs in, sees bell notification, clicks it -> lands on /profile#delegations. */
    await signInAs(page, viewer.email, viewer.password, 'en');
    const dashboard = new DashboardPage(page);
    await dashboard.openNotifications();

    const panel = page.getByRole('dialog', { name: 'Notifications' });
    const grantRow = panel.locator('li', {
      hasText: 'You were granted a delegation: users.approve',
    });
    await expect(grantRow).toBeVisible();
    await expect(grantRow.locator('[data-icon="shield"]')).toBeVisible();
    await expect(grantRow).toContainText(owner.email);

    await grantRow.locator('a').click();
    await expect(page).toHaveURL(/\/profile#delegations$/);

    /* Profile page displays both viewer role and active delegation row with status pill. */
    const rolesSection = page.getByTestId('profile-roles-section');
    await expect(rolesSection).toBeVisible();
    await expect(page.getByTestId('profile-role-viewer')).toContainText('viewer');

    const delegationsSection = page.getByTestId('profile-delegations-section');
    await expect(delegationsSection).toBeVisible();
    const delegationItem = page.getByTestId('profile-delegation-users.approve');
    await expect(delegationItem).toBeVisible();
    await expect(delegationItem).toContainText('users.approve');
    await expect(delegationItem).toContainText(owner.email);
    await expect(delegationItem.getByTestId('delegation-status-badge')).toContainText('🕐');
  } finally {
    await admin.from('user_notifications').delete().eq('user_id', viewer.id);
    await admin.auth.admin.deleteUser(viewer.id);
  }
});

test('owner revokes capability → viewer receives revocation notification and /profile shows empty state', async ({
  page,
}) => {
  const { owner } = await readFixtures();
  const viewer = await createApprovedViewer();
  const admin = await createLocalAdminClient();

  try {
    const { data: capId, error: grantError } = await admin.rpc('admin_grant_capability', {
      p_user_id: viewer.id,
      p_permission_slug: 'users.approve',
      p_expires_at: null,
      p_executor_id: owner.id,
    });
    if (grantError || !capId) {
      throw new Error(`Could not seed grant for revocation test: ${grantError?.message}`);
    }

    const { error: revokeError } = await admin.rpc('admin_revoke_capability', {
      p_capability_id: capId,
      p_executor_id: owner.id,
    });
    if (revokeError) {
      throw new Error(`Could not revoke grant: ${revokeError.message}`);
    }

    await signInAs(page, viewer.email, viewer.password, 'en');
    await new DashboardPage(page).openNotifications();

    const panel = page.getByRole('dialog', { name: 'Notifications' });
    const revokeRow = panel.locator('li', {
      hasText: 'Your delegation was revoked: users.approve',
    });
    await expect(revokeRow).toBeVisible();
    await expect(revokeRow.locator('[data-icon="shield-off"]')).toBeVisible();

    await revokeRow.locator('a').click();
    await expect(page).toHaveURL(/\/profile#delegations$/);
    await expect(page.getByTestId('profile-delegations-empty')).toHaveText(
      'You do not have any extra delegations right now',
    );
  } finally {
    await admin.from('user_notifications').delete().eq('user_id', viewer.id);
    await admin.auth.admin.deleteUser(viewer.id);
  }
});

test('scheduled expiry sweep notifies both delegate (/profile#delegations) and granter (/settings/system/users)', async ({
  page,
}) => {
  const { owner } = await readFixtures();
  const viewer = await createApprovedViewer();
  const admin = await createLocalAdminClient();
  let grantedCapId: string | null = null;

  try {
    const fiveDaysOut = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const { data: capId, error: grantError } = await admin.rpc('admin_grant_capability', {
      p_user_id: viewer.id,
      p_permission_slug: 'users.approve',
      p_expires_at: fiveDaysOut,
      p_executor_id: owner.id,
    });
    if (grantError || !capId) {
      throw new Error(`Could not create expiring grant: ${grantError?.message}`);
    }
    grantedCapId = capId;

    const { error: sweepError } = await admin.rpc('generate_delegation_expiry_notifications');
    if (sweepError) {
      throw new Error(`Could not execute expiry sweep: ${sweepError.message}`);
    }

    /* Granter sees Clock icon + renewal notice linking to /settings/system/users. */
    await signInAs(page, owner.email, owner.password, 'en');
    await new DashboardPage(page).openNotifications();
    const ownerPanel = page.getByRole('dialog', { name: 'Notifications' });
    const granterRow = ownerPanel.locator('li', { hasText: viewer.email });
    await expect(granterRow).toBeVisible();
    await expect(granterRow.locator('[data-icon="clock"]')).toBeVisible();
    await expect(granterRow.locator('a')).toHaveAttribute('href', '/settings/system/users');

    /* Delegate sees Clock icon + expiry warning linking to /profile#delegations. */
    await signInAs(page, viewer.email, viewer.password, 'en');
    await new DashboardPage(page).openNotifications();
    const viewerPanel = page.getByRole('dialog', { name: 'Notifications' });
    const delegateRow = viewerPanel.locator('li', {
      hasText: /Your delegation users\.approve expires in \d+ days/,
    });
    await expect(delegateRow).toBeVisible();
    await expect(delegateRow.locator('[data-icon="clock"]')).toBeVisible();
    await expect(delegateRow.locator('a')).toHaveAttribute('href', '/profile#delegations');
  } finally {
    if (grantedCapId !== null) {
      await admin.from('user_notifications').delete().eq('related_id', grantedCapId);
    }
    await admin.from('user_notifications').delete().eq('user_id', viewer.id);
    await admin.auth.admin.deleteUser(viewer.id);
  }
});
