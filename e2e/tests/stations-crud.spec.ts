import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFixtures } from '../fixtures/data.ts';
import type { E2EDatabase } from '../fixtures/database.types.ts';

/**
 * Stations & Warehouses CRUD against the local Supabase stack.
 *
 * Runs as the signed-in owner (see `e2e/auth.setup.ts`), in English, over the
 * directory written by `supabase/seed.sql`: ST-01 with three warehouses, ST-02
 * with one, and ST-03 with none. Codes are never sent by the client — they are
 * minted server-side from `station_code_seq` / `warehouse_code_seq`, so the
 * assertions below also prove the sequences stay in step (the seed leaves them
 * at 3 and 4, hence ST-04 / WH-005).
 *
 * Every test restores the directory it started from, so the file is order
 * independent even though Playwright runs it serially.
 */

const STATION = 'محطة الاختبار الآلي';
const STATION_RENAMED = 'محطة مُعاد تسميتها';
const WAREHOUSE = 'مخزن الاختبار الآلي';
const WAREHOUSE_RENAMED = 'مخزن مُعاد تسميته';

async function openStationsTab(page: Page) {
  await page.goto('/settings/project');
  const main = page.getByRole('main');
  await expect(main.getByRole('tablist').getByRole('tab').first()).toHaveAttribute(
    'aria-selected',
    'true',
  );
  return main;
}

