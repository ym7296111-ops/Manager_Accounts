import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { createLocalAdminClient, readFixtures } from '../fixtures/data.ts';
import type { E2EDatabase } from '../fixtures/database.types.ts';

const YEAR_NAME = '2035-2036';
const START_DATE = '2035-07-01';
const END_DATE = '2036-06-30';

async function cleanFiscalYear() {
  const admin = await createLocalAdminClient();
  const { data: years, error: readError } = await admin
    .from('fiscal_years')
    .select('id')
    .eq('name', YEAR_NAME);
  if (readError) throw new Error(`Could not find the E2E fiscal year: ${readError.message}`);

  for (const year of years ?? []) {
    const { error: balanceError } = await admin
      .from('opening_balances')
      .delete()
      .eq('fiscal_year_id', year.id);
    if (balanceError) {
      throw new Error(`Could not clean E2E opening balances: ${balanceError.message}`);
    }
  }

  const { error: deleteError } = await admin.from('fiscal_years').delete().eq('name', YEAR_NAME);
  if (deleteError) throw new Error(`Could not clean the E2E fiscal year: ${deleteError.message}`);
}

/** Create the year directly so the balance scenarios skip the annual-settings flow. */
async function seedActiveYear() {
  const admin = await createLocalAdminClient();
  const { data, error } = await admin
    .from('fiscal_years')
    .insert({ start_date: START_DATE, end_date: END_DATE, is_active: true })
    .select('id, name')
    .single();
  if (error) throw new Error(`Could not seed the E2E fiscal year: ${error.message}`);
  if (data === null) throw new Error('Seeding the E2E fiscal year returned no row.');
  return data;
}

async function openOpeningBalances(page: Page) {
  await page.goto('/settings/project');
  const main = page.getByRole('main');
  await main.getByRole('tab', { name: 'General', exact: true }).click();
  await main
    .getByRole('tablist', { name: 'Fiscal settings' })
    .getByRole('tab', { name: 'Opening balances' })
    .click();
  return main;
}

async function expandStation(page: Page, name: string) {
  const toggle = page
    .getByRole('main')
    .locator('button[aria-controls^="opening-station-panel-"]')
    .filter({ hasText: name });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}

async function expandWarehouse(page: Page, name: string) {
  const toggle = page
    .getByRole('main')
    .locator('button[aria-controls^="opening-warehouse-panel-"]')
    .filter({ hasText: name });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const panelId = await toggle.getAttribute('aria-controls');
  return page.locator(`#${panelId}`);
}

test.afterEach(async () => {
  await cleanFiscalYear();
});

/* E1–E8 live in the second test below; this one keeps the year/period flow and
   the write permission probe that already existed, without the old flat form. */
