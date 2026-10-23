import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createLocalAdminClient, readFixtures } from '../fixtures/data.ts';
import { DashboardPage } from '../pages/DashboardPage.ts';
import { LoginPage } from '../pages/LoginPage.ts';
import { UsersPage } from '../pages/UsersPage.ts';

/* The password-reset queue tests sign the owner in fresh (mirroring
   signInAsDelegate / signInFreshOwnerSession in the sibling specs) instead of
   relying on the shared storageState session. */
async function signInAsOwner(page: Page): Promise<void> {
  const { owner } = await readFixtures();
  await page.goto('/login');
  await page.evaluate(() => localStorage.removeItem('admin-system:auth'));
  await page.reload();
  const login = new LoginPage(page);
  await login.signIn(owner.email, owner.password);
  await login.expectSignedIn();
}

test('admin resets another user password and the new password works at login', async ({ page }) => {
  const { approved } = await readFixtures();
  const users = new UsersPage(page);
  await users.goto();

  const row = users.userRow(approved.email);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Reset password', exact: true }).click();

  const confirmDialog = page.getByRole('dialog', { name: 'Reset password' });
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: 'Set new password', exact: true }).click();

  const reveal = page.getByRole('dialog', { name: 'Temporary password' });
  await expect(reveal).toBeVisible();
  const newPassword = (await reveal.locator('output').innerText()).trim();
  expect(newPassword.length).toBeGreaterThan(8);
  await reveal.getByRole('button', { name: 'Close', exact: true }).click();

  await new DashboardPage(page).signOut();
  const login = new LoginPage(page);
  await login.goto();
  await login.signIn(approved.email, newPassword);
  await login.expectSignedIn();
  await expect(page).toHaveURL(/\/$/);
});

test('manual reset request notifies owner and delegate, owner approves, revealed password signs in', async ({
  page,
}) => {
  const { owner, delegate } = await readFixtures();
  const admin = await createLocalAdminClient();
  const email = `manual-reset-${randomUUID()}@example.com`;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: `E2e-Init-${randomUUID().slice(0, 8)}!`,
    email_confirm: true,
    user_metadata: { full_name: 'Manual reset target' },
  });
  if (createError || !created.user) {
    throw new Error(`Could not create manual reset target: ${createError?.message}`);
  }
  const { error: approveError } = await admin.rpc('admin_approve_user', {
    p_user_id: created.user.id,
    p_action: 'approve',
    p_executor_id: owner.id,
    p_target_role: 'viewer',
  });
  if (approveError)
    throw new Error(`Could not approve manual reset target: ${approveError.message}`);

  try {
    const { data: request, error: requestError } = await admin
      .from('password_reset_requests')
      .insert({ email, status: 'pending_approval' })
      .select('id')
      .single();
    if (requestError || !request) {
      throw new Error(`Could not create reset request: ${requestError?.message}`);
    }
    /* The notification must reach every password_reset.manage holder. */
    const { data: notices, error: noticeError } = await admin
      .from('user_notifications')
      .select('user_id')
      .eq('type', 'password_reset_requested')
      .eq('related_id', request.id);
    if (noticeError) throw new Error(`Could not read notifications: ${noticeError.message}`);
    const recipients = (notices ?? []).map((n) => n.user_id);
    expect(recipients).toContain(owner.id);
    expect(recipients).toContain(delegate.id);

    await signInAsOwner(page);
    await page.goto('/settings/system/password-resets');
    const row = page.getByRole('row').filter({ hasText: email });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Approve', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm the action' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#reset-new-password')).toHaveCount(0);
    await expect(dialog.locator('#reset-confirm-password')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Approve & update password', exact: true }).click();
    await expect(page.getByText('Approved. Copy the password now.')).toBeVisible();

    const reveal = page.getByRole('dialog', { name: 'Temporary password' });
    await expect(reveal).toBeVisible();
    const newPassword = (await reveal.locator('output').innerText()).trim();
    expect(newPassword.length).toBeGreaterThan(8);
    await expect(reveal.getByRole('button', { name: 'Copy password' })).toBeVisible();
    await reveal.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(reveal).toBeHidden();

    /* The request itself must have landed in its terminal approved state. */
    await expect
      .poll(async () => {
        const { data } = await admin
          .from('password_reset_requests')
          .select('status')
          .eq('id', request.id)
          .single();
        return data?.status;
      })
      .toBe('approved');

    await new DashboardPage(page).signOut();
    const login = new LoginPage(page);
    await login.goto();
    await login.signIn(email, newPassword);
    await login.expectSignedIn();
  } finally {
    await admin.auth.admin.deleteUser(created.user.id);
  }
});

