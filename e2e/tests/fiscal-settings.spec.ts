import { expect, test } from '@playwright/test';
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

test.afterEach(async () => {
  await cleanFiscalYear();
});

test('owner creates a fiscal year, changes its period, saves opening balances and checks audit', async ({
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

  await fiscalTabs.getByRole('tab', { name: 'Opening balances' }).click();
  await main.getByRole('button', { name: 'Show warehouses for المحطة الرئيسية' }).click();
  await main.getByRole('button', { name: 'Show classifications for مخزن المواد الخام' }).click();

  const steelBalance = main.getByRole('spinbutton', {
    name: /Opening balance: .*حديد وصلب/,
  });
  await steelBalance.fill('125.50');
  await main.getByRole('button', { name: 'Save balances for مخزن المواد الخام' }).click();
  await expect(
    main.getByRole('status').filter({ hasText: 'Opening balances saved.' }),
  ).toBeVisible();
  await expect(steelBalance).toHaveValue('125.50');
  await expect(main.getByText('125.50', { exact: true })).toHaveCount(2);

  const { data: warehouse, error: warehouseError } = await admin
    .from('warehouses')
    .select('id')
    .eq('name', 'مخزن المواد الخام')
    .single();
  expect(warehouseError).toBeNull();
  const { data: classification, error: classificationError } = await admin
    .from('classifications')
    .select('id')
    .eq('name', 'حديد وصلب')
    .single();
  expect(classificationError).toBeNull();

  const { data: balance, error: balanceError } = await admin
    .from('opening_balances')
    .select('id, amount')
    .eq('fiscal_year_id', year!.id)
    .eq('warehouse_id', warehouse!.id)
    .eq('classification_id', classification!.id)
    .single();
  expect(balanceError).toBeNull();
  expect(balance?.amount).toBe(125.5);

  const { data: auditRows, error: auditError } = await admin
    .from('audit_logs')
    .select('id, action, entity, entity_id, actor_id, metadata')
    .eq('action', 'opening_balance.updated')
    .eq('entity', 'opening_balances')
    .eq('entity_id', balance!.id)
    .order('id', { ascending: true });
  expect(auditError).toBeNull();
  expect(auditRows).toHaveLength(1);
  expect(auditRows?.[0]).toMatchObject({
    actor_id: fixtures.owner.id,
    metadata: {
      fiscal_year_id: year!.id,
      warehouse_id: warehouse!.id,
      classification_id: classification!.id,
      old_amount: null,
      new_amount: 125.5,
    },
  });
});
