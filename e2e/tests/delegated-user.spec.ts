import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { createLocalAdminClient, readFixtures } from '../fixtures/data.ts';
import { DashboardPage } from '../pages/DashboardPage.ts';
import { LoginPage } from '../pages/LoginPage.ts';

async function signInAsDelegate(page: Page): Promise<void> {
  const { delegate } = await readFixtures();
  await page.goto('/login');
  await page.evaluate(() => localStorage.removeItem('admin-system:auth'));
  await page.reload();
  const login = new LoginPage(page);
  await login.signIn(delegate.email, delegate.password);
  await login.expectSignedIn();
}

async function createPendingApplicant(): Promise<{ id: string; email: string }> {
  const admin = await createLocalAdminClient();
  const email = `delegated-applicant-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: `E2e-${randomUUID()}-Applicant!`,
    email_confirm: true,
    user_metadata: { full_name: 'Delegated applicant' },
  });
  if (error || !data.user) throw new Error(`Could not create pending applicant: ${error?.message}`);
  return { id: data.user.id, email };
}

async function createResetRequest(email: string): Promise<string> {
  const admin = await createLocalAdminClient();
  const { data, error } = await admin
    .from('password_reset_requests')
    .insert({ email, status: 'pending_approval' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Could not create reset request: ${error?.message}`);
  return data.id;
}

test('delegated approver sees a pending queue without the full user directory', async ({
  page,
}) => {
  const applicant = await createPendingApplicant();
  await signInAsDelegate(page);
  await page.goto('/settings/system/users');

  const row = page.getByRole('row').filter({ hasText: applicant.email });
  await expect(row).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add user', exact: true })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
});

test('delegated approval grants viewer without a role-selection dialog', async ({ page }) => {
  const applicant = await createPendingApplicant();
  const admin = await createLocalAdminClient();
  await signInAsDelegate(page);
  await page.goto('/settings/system/users');
  const row = page.getByRole('row').filter({ hasText: applicant.email });
  await row.getByRole('button', { name: 'Approve', exact: true }).click();

  await expect(page.getByRole('dialog', { name: 'Confirm approval and grant role' })).toHaveCount(
    0,
  );
  await expect(page.getByText('was approved and granted')).toBeVisible();

  const { data: assignment, error: assignmentError } = await admin
    .from('user_roles')
    .select('role_id')
    .eq('user_id', applicant.id)
    .single();
  if (assignmentError || !assignment)
    throw new Error(`Could not verify delegated approval: ${assignmentError?.message}`);
  const { data: role, error: roleError } = await admin
    .from('roles')
    .select('slug')
    .eq('id', assignment.role_id)
    .single();
  if (roleError || !role) throw new Error(`Could not read approved role: ${roleError?.message}`);
  expect(role.slug).toBe('viewer');
});

test('delegated approver cannot invite, suspend, reset passwords or manage roles', async ({
  page,
}) => {
  const applicant = await createPendingApplicant();
  await signInAsDelegate(page);
  await page.goto('/settings/system/users');
  const row = page.getByRole('row').filter({ hasText: applicant.email });

  await expect(page.getByRole('button', { name: 'Add user', exact: true })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Suspend', exact: true })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Reset password', exact: true })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Edit user roles', exact: true })).toHaveCount(0);
  await expect(row.getByRole('button', { name: 'Manage delegations', exact: true })).toHaveCount(0);
});

test('password-reset delegate reads the safe queue and can initiate an approval', async ({
  page,
}) => {
  const email = `delegated-reset-${randomUUID()}@example.com`;
  await createResetRequest(email);
  await signInAsDelegate(page);
  await page.goto('/settings/system/password-resets');

  const row = page.getByRole('row').filter({ hasText: email });
  await expect(row).toBeVisible();
  await expect(row.getByRole('button', { name: 'Approve', exact: true })).toBeVisible();
  await row.getByRole('button', { name: 'Approve', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm the action' });
  /* Approval generates the password: no manual password fields. */
  await expect(dialog.getByLabel('New password', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Confirm new password', { exact: true })).toHaveCount(0);
  await expect(dialog).toContainText('A new password will be generated');
});

test('password-reset delegate rejects a request without receiving a password', async ({ page }) => {
  const email = `delegated-reset-reject-${randomUUID()}@example.com`;
  const requestId = await createResetRequest(email);
  const admin = await createLocalAdminClient();
  await signInAsDelegate(page);
  await page.goto('/settings/system/password-resets');

  const row = page.getByRole('row').filter({ hasText: email });
  await row.getByRole('button', { name: 'Reject', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm the action' });
  await expect(dialog.getByLabel('New password', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Reject request', exact: true }).click();
  await expect(page.getByText('The request from ' + email + ' was rejected.')).toBeVisible();

  const { data, error } = await admin
    .from('password_reset_requests')
    .select('status')
    .eq('id', requestId)
    .single();
  if (error || !data) throw new Error(`Could not verify reset rejection: ${error?.message}`);
  expect(data.status).toBe('rejected');
});

test('password-reset delegate applies a generated password through GoTrue', async ({ page }) => {
  const { owner } = await readFixtures();
  const admin = await createLocalAdminClient();
  const email = `delegated-reset-approved-${randomUUID()}@example.com`;
  const initialPassword = `E2e-${randomUUID()}-Initial!`;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: initialPassword,
    email_confirm: true,
    user_metadata: { full_name: 'Password reset target' },
  });
  if (createError || !created.user)
    throw new Error(`Could not create reset target: ${createError?.message}`);
  const { error: approveError } = await admin.rpc('admin_approve_user', {
    p_user_id: created.user.id,
    p_action: 'approve',
    p_executor_id: owner.id,
    p_target_role: 'viewer',
  });
  if (approveError) throw new Error(`Could not approve reset target: ${approveError.message}`);
  const requestId = await createResetRequest(email);

  await signInAsDelegate(page);
  await page.goto('/settings/system/password-resets');
  const row = page.getByRole('row').filter({ hasText: email });
  await row.getByRole('button', { name: 'Approve', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm the action' });
  await dialog.getByRole('button', { name: 'Approve & update password', exact: true }).click();
  await expect(page.getByText('Approved. Copy the password now.')).toBeVisible();
  const reveal = page.getByRole('dialog', { name: 'Temporary password' });
  await expect(reveal).toBeVisible();
  const newPassword = (await reveal.locator('output').innerText()).trim();
  expect(newPassword.length).toBeGreaterThan(8);
  await reveal.getByRole('button', { name: 'Close', exact: true }).click();

  const { data, error } = await admin
    .from('password_reset_requests')
    .select('status')
    .eq('id', requestId)
    .single();
  if (error || !data) throw new Error(`Could not verify reset approval: ${error?.message}`);
  expect(data.status).toBe('approved');

  await new DashboardPage(page).signOut();
  const login = new LoginPage(page);
  await login.signIn(email, newPassword);
  await login.expectSignedIn();
});
