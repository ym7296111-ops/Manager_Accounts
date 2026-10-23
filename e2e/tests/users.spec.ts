import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createLocalAdminClient, readFixtures } from '../fixtures/data.ts';
import { LoginPage } from '../pages/LoginPage.ts';
import { UsersPage } from '../pages/UsersPage.ts';

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

test('invites a new user and reveals the one-time temporary password', async ({ page }) => {
  const email = `invited-${randomUUID()}@example.com`;
  await signInFreshOwnerSession(page);

  const users = new UsersPage(page);
  await users.goto();
  const temporaryPassword = await users.invite(email);

  expect(temporaryPassword.length).toBeGreaterThan(8);
  await expect(users.userRow(email)).toContainText('Approved');
});

test('approves a pending user and changes its approval status', async ({ page }) => {
  const { pending } = await readFixtures();
  await signInFreshOwnerSession(page);

  const users = new UsersPage(page);
  await users.goto();
  await users.approve(pending.email);
});

test('highlights a newly delegated user with a Shield badge and filters via the Delegated tab', async ({
  page,
}) => {
  const { owner } = await readFixtures();
  const admin = await createLocalAdminClient();
  const targetEmail = `delegated-badge-${randomUUID()}@example.com`;
  const regularEmail = `regular-badge-${randomUUID()}@example.com`;

  const [{ data: targetCreated, error: targetErr }, { data: regularCreated, error: regularErr }] =
    await Promise.all([
      admin.auth.admin.createUser({
        email: targetEmail,
        password: `E2e-${randomUUID()}-Target!`,
        email_confirm: true,
        user_metadata: { full_name: 'Badge target user' },
      }),
      admin.auth.admin.createUser({
        email: regularEmail,
        password: `E2e-${randomUUID()}-Regular!`,
        email_confirm: true,
        user_metadata: { full_name: 'Regular comparison user' },
      }),
    ]);
  if (targetErr || !targetCreated.user) {
    throw new Error(`Could not create badge target user: ${targetErr?.message}`);
  }
  if (regularErr || !regularCreated.user) {
    throw new Error(`Could not create regular comparison user: ${regularErr?.message}`);
  }

  try {
    for (const userId of [targetCreated.user.id, regularCreated.user.id]) {
      const { error } = await admin.rpc('admin_approve_user', {
        p_user_id: userId,
        p_action: 'approve',
        p_executor_id: owner.id,
        p_target_role: 'viewer',
      });
      if (error) throw new Error(`Could not approve E2E user: ${error.message}`);
    }

    await signInFreshOwnerSession(page);

    // Owner opens Users Management: target user initially has no Delegated badge.
    const users = new UsersPage(page);
    await users.goto();
    await expect(users.userRow(targetEmail).getByTestId('delegated-user-badge')).toHaveCount(0);
    await expect(users.userRow(regularEmail).getByTestId('delegated-user-badge')).toHaveCount(0);

    // Owner grants a capability to the target user via the UI dialog.
    await users
      .userRow(targetEmail)
      .getByRole('button', { name: 'Manage delegations', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Manage individual delegations' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Capability').selectOption('users.approve');
    await dialog.getByLabel('No expiration date').check();
    await dialog.getByRole('button', { name: 'Grant capability', exact: true }).click();
    await expect(dialog.getByText('Capability granted successfully.')).toBeVisible();
    await dialog.locator('button', { hasText: 'Close' }).click();
    await expect(dialog).toBeHidden();

    // Navigate to Users Management and assert the Shield badge + tooltip on the delegated user.
    await users.goto();
    const badge = users.userRow(targetEmail).getByTestId('delegated-user-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toHaveText('Delegated');
    await expect(badge).toHaveAttribute(
      'title',
      'Delegated with extra capabilities: users.approve',
    );
    await expect(users.userRow(regularEmail).getByTestId('delegated-user-badge')).toHaveCount(0);

    // Click the Delegated filter tab and verify only delegated users remain visible.
    await users.delegationTab('delegated').click();
    await expect(users.delegationTab('delegated')).toHaveAttribute('aria-selected', 'true');
    await expect(users.userRow(targetEmail)).toBeVisible();
    await expect(users.userRow(regularEmail)).toHaveCount(0);
    await expect(users.userRow(owner.email)).toHaveCount(0);
  } finally {
    await admin.auth.admin.deleteUser(targetCreated.user.id);
    await admin.auth.admin.deleteUser(regularCreated.user.id);
  }
});

test('shows yellow Clock expiry badge and Arabic countdown tooltip when delegating with +3 days expiry', async ({
  page,
}) => {
  const { owner } = await readFixtures();
  const admin = await createLocalAdminClient();
  const targetEmail = `expiry-badge-${randomUUID()}@example.com`;

  const { data: targetCreated, error: targetErr } = await admin.auth.admin.createUser({
    email: targetEmail,
    password: `E2e-${randomUUID()}-Expiry!`,
    email_confirm: true,
    user_metadata: { full_name: 'Expiry badge viewer' },
  });
  if (targetErr || !targetCreated.user) {
    throw new Error(`Could not create expiry target user: ${targetErr?.message}`);
  }

  try {
    const { error } = await admin.rpc('admin_approve_user', {
      p_user_id: targetCreated.user.id,
      p_action: 'approve',
      p_executor_id: owner.id,
      p_target_role: 'viewer',
    });
    if (error) throw new Error(`Could not approve expiry E2E user: ${error.message}`);

    await signInFreshOwnerSession(page);

    // Delegate `users.approve` with expires_at = +3 days through the real UI dialog.
    const users = new UsersPage(page);
    await users.goto();
    await users
      .userRow(targetEmail)
      .getByRole('button', { name: 'Manage delegations', exact: true })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Manage individual delegations' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Capability').selectOption('users.approve');
    const threeDaysFromNow = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await dialog.locator('#delegation-expiry').fill(threeDaysFromNow);
    await dialog.getByRole('button', { name: 'Grant capability', exact: true }).click();
    await expect(dialog.getByText('Capability granted successfully.')).toBeVisible();
    await dialog.locator('button', { hasText: 'Close' }).click();
    await expect(dialog).toBeHidden();

    // Switch active UI locale to Arabic and verify Clock badge + "التفويض ينتهي خلال" tooltip.
    await page.evaluate(() => localStorage.setItem('admin-system:locale', 'ar'));
    await page.reload();

    const row = page.getByRole('row').filter({ hasText: targetEmail });
    await expect(row).toBeVisible();

    const expiryBadge = row.getByTestId('delegation-expiry-badge');
    await expect(expiryBadge).toBeVisible();
    await expect(expiryBadge).toHaveAttribute('data-expiry-tone', 'yellow');
    await expect(expiryBadge.locator('[data-icon="clock"]')).toBeVisible();

    await expiryBadge.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('التفويض ينتهي خلال');
    await expect(tooltip).toContainText('users.approve');
  } finally {
    await admin.auth.admin.deleteUser(targetCreated.user.id);
  }
});

test('revoking all roles auto-suspends the user and removes them from the All tab', async ({
  page,
}) => {
  const { owner } = await readFixtures();
  const admin = await createLocalAdminClient();
  const targetEmail = `auto-suspend-${randomUUID()}@example.com`;

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: targetEmail,
    password: `E2e-${randomUUID()}-Suspend!`,
    email_confirm: true,
    user_metadata: { full_name: 'Auto suspend target' },
  });
  if (createErr || !created.user) {
    throw new Error(`Could not create auto-suspend E2E user: ${createErr?.message}`);
  }

  try {
    const { error } = await admin.rpc('admin_approve_user', {
      p_user_id: created.user.id,
      p_action: 'approve',
      p_executor_id: owner.id,
      p_target_role: 'viewer',
    });
    if (error) throw new Error(`Could not approve auto-suspend user: ${error.message}`);

    await signInFreshOwnerSession(page);
    const users = new UsersPage(page);
    await users.goto();

    const row = users.userRow(targetEmail);
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Edit user roles', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: 'Edit user roles' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('checkbox', { name: 'Viewer' }).uncheck();
    await expect(dialog.getByTestId('last-role-warning')).toContainText(
      'Removing the last role will suspend the account until a new role is assigned.',
    );
    await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(dialog).toBeHidden();

    // Auto-suspended account disappears from All and has status='suspended' in DB.
    await expect(users.userRow(targetEmail)).toHaveCount(0);
    const { data: profile, error: profileErr } = await admin
      .from('profiles')
      .select('status')
      .eq('id', created.user.id)
      .single();
    if (profileErr || !profile) {
      throw new Error(`Could not verify auto-suspended profile: ${profileErr?.message}`);
    }
    expect(profile.status).toBe('suspended');
  } finally {
    await admin.auth.admin.deleteUser(created.user.id);
  }
});

