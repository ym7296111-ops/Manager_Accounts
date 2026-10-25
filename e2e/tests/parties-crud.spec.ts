import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFixtures } from '../fixtures/data.ts';
import type { E2EDatabase } from '../fixtures/database.types.ts';

/**
 * Parties and sister companies, end to end against the local Supabase stack.
 *
 * «جهات الوارد والمنصرف» is three sub-tabs:
 *
 *   Inbound parties   local + foreign suppliers   LOC-### / FRN-###
 *   Outbound parties  customers only              CUS-###
 *   Sister companies  a two-level tree            SIS-### / SIS-###-##
 *
 * Runs as the signed-in owner (see `e2e/auth.setup.ts`), in English, over the
 * directory written by `supabase/seed.sql`: one local supplier (LOC-001), one
 * foreign supplier (FRN-001), one customer (CUS-001) and the sister tree
 * SIS-001 → SIS-001-01 / SIS-001-02.
 *
 * Codes are asserted by FORMAT (prefix + digits), never as fixed sequence
 * numbers: each sequence has already issued its `001` to the seed, and any
 * test (or retry) advances it further. What matters is that each type mints
 * from its own sequence with its own prefix — exactly what the creates below
 * prove — and that the outbound tab cannot mint anything but CUS.
 *
 * Every test deletes what it created, so the file is order independent.
 */

const LOCAL = 'مورّد محلي آلي';
const FOREIGN = 'Automated Foreign Supplier';
const CUSTOMER = 'عميل الاختبار الآلي';
const EDIT_CUSTOMER = 'عميل التعديل الآلي';
const EDIT_RENAMED = 'عميل التعديل — الاسم الجديد';
const PARENT = 'شركة شقيقة آلية';
const BRANCH = 'فرع آلي';

const CODE_PATTERN: Record<string, RegExp> = {
  local_supplier: /^LOC-\d{3,}$/,
  foreign_supplier: /^FRN-\d{3,}$/,
  customer: /^CUS-\d{3,}$/,
};

async function openPartiesTab(page: Page) {
  await page.goto('/settings/project');
  const main = page.getByRole('main');
  await main.getByRole('tab', { name: 'Inbound & Outbound' }).click();
  await expect(main.getByRole('tab', { name: 'Inbound parties' })).toBeVisible();
  return main;
}