test('owner creates a fiscal year, changes its period and checks write permissions', async ({
  page,
}) => {
  await cleanFiscalYear();
  const admin = await createLocalAdminClient();
  const fixtures = await readFixtures();

  await page.goto('/settings/project');
  const main = page.getByRole('main');
  await main.getByRole('tab', { name: 'General', exact: true }).click();
  const fiscalTabs = main.getByRole('tablist', { name: 'Fiscal settings' });
  await fiscalTabs.getByRole('tab', { name: 'Annual settings' }).click();

  await main.getByRole('button', { name: 'Add fiscal year' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Start date').fill(START_DATE);
  await dialog.getByLabel('End date').fill(END_DATE);
  await expect(dialog.getByText('Name to be generated: 2035-2036')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save fiscal year' }).click();

  const yearRow = main.getByRole('row').filter({ hasText: YEAR_NAME }).first();
  await expect(yearRow).toBeVisible();
  await yearRow.getByRole('button', { name: `Activate ${YEAR_NAME}` }).click();
  await expect(yearRow.getByText('Current', { exact: true })).toBeVisible();

  // Creation expands the new year automatically so its generated months are immediately visible.
  const monthRows = main.getByTestId('fiscal-month-row');
  await expect(monthRows).toHaveCount(12);
  await expect(monthRows.first()).toContainText('July 2035');

  const { data: year, error: yearError } = await admin
    .from('fiscal_years')
    .select('id')
    .eq('name', YEAR_NAME)
    .single();
  expect(yearError).toBeNull();
  expect(year).not.toBeNull();

  await fiscalTabs.getByRole('tab', { name: 'Period settings' }).click();
  await expect(
    main.getByText('We are now in period 1 of July 2035.', { exact: true }),
  ).toBeVisible();
  await main.getByLabel('Current period').fill('3');
  await main.getByRole('button', { name: 'Save period' }).click();
  await expect(
    main.getByText('We are now in period 3 of July 2035.', { exact: true }),
  ).toBeVisible();

  const { data: firstMonth, error: monthError } = await admin
    .from('fiscal_months')
    .select('id, current_period')
    .eq('fiscal_year_id', year!.id)
    .eq('month_number', 1)
    .single();
  expect(monthError).toBeNull();
  expect(firstMonth?.current_period).toBe(3);

  // The owner succeeds, while an authenticated ordinary admin without
  // project.settings:manage cannot change current_period through PostgREST.
  const ordinaryAdmin = createClient<E2EDatabase>(fixtures.supabaseUrl, fixtures.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await ordinaryAdmin.auth.signInWithPassword({
    email: fixtures.admin.email,
    password: fixtures.admin.password,
  });
  expect(signInError).toBeNull();
  const { data: canManage, error: permissionError } = await ordinaryAdmin.rpc(
    'can_manage_project_settings',
  );
  expect(permissionError).toBeNull();
  expect(canManage).toBe(false);

  const { data: unauthorizedRows, error: unauthorizedError } = await ordinaryAdmin
    .from('fiscal_months')
    .update({ current_period: 9 })
    .eq('id', firstMonth!.id)
    .select('id, current_period');
  expect(unauthorizedError).toBeNull();
  expect(unauthorizedRows).toEqual([]);
  await ordinaryAdmin.auth.signOut();
});

/*
 * The sparse opening-balance editor (design study §9.2).
 *
 * E1  expanding a station and warehouse shows the empty state and no fields
 * E2  the picker searches Arabic, adds two rows, and both rows reach the DB
 * E3  a reload shows exactly the two saved rows
 * E4  deleting a row removes it from the database
 * E5  the delete is audited with the right entity_id and old_amount
 * E6  editing an existing row appends one updated audit row, never a duplicate
 * E7  parent and inactive classifications are never offered by the picker
 * E8  a balance whose classification gained children moves to «needs review»,
 *     stays read-only, and stays inside the station total
 */
test('owner enters sparse opening balances: picker, save, reload, delete and review', async ({
  page,
}) => {
  await cleanFiscalYear();
  const admin = await createLocalAdminClient();
  const fixtures = await readFixtures();
  const year = await seedActiveYear();

  const { data: warehouse, error: warehouseError } = await admin
    .from('warehouses')
    .select('id')
    .eq('name', 'مخزن المواد الخام')
    .single();
  expect(warehouseError).toBeNull();
  const { data: steel, error: steelError } = await admin
    .from('classifications')
    .select('id')
    .eq('name', 'حديد وصلب')
    .single();
  expect(steelError).toBeNull();

  const main = await openOpeningBalances(page);
  await expect(
    main.getByRole('heading', { name: 'Opening balances' }),
    'The active year should be picked up from the yearly settings tab.',
  ).toBeVisible();

  // E1 — nothing is mounted until the operator drills down.
  await expandStation(page, 'المحطة الرئيسية');
  const panel = await expandWarehouse(page, 'مخزن المواد الخام');
  await expect(
    panel.getByText('No balances recorded for this warehouse yet. Add a classification to start.'),
  ).toBeVisible();
  await expect(panel.getByRole('spinbutton')).toHaveCount(0);
  await expect(
    panel.getByText('0 of 6 classifications entered'),
    'The counter starts at zero against the active leaf count.',
  ).toBeVisible();

  // E7 — the picker only ever lists active leaves.
  await panel.getByRole('button', { name: 'Add classification' }).click();
  const picker = panel.getByTestId('classification-picker');
  await expect(picker).toBeVisible();
  await expect(
    picker.getByRole('option', { name: /المواد الخام/ }),
    'A parent classification must never be offered.',
  ).toHaveCount(0);
  await expect(
    picker.getByRole('option', { name: /بلاستيك ومطاط/ }),
    'An inactive leaf classification must never be offered.',
  ).toHaveCount(0);

  // E2 — Arabic search folds the hamza, then two rows go in one commit.
  const search = picker.getByRole('combobox');
  await search.fill('اخشاب');
  await expect(
    picker.getByRole('option', { name: /أخشاب/ }),
    'Typing اخشاب must find أخشاب.',
  ).toHaveCount(1);
  await expect(picker.getByRole('option')).toHaveCount(1);
  await search.fill('');
  await picker.getByRole('option', { name: /حديد وصلب/ }).click();
  await picker.getByRole('option', { name: /أخشاب/ }).click();
  await picker.getByRole('button', { name: 'Add (2)' }).click();
  await expect(panel.getByRole('status').filter({ hasText: '2 row(s) added.' })).toBeAttached();

  const steelBalance = panel.getByRole('spinbutton', { name: 'Opening balance: حديد وصلب' });
  const woodBalance = panel.getByRole('spinbutton', { name: 'Opening balance: أخشاب' });
  await expect(steelBalance).toBeVisible();
  await expect(woodBalance).toBeVisible();
  await expect(steelBalance, 'Focus should land on the first added amount.').toBeFocused();
  await expect(
    panel.getByText('2 of 6 classifications entered'),
    'Added rows count towards the per-warehouse counter.',
  ).toBeVisible();

  await steelBalance.fill('125.50');
  await woodBalance.fill('300.25');
  await panel.getByRole('button', { name: 'Save balances for مخزن المواد الخام' }).click();
  await expect(
    panel.getByRole('status').filter({ hasText: 'Warehouse balances saved successfully.' }),
  ).toBeVisible();
  await expect(steelBalance).toHaveValue('125.50');

  const { data: savedRows, error: savedRowsError } = await admin
    .from('opening_balances')
    .select('classification_id, amount')
    .eq('fiscal_year_id', year.id)
    .eq('warehouse_id', warehouse!.id)
    .order('amount', { ascending: true });
  expect(savedRowsError).toBeNull();
  expect(savedRows).toEqual([
    { classification_id: steel!.id, amount: 125.5 },
    { classification_id: expect.any(String), amount: 300.25 },
  ]);

  // E6 — editing a saved row updates the same balance and appends one audit row.
  await steelBalance.fill('130.00');
  await panel.getByRole('button', { name: 'Save balances for مخزن المواد الخام' }).click();
  await expect(
    panel.getByRole('status').filter({ hasText: 'Warehouse balances saved successfully.' }),
  ).toBeVisible();

  const { data: steelBalanceRow, error: steelBalanceError } = await admin
    .from('opening_balances')
    .select('id, amount')
    .eq('fiscal_year_id', year.id)
    .eq('warehouse_id', warehouse!.id)
    .eq('classification_id', steel!.id)
    .single();
  expect(steelBalanceError).toBeNull();
  expect(steelBalanceRow?.amount).toBe(130);

  const { data: steelAudit, error: steelAuditError } = await admin
    .from('audit_logs')
    .select('action, entity_id, actor_id, metadata')
    .eq('entity', 'opening_balances')
    .eq('entity_id', steelBalanceRow!.id)
    .order('id', { ascending: true });
  expect(steelAuditError).toBeNull();
  expect(steelAudit).toHaveLength(2);
  expect(steelAudit?.[0]).toMatchObject({
    action: 'opening_balance.updated',
    actor_id: fixtures.owner.id,
    metadata: {
      fiscal_year_id: year.id,
      warehouse_id: warehouse!.id,
      classification_id: steel!.id,
      old_amount: null,
      new_amount: 125.5,
    },
  });
  expect(steelAudit?.[1]).toMatchObject({
    action: 'opening_balance.updated',
    actor_id: fixtures.owner.id,
    metadata: { old_amount: 125.5, new_amount: 130 },
  });

  // E3 — after a reload only the two rows exist, still without a field per leaf.
  await page.reload();
  const reloadedMain = await openOpeningBalances(page);
  await expandStation(page, 'المحطة الرئيسية');
  const reloadedPanel = await expandWarehouse(page, 'مخزن المواد الخام');
  await expect(reloadedPanel.getByRole('spinbutton')).toHaveCount(2);
  await expect(
    reloadedPanel.getByRole('spinbutton', { name: 'Opening balance: حديد وصلب' }),
  ).toHaveValue('130.00');
  await expect(reloadedMain.getByText('430.25', { exact: true })).toHaveCount(2);

  // E4/E5 — deleting a saved row removes it and leaves an audit trail.
  await reloadedPanel.getByRole('button', { name: 'Delete balance حديد وصلب' }).click();
  const deleteDialog = page.getByRole('dialog');
  await expect(deleteDialog).toContainText('130.00');
  await expect(deleteDialog).toContainText('مخزن المواد الخام');
  await deleteDialog.getByRole('button', { name: 'Delete balance' }).click();
  await expect(
    reloadedMain.getByRole('status').filter({ hasText: 'The balance was deleted.' }),
  ).toBeVisible();
  await expect(
    reloadedPanel.getByRole('spinbutton', { name: 'Opening balance: حديد وصلب' }),
  ).toHaveCount(0);

  const { data: afterDelete, error: afterDeleteError } = await admin
    .from('opening_balances')
    .select('classification_id')
    .eq('fiscal_year_id', year.id)
    .eq('warehouse_id', warehouse!.id);
  expect(afterDeleteError).toBeNull();
  expect(afterDelete).toHaveLength(1);
  expect(afterDelete?.[0]?.classification_id).not.toBe(steel!.id);

  const { data: deleteAudit, error: deleteAuditError } = await admin
    .from('audit_logs')
    .select('action, entity_id, actor_id, metadata')
    .eq('action', 'opening_balance.deleted')
    .eq('entity', 'opening_balances')
    .eq('entity_id', steelBalanceRow!.id);
  expect(deleteAuditError).toBeNull();
  expect(deleteAudit).toHaveLength(1);
  expect(deleteAudit?.[0]).toMatchObject({
    actor_id: fixtures.owner.id,
    entity_id: steelBalanceRow!.id,
    metadata: {
      fiscal_year_id: year.id,
      warehouse_id: warehouse!.id,
      classification_id: steel!.id,
      old_amount: 130,
      new_amount: null,
    },
  });

  // E8 — a balance whose classification stopped being a leaf moves to review,
  // stays read-only, and keeps counting inside the warehouse total.
  const parentName = `مراجعة ${Date.now()}`;
  const { data: reviewParent, error: reviewParentError } = await admin
    .from('classifications')
    .insert({ name: parentName })
    .select('id, code')
    .single();
  expect(reviewParentError).toBeNull();
  const { error: reviewBalanceError } = await admin.from('opening_balances').insert({
    fiscal_year_id: year.id,
    warehouse_id: warehouse!.id,
    classification_id: reviewParent!.id,
    amount: 50,
  });
  expect(reviewBalanceError).toBeNull();
  const { error: childError } = await admin
    .from('classifications')
    .insert({ name: `${parentName} فرعي`, parent_id: reviewParent!.id });
  expect(childError).toBeNull();

  await page.reload();
  await openOpeningBalances(page);
  await expandStation(page, 'المحطة الرئيسية');
  const reviewPanel = await expandWarehouse(page, 'مخزن المواد الخام');

  const reviewRegion = reviewPanel.getByRole('region', { name: /Balances needing review/ });
  await expect(
    reviewRegion,
    'A balance whose classification stopped being a leaf must be surfaced, not hidden.',
  ).toBeVisible();
  await expect(reviewRegion.getByText(parentName)).toBeVisible();
  await expect(reviewRegion.getByText('Classification has sub-classifications')).toBeVisible();
  await expect(
    reviewPanel.getByRole('spinbutton', { name: `Opening balance: ${parentName}` }),
    'A review row is read-only: it must not offer an amount field.',
  ).toHaveCount(0);
  await expect(
    reviewPanel.getByRole('spinbutton'),
    'Only the one remaining leaf row keeps an amount field.',
  ).toHaveCount(1);
  await expect(
    reviewPanel.getByText('350.25', { exact: true }).first(),
    'The review row stays part of the warehouse total (300.25 + 50).',
  ).toBeVisible();
  await expect(
    reviewRegion.getByRole('button', { name: `Delete balance ${parentName}` }),
  ).toBeVisible();

  // Leave the seeded classification tree as it was found.
  await admin.from('opening_balances').delete().eq('classification_id', reviewParent!.id);
  await admin.from('classifications').delete().eq('parent_id', reviewParent!.id);
  await admin.from('classifications').delete().eq('id', reviewParent!.id);
});
