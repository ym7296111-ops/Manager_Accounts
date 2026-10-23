import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { createLocalAdminClient, readFixtures } from '../fixtures/data.ts';
import { DashboardPage } from '../pages/DashboardPage.ts';
import { UsersPage } from '../pages/UsersPage.ts';

test('opens the notification bell without crashing the page', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const dashboard = new DashboardPage(page);
  await dashboard.goto();
  await dashboard.openNotifications();

  const panel = page.getByRole('dialog', { name: 'Notifications' });
  await expect
    .poll(async () => {
      const emptyState = await panel.getByTestId('notification-empty').count();
      const notificationRows = await panel.locator('li').count();
      return emptyState + notificationRows;
    })
    .toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);
});

test('delivers a newly inserted notification to the live browser badge', async ({ page }) => {
  const pageErrors: string[] = [];
  let subscriptionAcknowledged = false;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/realtime/v1/websocket')) return;
    socket.on('framereceived', (payload) => {
      const frame =
        typeof payload.payload === 'string' ? payload.payload : payload.payload.toString('utf8');
      if (frame.includes('phx_reply') && frame.includes('"status":"ok"')) {
        subscriptionAcknowledged = true;
      }
    });
  });

  const dashboard = new DashboardPage(page);
  await dashboard.goto();
  await dashboard.openNotifications();
  await expect.poll(() => subscriptionAcknowledged, { timeout: 10_000 }).toBe(true);

  const { owner } = await readFixtures();
  const admin = await createLocalAdminClient();
  const { count, error: countError } = await admin
    .from('user_notifications')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', owner.id)
    .eq('is_read', false);
  if (countError) throw new Error(`Could not read the E2E unread count: ${countError.message}`);

  const { error: insertError } = await admin.from('user_notifications').insert({
    user_id: owner.id,
    type: 'user_approved',
    title_key: 'notifications.type.user_approved.title',
    body_key: 'notifications.type.user_approved.body',
    params: {},
    dedupe_key: `e2e-realtime-${randomUUID()}`,
  });
  if (insertError)
    throw new Error(`Could not insert the E2E Realtime notification: ${insertError.message}`);

  await expect(page.getByTestId('notification-badge')).toHaveText(String((count ?? 0) + 1), {
    timeout: 5_000,
  });
  expect(pageErrors).toEqual([]);
});

test('removes a notification live when it is deleted at the database', async ({ page }) => {
  const pageErrors: string[] = [];
  let subscriptionAcknowledged = false;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/realtime/v1/websocket')) return;
    socket.on('framereceived', (payload) => {
      const frame =
        typeof payload.payload === 'string' ? payload.payload : payload.payload.toString('utf8');
      if (frame.includes('phx_reply') && frame.includes('"status":"ok"')) {
        subscriptionAcknowledged = true;
      }
    });
  });

  const dashboard = new DashboardPage(page);
  await dashboard.goto();
  await dashboard.openNotifications();
  await expect.poll(() => subscriptionAcknowledged, { timeout: 10_000 }).toBe(true);

  const { owner } = await readFixtures();
  const admin = await createLocalAdminClient();
  const { data: inserted, error: insertError } = await admin
    .from('user_notifications')
    .insert({
      user_id: owner.id,
      type: 'user_approved',
      title_key: 'notifications.type.user_approved.title',
      body_key: 'notifications.type.user_approved.body',
      params: {},
      dedupe_key: `e2e-realtime-delete-${randomUUID()}`,
    })
    .select('id')
    .single();
  if (insertError || !inserted) {
    throw new Error(`Could not insert the E2E delete notification: ${insertError?.message}`);
  }

  try {
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    const row = panel.locator(`[data-notification-id="${inserted.id}"]`);
    /* INSERT lands in the open panel live (same subscription, event '*'). */
    await expect(row).toBeVisible();

    const { error: deleteError } = await admin
      .from('user_notifications')
      .delete()
      .eq('id', inserted.id);
    if (deleteError) {
      throw new Error(`Could not delete the E2E notification: ${deleteError.message}`);
    }

    /* The DELETE is just another invalidation signal: the open panel drops
       the row live, without a reload, well inside the polling window. */
    await expect(row).toHaveCount(0, { timeout: 3_000 });
    expect(pageErrors).toEqual([]);
  } finally {
    await admin.from('user_notifications').delete().eq('id', inserted.id);
  }
});

test('approval resolves the original owner notification in the open feed', async ({ page }) => {
  const { owner } = await readFixtures();
  const admin = await createLocalAdminClient();
  const email = `approval-resolve-${randomUUID()}@example.com`;
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password: `E2e-${randomUUID()}!`,
    email_confirm: true,
    user_metadata: { full_name: 'E2E approval lifecycle' },
  });
  if (createError || !created.user) {
    throw new Error(`Could not create E2E approval lifecycle fixture: ${createError?.message}`);
  }

  try {
    const { data: notification, error: notificationError } = await admin
      .from('user_notifications')
      .select('id, is_read, resolved_at')
      .eq('user_id', owner.id)
      .eq('type', 'user_approval_requested')
      .eq('related_id', created.user.id)
      .single();
    if (notificationError || !notification) {
      throw new Error(
        `Could not read the new approval notification: ${notificationError?.message}`,
      );
    }
    expect(notification.is_read).toBe(false);
    expect(notification.resolved_at).toBeNull();

    const users = new UsersPage(page);
    await users.goto();
    await users.approve(email);

    const { data: resolved, error: resolveError } = await admin
      .from('user_notifications')
      .select('is_read, resolved_at')
      .eq('id', notification.id)
      .single();
    if (resolveError || !resolved) {
      throw new Error(`Could not verify resolved approval notification: ${resolveError?.message}`);
    }
    expect(resolved.is_read).toBe(true);
    expect(resolved.resolved_at).not.toBeNull();

    await new DashboardPage(page).openNotifications();
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    const row = panel.locator(`[data-notification-id="${notification.id}"]`);

    /* Wait until the panel has settled (rows or the empty state) so the
       absence assertion below cannot pass against a still-loading feed. */
    await expect
      .poll(async () => {
        const emptyState = await panel.getByTestId('notification-empty').count();
        const notificationRows = await panel.locator('li').count();
        return emptyState + notificationRows;
      })
      .toBeGreaterThan(0);

    /* The active feed filters resolved rows out server-side
       (`is_read = false AND resolved_at IS NULL`): once the approval landed,
       the original owner notification belongs to history and must not render
       as an actionable item in the panel. */
    await expect(row).toHaveCount(0);

    /* The badge counts the same active predicate, so it must agree with the
       backend's unread-and-unresolved total. Other rows may still be active;
       the resolved one must not be among them. */
    const { count: activeCount, error: activeCountError } = await admin
      .from('user_notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', owner.id)
      .eq('is_read', false)
      .is('resolved_at', null);
    if (activeCountError) {
      throw new Error(`Could not read the active unread count: ${activeCountError.message}`);
    }
    const badge = page.getByTestId('notification-badge');
    if ((activeCount ?? 0) === 0) {
      await expect(badge).toHaveCount(0);
    } else {
      await expect(badge).toHaveText(String(activeCount));
    }
  } finally {
    await admin.from('user_notifications').delete().eq('related_id', created.user.id);
    await admin.auth.admin.deleteUser(created.user.id);
  }
});