test('approving one account and rejecting another hides the rejected user from All and shows them in Rejected', async ({
  page,
}) => {
  const admin = await createLocalAdminClient();
  const approvedEmail = `lifecycle-approved-${randomUUID()}@example.com`;
  const rejectedEmail = `lifecycle-rejected-${randomUUID()}@example.com`;

  const [{ data: approvedCreated, error: errA }, { data: rejectedCreated, error: errB }] =
    await Promise.all([
      admin.auth.admin.createUser({
        email: approvedEmail,
        password: `E2e-${randomUUID()}-Approved!`,
        email_confirm: true,
        user_metadata: { full_name: 'Lifecycle approved user' },
      }),
      admin.auth.admin.createUser({
        email: rejectedEmail,
        password: `E2e-${randomUUID()}-Rejected!`,
        email_confirm: true,
        user_metadata: { full_name: 'Lifecycle rejected user' },
      }),
    ]);
  if (errA || !approvedCreated.user || errB || !rejectedCreated.user) {
    throw new Error(`Could not seed lifecycle users: ${errA?.message ?? errB?.message}`);
  }

  try {
    await signInFreshOwnerSession(page);
    const users = new UsersPage(page);
    await users.goto();

    // Approve first user -> remains visible in All.
    await users.approve(approvedEmail);
    await expect(users.userRow(approvedEmail)).toBeVisible();

    // Reject second account -> disappears from All and appears in Rejected.
    const toRejectRow = users.userRow(rejectedEmail);
    await expect(toRejectRow).toBeVisible();
    await toRejectRow.getByRole('button', { name: 'Reject', exact: true }).click();

    await expect(users.userRow(rejectedEmail)).toHaveCount(0);
    await expect(users.userRow(approvedEmail)).toBeVisible();

    await users.tab('rejected').click();
    await expect(users.tab('rejected')).toHaveAttribute('aria-selected', 'true');
    await expect(users.userRow(rejectedEmail)).toBeVisible();
    await expect(users.userRow(approvedEmail)).toHaveCount(0);
  } finally {
    await admin.auth.admin.deleteUser(approvedCreated.user.id);
    await admin.auth.admin.deleteUser(rejectedCreated.user.id);
  }
});