async function selectSubTab(main: ReturnType<Page['getByRole']>, name: string) {
  await main.getByRole('tab', { name }).click();
  await expect(main.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
}

async function deleteParty(page: Page, main: ReturnType<Page['getByRole']>, name: string) {
  await main.getByRole('button', { name: `Delete ${name}` }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Delete party' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Confirm delete' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(main.getByText(name)).toHaveCount(0);
}

/** A signed-in owner client, for assertions the UI cannot make about itself. */
async function ownerClient() {
  const { owner, supabaseUrl, anonKey } = await readFixtures();
  const client = createClient<E2EDatabase>(supabaseUrl, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({
    email: owner.email,
    password: owner.password,
  });
  expect(error).toBeNull();
  return client;
}

test.describe('parties — inbound and outbound tabs', () => {
  test('the inbound tab creates local and foreign suppliers with their own prefixes', async ({
    page,
  }) => {
    const main = await openPartiesTab(page);

    // The seeded inbound rows are on screen; the customer belongs to the other tab.
    await expect(main.getByText('LOC-001')).toBeVisible();
    await expect(main.getByText('FRN-001')).toBeVisible();
    await expect(main.getByText('CUS-001')).toHaveCount(0);

    const cases = [
      { type: 'local_supplier', name: LOCAL, badge: 'Local supplier' },
      { type: 'foreign_supplier', name: FOREIGN, badge: 'Foreign supplier' },
    ] as const;

    const mintedCodes = new Set<string>();

    for (const entry of cases) {
      await main.getByRole('button', { name: 'Add party' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Add party' })).toBeVisible();

      /* The inbound type select offers the two supplier kinds and a customer
         is not among them. */
      const options = await dialog.getByLabel('Party type').locator('option').allTextContents();
      expect(options).toEqual(['Choose a party type…', 'Local supplier', 'Foreign supplier']);

      await dialog.getByLabel('Party type').selectOption(entry.type);
      await dialog.getByLabel('Party name').fill(entry.name);
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      const row = main.getByRole('row', { name: new RegExp(entry.name) });
      await expect(row).toBeVisible();
      await expect(row.getByText(entry.badge, { exact: true })).toBeVisible();

      const code = (await row.getByText(CODE_PATTERN[entry.type]!).textContent())?.trim() ?? '';
      expect(code).toMatch(CODE_PATTERN[entry.type]!);
      expect(mintedCodes.has(code)).toBe(false);
      mintedCodes.add(code);
    }

    // ---- toggle is_active: the row stays, the affordance flips -------------
    await main.getByRole('button', { name: `Deactivate ${LOCAL}` }).click();
    await expect(main.getByRole('button', { name: `Activate ${LOCAL}` })).toBeVisible();
    await expect(main.getByText(LOCAL)).toBeVisible();
    await main.getByRole('button', { name: `Activate ${LOCAL}` }).click();
    await expect(main.getByRole('button', { name: `Deactivate ${LOCAL}` })).toBeVisible();

    // ---- cleanup ------------------------------------------------------------
    for (const entry of cases) {
      await deleteParty(page, main, entry.name);
    }
  });

  test('the outbound tab creates customers only, with the type fixed by the tab', async ({
    page,
  }) => {
    const main = await openPartiesTab(page);
    await selectSubTab(main, 'Outbound parties');

    await expect(main.getByText('CUS-001')).toBeVisible();
    await expect(main.getByText(LOCAL)).toHaveCount(0);

    await main.getByRole('button', { name: 'Add party' }).click();
    const dialog = page.getByRole('dialog');

    /* No type control at all: the tab decides. */
    await expect(dialog.getByLabel('Party type')).toHaveCount(0);
    await expect(dialog.getByText('Customer', { exact: true })).toBeVisible();
    await expect(
      dialog.getByText('This tab creates customers only; their codes come from the CUS sequence.'),
    ).toBeVisible();

    await dialog.getByLabel('Party name').fill(CUSTOMER);
    await dialog.getByLabel('Credit limit').fill('5000');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const row = main.getByRole('row', { name: new RegExp(CUSTOMER) });
    const code = (await row.getByText(CODE_PATTERN.customer!).textContent())?.trim() ?? '';
    expect(code).toMatch(CODE_PATTERN.customer!);
    await expect(row.getByText('Customer', { exact: true })).toBeVisible();

    await deleteParty(page, main, CUSTOMER);
  });

  test('owner edits a customer while type and code stay read-only', async ({ page }) => {
    const main = await openPartiesTab(page);
    await selectSubTab(main, 'Outbound parties');

    // ---- create with contact + credit details -------------------------------
    await main.getByRole('button', { name: 'Add party' }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Party name').fill(EDIT_CUSTOMER);
    await dialog.getByLabel('Email').fill('auto@edit-customer.example.com');
    await dialog.getByLabel('Credit limit').fill('5000');
    await dialog.getByLabel('Payment terms').selectOption('30');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const row = main.getByRole('row', { name: new RegExp(EDIT_CUSTOMER) });
    const createdCode = (await row.getByText(CODE_PATTERN.customer!).textContent())?.trim();
    expect(createdCode).toBeTruthy();

    // ---- edit: identity is text, never input --------------------------------
    await main.getByRole('button', { name: `Edit ${EDIT_CUSTOMER}` }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Edit party' })).toBeVisible();
    await expect(dialog.getByLabel('Party name')).toHaveValue(EDIT_CUSTOMER);
    await expect(dialog.getByLabel('Credit limit')).toHaveValue('5000');
    await expect(dialog.getByLabel('Payment terms')).toHaveValue('30');

    await expect(dialog.getByText('Code (generated automatically)')).toBeVisible();
    await expect(dialog.getByText(createdCode!)).toBeVisible();
    // No type select exists on edit; the only select is the payment terms.
    await expect(dialog.getByLabel('Party type')).toHaveCount(0);
    await expect(dialog.locator('select')).toHaveCount(1);
    // Seven text-like inputs (name, tax, register, contact, phone, email,
    // credit) plus the address textarea — no extra field for the code.
    await expect(dialog.locator('input')).toHaveCount(7);
    await expect(dialog.locator('textarea')).toHaveCount(1);

    await dialog.getByLabel('Party name').fill(EDIT_RENAMED);
    await dialog.getByLabel('Credit limit').fill('7500');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    /* The rename landed; the code the trigger minted did not move. */
    const renamedRow = main.getByRole('row', { name: new RegExp(EDIT_RENAMED) });
    await expect(renamedRow.getByText(createdCode!)).toBeVisible();
    await expect(main.getByText(EDIT_CUSTOMER)).toHaveCount(0);

    // The edited credit limit round-trips back into the form.
    await main.getByRole('button', { name: `Edit ${EDIT_RENAMED}` }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Credit limit')).toHaveValue('7500');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await deleteParty(page, main, EDIT_RENAMED);
  });

  test('refuses invalid input before any request', async ({ page }) => {
    const main = await openPartiesTab(page);

    await main.getByRole('button', { name: 'Add party' }).click();
    const dialog = page.getByRole('dialog');

    // The type is a one-time choice: submitting unchosen is refused inline.
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText('Please choose a party type.')).toBeVisible();
    await expect(dialog.getByText('A name is required.')).toBeVisible();
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Party type').selectOption('local_supplier');
    await dialog.getByLabel('Party name').fill('ع');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText('The name must be at least two characters.')).toBeVisible();

    await dialog.getByLabel('Party name').fill('مورّد التحقق الآلي');
    await dialog.getByLabel('Email').fill('not-an-email');
    await dialog.getByLabel('Credit limit').fill('-5');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText('Enter a valid email address, or leave it empty.')).toBeVisible();
    await expect(
      dialog.getByText('Enter a valid amount (zero or more), or leave it empty.'),
    ).toBeVisible();
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(main.getByText('مورّد التحقق الآلي')).toHaveCount(0);
  });
});

test.describe('sister companies tree', () => {
  test('owner adds a parent company and a branch, and the server derives both codes', async ({
    page,
  }) => {
    const main = await openPartiesTab(page);
    await selectSubTab(main, 'Sister companies');

    await expect(main.getByText('SIS-001', { exact: true })).toBeVisible();

    /* The root hint shows the shape of the code, never a number: a second
       parent is SIS-002 while SIS-001 is taken. */
    await main.getByRole('button', { name: 'Add parent company' }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/SIS-###/)).toBeVisible();
    await dialog.getByLabel('Company name').fill(PARENT);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const parentRow = main.getByRole('button', { name: new RegExp(`^${PARENT}`) });
    const parentCode = (await parentRow.getByText(/^SIS-\d{3,}$/).textContent())?.trim() ?? '';
    expect(parentCode).toMatch(/^SIS-\d{3,}$/);
    expect(parentCode).not.toBe('SIS-001');

    // ---- branch under it ----------------------------------------------------
    await parentRow.click();
    await main.getByRole('button', { name: `Add branch under “${PARENT}”` }).click();
    dialog = page.getByRole('dialog');
    /* The hint names the parent's real prefix, so the preview is the code this
       branch will actually get, not a hard-coded SIS-001-01 example. */
    await expect(dialog.getByText(new RegExp(`${parentCode}-##`))).toBeVisible();
    await dialog.getByLabel('Company name').fill(BRANCH);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    /* Branches nest in a <ul> inside the parent's <li>, so the filter matches
       both the parent's item and the branch's own: the innermost is the row. */
    const branchRow = main.getByRole('listitem').filter({ hasText: BRANCH }).last();
    await expect(branchRow.getByText(new RegExp(`^${parentCode}-01$`))).toBeVisible();
    await expect(main.getByText('Branches: 1')).toBeVisible();

    // ---- a parent with branches offers no delete ----------------------------
    await expect(main.getByRole('button', { name: `Delete ${PARENT}` })).toHaveCount(0);

    // ---- cleanup: branch first, then the parent -----------------------------
    await main.getByRole('button', { name: `Delete ${BRANCH}` }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Confirm delete' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(main.getByText(BRANCH)).toHaveCount(0);

    await main.getByRole('button', { name: `Delete ${PARENT}` }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Confirm delete' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(main.getByText(PARENT)).toHaveCount(0);
  });
});

test.describe('parties authorization & immutability', () => {
  test('an ordinary admin without project.settings:manage can neither read nor write', async ({
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

    // Read is refused by RLS filtering the rows away rather than erroring.
    const { data: visible, error: readError } = await client.from('parties').select('id, code');
    expect(readError).toBeNull();
    expect(visible).toEqual([]);

    const { data: treeVisible, error: treeError } = await client
      .from('sister_companies')
      .select('id, code');
    expect(treeError).toBeNull();
    expect(treeVisible).toEqual([]);

    const { error: insertError } = await client
      .from('parties')
      .insert({ type: 'local_supplier', name: 'مورّد ممنوع' })
      .select('id');
    expect(insertError?.code).toBe('42501');

    const { error: treeInsertError } = await client
      .from('sister_companies')
      .insert({ name: 'شركة ممنوعة' })
      .select('id');
    expect(treeInsertError?.code).toBe('42501');

    /* Under RLS an UPDATE/DELETE the caller cannot see matches zero rows and
       raises no error; the affected-row count is what proves nothing moved. */
    const { data: updated, error: updateError } = await client
      .from('parties')
      .update({ is_active: false })
      .eq('code', 'LOC-001')
      .select('id, is_active');
    expect(updateError).toBeNull();
    expect(updated).toEqual([]);

    const { data: deleted, error: deleteError } = await client
      .from('parties')
      .delete()
      .eq('code', 'LOC-001')
      .select('id');
    expect(deleteError).toBeNull();
    expect(deleted).toEqual([]);

    const service = createClient<E2EDatabase>(
      supabaseUrl,
      process.env.SUPABASE_SERVICE_ROLE_KEY ?? anonKey,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const { data: untouched } = await service
      .from('parties')
      .select('is_active')
      .eq('code', 'LOC-001')
      .single();
    expect(untouched?.is_active).toBe(true);

    await page.goto('/settings/project');
  });

  test('the database refuses the retired types and any type/code change', async () => {
    const client = await ownerClient();
    const { supabaseUrl, anonKey } = await readFixtures();

    // A type is write-once: the trigger raises 22023 even for the owner.
    const { error: typeChange } = await client
      .from('parties')
      .update({ type: 'customer' })
      .eq('code', 'LOC-001')
      .select('id');
    expect(typeChange?.code).toBe('22023');

    /* A hand-rolled API consumer is not bound by the app client's types, so
       drive the forgery attempts through an untyped client. */
    const { owner } = await readFixtures();
    const raw = createClient(supabaseUrl, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: rawSignIn } = await raw.auth.signInWithPassword({
      email: owner.email,
      password: owner.password,
    });
    expect(rawSignIn).toBeNull();

    // Code is immutable too.
    const { error: codeChange } = await raw
      .from('parties')
      .update({ code: 'LOC-999' })
      .eq('code', 'LOC-001')
      .select('id');
    expect(codeChange?.code).toBe('22023');

    // A code sent on insert is overwritten by the sequence mint.
    const { data: forged, error: forgeError } = await raw
      .from('parties')
      .insert({ type: 'foreign_supplier', name: 'جهة تجاوز الكود', code: 'LOC-999' })
      .select('id, code')
      .single();
    expect(forgeError).toBeNull();
    expect(forged?.code).toMatch(CODE_PATTERN.foreign_supplier!);
    expect(forged?.code).not.toBe('LOC-999');
    await raw.from('parties').delete().eq('id', forged!.id);

    /* The retired vocabulary is rejected by `parties_type_check` (23514): an
       internal department is no longer a counterparty, and sister companies
       have their own table. */
    for (const retired of ['supplier', 'internal', 'sister_company']) {
      const { error } = await raw
        .from('parties')
        .insert({ type: retired, name: `نوع متقاعد ${retired}` })
        .select('id');
      expect(error?.code).toBe('23514');
    }

    /* Sister companies: parent_id and code are write-once (22023), the tree is
       exactly two levels, and a parent with branches cannot be deleted. */
    const { data: parent, error: parentError } = await raw
      .from('sister_companies')
      .insert({ name: 'شقيقة آلي للاختبار' })
      .select('id, code')
      .single();
    expect(parentError).toBeNull();
    expect(parent?.code).toMatch(/^SIS-\d{3,}$/);

    const { error: parentChange } = await raw
      .from('sister_companies')
      .update({ parent_id: parent!.id })
      .eq('id', parent!.id)
      .select('id');
    expect(parentChange?.code).toBe('22023');

    const { error: codeChangeTree } = await raw
      .from('sister_companies')
      .update({ code: 'SIS-999-99' })
      .eq('id', parent!.id)
      .select('id');
    expect(codeChangeTree?.code).toBe('22023');

    const { data: branch, error: branchError } = await raw
      .from('sister_companies')
      .insert({ name: 'فرع آلي للاختبار', parent_id: parent!.id })
      .select('id, code, level')
      .single();
    expect(branchError).toBeNull();
    expect(branch?.code).toBe(`${parent!.code}-01`);
    expect(branch?.level).toBe(2);

    // A third level is refused.
    const { error: thirdLevel } = await raw
      .from('sister_companies')
      .insert({ name: 'مستوى ثالث', parent_id: branch!.id })
      .select('id');
    expect(thirdLevel?.code).toBe('22023');

    // ON DELETE RESTRICT: the parent still holds a branch.
    const { error: parentDelete } = await raw
      .from('sister_companies')
      .delete()
      .eq('id', parent!.id)
      .select('id');
    expect(parentDelete?.code).toBe('23503');

    await raw.from('sister_companies').delete().eq('id', branch!.id);
    await raw.from('sister_companies').delete().eq('id', parent!.id);
  });
});