test('approving a reset request for the original owner is refused and stays pending', async ({
  page,
}) => {
  const { owner } = await readFixtures();
  const admin = await createLocalAdminClient();
  const { data: request, error } = await admin
    .from('password_reset_requests')
    .insert({ email: owner.email, status: 'pending_approval' })
    .select('id')
    .single();
  if (error || !request) throw new Error(`Could not create owner reset request: ${error?.message}`);
  try {
    await signInAsOwner(page);
    await page.goto('/settings/system/password-resets');
    const row = page.getByRole('row').filter({ hasText: owner.email });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Approve', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm the action' });
    await dialog.getByRole('button', { name: 'Approve & update password', exact: true }).click();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Temporary password' })).toHaveCount(0);
    const { data } = await admin
      .from('password_reset_requests')
      .select('status')
      .eq('id', request.id)
      .single();
    expect(data?.status).toBe('pending_approval');
  } finally {
    await admin.from('password_reset_requests').delete().eq('id', request.id);
  }
});

test('rejecting a reset request shows no password reveal', async ({ page }) => {
  const email = `manual-reset-reject-${randomUUID()}@example.com`;
  const admin = await createLocalAdminClient();
  const { data: request, error } = await admin
    .from('password_reset_requests')
    .insert({ email, status: 'pending_approval' })
    .select('id')
    .single();
  if (error || !request) throw new Error(`Could not create reset request: ${error?.message}`);
  try {
    await signInAsOwner(page);
    await page.goto('/settings/system/password-resets');
    const row = page.getByRole('row').filter({ hasText: email });
    await expect(row).toBeVisible();
    await row.getByRole('button', { name: 'Reject', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Confirm the action' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel('New password', { exact: true })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Reject request', exact: true }).click();
    /* Server state first: the rejection must actually be recorded. */
    await expect
      .poll(async () => {
        const { data } = await admin
          .from('password_reset_requests')
          .select('status')
          .eq('id', request.id)
          .single();
        return data?.status;
      })
      .toBe('rejected');
    await expect(page.getByText(`The request from ${email} was rejected.`)).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Temporary password' })).toHaveCount(0);
  } finally {
    await admin.from('password_reset_requests').delete().eq('id', request.id);
  }
});

test('self-service /profile opens ChangePasswordDialog, updates password, shows toast, and closes dialog', async ({
  page,
}) => {
  const { owner } = await readFixtures();
  const admin = await createLocalAdminClient();
  const email = `profile-pwd-${randomUUID()}@example.com`;
  const initialPassword = `E2e-Init-${randomUUID().slice(0, 8)}!`;
  const updatedPassword = `E2e-Updated-${randomUUID().slice(0, 8)}!`;

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: initialPassword,
    email_confirm: true,
    user_metadata: { full_name: 'Self-service password user' },
  });
  if (createError || !created.user) {
    throw new Error(`Could not create disposable user: ${createError?.message}`);
  }
  const { error: approveError } = await admin.rpc('admin_approve_user', {
    p_user_id: created.user.id,
    p_action: 'approve',
    p_executor_id: owner.id,
    p_target_role: 'viewer',
  });
  if (approveError) {
    throw new Error(`Could not approve disposable user: ${approveError.message}`);
  }

  try {
    await page.goto('/login');
    await page.evaluate(() => {
      localStorage.removeItem('admin-system:auth');
      localStorage.setItem('admin-system:locale', 'en');
    });
    await page.reload();

    const login = new LoginPage(page);
    await login.signIn(email, initialPassword);
    await login.expectSignedIn();
    await expect(page).toHaveURL(/\/$/);

    await page.goto('/profile');
    await expect(page.locator('#profile-new-password')).toHaveCount(0);

    await page.getByTestId('open-change-password-dialog').click();
    const dialog = page.getByRole('dialog', { name: 'Change password' });
    await expect(dialog).toBeVisible();

    await dialog.locator('#profile-current-password').fill(initialPassword);
    await dialog.locator('#profile-new-password').fill(updatedPassword);
    await dialog.locator('#profile-confirm-password').fill(updatedPassword);
    await dialog.getByRole('button', { name: 'Update', exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('password-change-toast')).toContainText(
      'Password changed successfully',
    );

    await new DashboardPage(page).signOut();
    await login.signIn(email, updatedPassword);
    await login.expectSignedIn();
    await expect(page).toHaveURL(/\/$/);
  } finally {
    await admin.auth.admin.deleteUser(created.user.id);
  }
});