test.describe('stations & warehouses CRUD', () => {
  test('owner creates, renames, toggles and deletes a station', async ({ page }) => {
    const main = await openStationsTab(page);

    // ---- create: the form has a name field and no code field ----------------
    await main.getByRole('button', { name: 'Add station' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add station' })).toBeVisible();
    await dialog.getByLabel('Station name').fill(STATION);
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    const created = main.getByText(STATION);
    await expect(created).toBeVisible();
    // Minted server-side: the seed left station_code_seq at 3.
    await expect(main.getByText('ST-04')).toBeVisible();

    // ---- rename: the code is shown but never editable ----------------------
    await main.getByRole('button', { name: `Edit ${STATION}` }).click();
    const edit = page.getByRole('dialog');
    await expect(edit.getByRole('heading', { name: 'Edit station' })).toBeVisible();
    await expect(edit.getByLabel('Station name')).toHaveValue(STATION);
    await expect(edit.getByText('ST-04')).toBeVisible();
    // One text field only: name. The code is plain text.
    await expect(edit.locator('input')).toHaveCount(1);

    await edit.getByLabel('Station name').fill(STATION_RENAMED);
    await edit.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(main.getByText(STATION_RENAMED)).toBeVisible();
    await expect(main.getByText('ST-04')).toBeVisible();

    // ---- toggle is_active: the row stays, the affordance flips -------------
    await main.getByRole('button', { name: `Deactivate ${STATION_RENAMED}` }).click();
    await expect(main.getByRole('button', { name: `Activate ${STATION_RENAMED}` })).toBeVisible();
    await expect(main.getByText(STATION_RENAMED)).toBeVisible();

    await main.getByRole('button', { name: `Activate ${STATION_RENAMED}` }).click();
    await expect(main.getByRole('button', { name: `Deactivate ${STATION_RENAMED}` })).toBeVisible();

    // ---- delete: an empty station is removable, after confirmation ---------
    await main.getByRole('button', { name: `Delete ${STATION_RENAMED}` }).click();
    const confirm = page.getByRole('dialog');
    await expect(confirm.getByRole('heading', { name: 'Delete station' })).toBeVisible();
    await confirm.getByRole('button', { name: 'Confirm delete' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(main.getByText(STATION_RENAMED)).toHaveCount(0);
    await expect(main.getByText('ST-04')).toHaveCount(0);
  });

  test('owner adds, renames and deletes a warehouse under a station', async ({ page }) => {
    const main = await openStationsTab(page);

    /* `aria-expanded` selects the header toggle specifically: the row's Edit /
       Deactivate / Delete buttons carry the station name in their labels too. */
    await main.locator('button[aria-expanded]').filter({ hasText: 'محطة الصيانة' }).click();
    const panel = page.getByRole('region');
    await expect(panel.getByText('WH-004')).toBeVisible();

    await panel.getByRole('button', { name: 'Add warehouse' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Warehouse name').fill(WAREHOUSE);
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(main.getByText(WAREHOUSE)).toBeVisible();
    // The seed left warehouse_code_seq at 4.
    await expect(main.getByText('WH-005')).toBeVisible();

    await main.getByRole('button', { name: `Edit ${WAREHOUSE}` }).click();
    const edit = page.getByRole('dialog');
    await expect(edit.getByRole('heading', { name: 'Edit warehouse' })).toBeVisible();
    await expect(edit.getByText('WH-005')).toBeVisible();
    await edit.getByLabel('Warehouse name').fill(WAREHOUSE_RENAMED);
    await edit.getByRole('button', { name: 'Save' }).click();

    await expect(main.getByText(WAREHOUSE_RENAMED)).toBeVisible();

    await main.getByRole('button', { name: `Delete ${WAREHOUSE_RENAMED}` }).click();
    await page.getByRole('button', { name: 'Confirm delete' }).click();

    await expect(main.getByText(WAREHOUSE_RENAMED)).toHaveCount(0);
    await expect(main.getByText('WH-005')).toHaveCount(0);
  });

  test('refuses a name shorter than two characters before any request', async ({ page }) => {
    const main = await openStationsTab(page);

    await main.getByRole('button', { name: 'Add station' }).click();
    const dialog = page.getByRole('dialog');

    await dialog.getByLabel('Station name').fill('م');
    await dialog.getByRole('button', { name: 'Save' }).click();

    await expect(dialog.getByRole('alert')).toHaveText('The name must be at least two characters.');
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Station name').fill('   ');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('A name is required.');

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('offers delete only for a station without warehouses', async ({ page }) => {
    const main = await openStationsTab(page);

    // ST-01 holds three seeded warehouses: no delete affordance at all.
    await expect(main.getByRole('button', { name: 'Delete المحطة الرئيسية' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Edit المحطة الرئيسية' })).toBeVisible();

    // ST-03 is seeded empty, so it can be deleted (but is not, here).
    await expect(main.getByRole('button', { name: 'Delete محطة الوقود الشمالية' })).toBeVisible();
  });
});

test.describe('stations & warehouses authorization', () => {
  test('an ordinary admin without project.settings:manage is refused 42501 on every write', async ({
    page,
  }) => {
    const { admin, supabaseUrl, anonKey } = await readFixtures();
    const client = createClient<E2EDatabase>(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: signInError } = await client.auth.signInWithPassword({
      email: admin.email,
      password: admin.password,
    });
    expect(signInError).toBeNull();

    const { data: canManage } = await client.rpc('can_manage_project_settings');
    expect(canManage).toBe(false);

    // Read is refused too: RLS filters the rows away rather than erroring.
    const { data: visible, error: readError } = await client.from('stations').select('id, code');
    expect(readError).toBeNull();
    expect(visible).toEqual([]);

    const { error: insertStation } = await client
      .from('stations')
      .insert({ name: 'محطة ممنوعة' })
      .select('id');
    expect(insertStation?.code).toBe('42501');

    const { error: insertWarehouse } = await client
      .from('warehouses')
      .insert({ station_id: '00000000-0000-4000-8000-000000000001', name: 'مخزن ممنوع' })
      .select('id');
    expect(insertWarehouse?.code).toBe('42501');

    /* Under RLS an UPDATE/DELETE the caller cannot see raises no error: the
       USING clause simply matches zero rows. Asserting the affected-row count
       is what actually proves nothing was changed. */
    const { data: updated, error: updateStation } = await client
      .from('stations')
      .update({ is_active: false })
      .eq('code', 'ST-01')
      .select('id, is_active');
    expect(updateStation).toBeNull();
    expect(updated).toEqual([]);

    const { data: deleted, error: deleteStation } = await client
      .from('stations')
      .delete()
      .eq('code', 'ST-01')
      .select('id');
    expect(deleteStation).toBeNull();
    expect(deleted).toEqual([]);

    // The seeded station is untouched, which is the point of the two checks
    // above: silence from PostgREST must not be mistaken for a successful write.
    const admin2 = createClient<E2EDatabase>(
      supabaseUrl,
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? anonKey,
      {
        auth: { persistSession: false, autoRefreshToken: false },
      },
    );
    const { data: untouched } = await admin2
      .from('stations')
      .select('is_active')
      .eq('code', 'ST-01')
      .single();
    expect(untouched?.is_active).toBe(true);

    await page.goto('/settings/project');
  });
});
