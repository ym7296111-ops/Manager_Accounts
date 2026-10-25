import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFixtures } from '../fixtures/data.ts';
import type { E2EDatabase } from '../fixtures/database.types.ts';

/**
 * Parties CRUD against the local Supabase stack.
 *
 * Runs as the signed-in owner (see `e2e/auth.setup.ts`), in English, over the
 * directory written by `supabase/seed.sql`: one party per type (SUP-001,
 * CUS-001, SIS-001, INT-001). Codes are never sent by the client — the
 * `parties_before_write` trigger mints them from a per-type sequence and
 * refuses any later change of `type` or `code` (22023).
 *
 * Codes are asserted by FORMAT (prefix + at least three digits), never as
 * fixed sequence numbers: each sequence has already issued its `001` to the
 * seed, and any test (or retry) advances it further. The property that
 * matters is that each type mints from its own sequence with its own prefix,
 * which is exactly what the four creates below prove.
 *
 * Every test deletes what it created, so the file is order independent.
 */

const SUPPLIER = 'مورّد الاختبار الآلي';
const CUSTOMER = 'عميل الاختبار الآلي';
const SISTER = 'شقيقة الاختبار الآلي';
const INTERNAL = 'جهة داخلية للاختبار الآلي';
const EDIT_CUSTOMER = 'عميل التعديل الآلي';
const EDIT_RENAMED = 'عميل التعديل — الاسم الجديد';

const CODE_PATTERN: Record<string, RegExp> = {
  supplier: /^SUP-\d{3,}$/,
  customer: /^CUS-\d{3,}$/,
  sister_company: /^SIS-\d{3,}$/,
  internal: /^INT-\d{3,}$/,
};

const SEED_CODE: Record<string, string> = {
  supplier: 'SUP-001',
  customer: 'CUS-001',
  sister_company: 'SIS-001',
  internal: 'INT-001',
};

async function openPartiesTab(page: Page) {
  await page.goto('/settings/project');
  const main = page.getByRole('main');
  await main.getByRole('tab', { name: 'Parties' }).click();
  await expect(main.getByRole('button', { name: 'Add party' })).toBeVisible();
  return main;
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

test.describe('parties CRUD', () => {
  test('owner creates one party of each type and each mints its own prefixed code', async ({
    page,
  }) => {
    const main = await openPartiesTab(page);

    const cases = [
      { type: 'supplier', name: SUPPLIER, badge: 'Supplier', filter: /Suppliers/ },
      { type: 'customer', name: CUSTOMER, badge: 'Customer', filter: /Customers/ },
      { type: 'sister_company', name: SISTER, badge: 'Sister company', filter: /Sister companies/ },
      { type: 'internal', name: INTERNAL, badge: 'Internal party', filter: /Internal parties/ },
    ] as const;

    const mintedCodes = new Set<string>();

    for (const entry of cases) {
      await main.getByRole('button', { name: 'Add party' }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('heading', { name: 'Add party' })).toBeVisible();
      await dialog.getByLabel('Party type').selectOption(entry.type);
      await dialog.getByLabel('Party name').fill(entry.name);
      await dialog.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);

      const row = main.locator('li', { hasText: entry.name });
      await expect(row).toBeVisible();
      await expect(row.getByText(entry.badge, { exact: true })).toBeVisible();

      const codeLocator = row.getByText(CODE_PATTERN[entry.type]!);
      await expect(codeLocator).toBeVisible();
      const code = (await codeLocator.textContent())?.trim() ?? '';
      /* The seed holds each type's 001; a created row must carry a later code
         from the same sequence, never a reuse and never another type's. */
      expect(code).not.toBe(SEED_CODE[entry.type]);
      expect(mintedCodes.has(code)).toBe(false);
      mintedCodes.add(code);
    }

    // ---- type filter: the suppliers block shows seed + created only --------
    await main.getByRole('button', { name: /Suppliers/ }).click();
    await expect(main.getByText(SUPPLIER)).toBeVisible();
    await expect(main.getByText(CUSTOMER)).toHaveCount(0);
    await main.getByRole('button', { name: /All/ }).click();
    await expect(main.getByText(CUSTOMER)).toBeVisible();

    // ---- toggle is_active: the row stays, the affordance flips -------------
    await main.getByRole('button', { name: `Deactivate ${SUPPLIER}` }).click();
    await expect(main.getByRole('button', { name: `Activate ${SUPPLIER}` })).toBeVisible();
    await expect(main.getByText(SUPPLIER)).toBeVisible();
    await main.getByRole('button', { name: `Activate ${SUPPLIER}` }).click();
    await expect(main.getByRole('button', { name: `Deactivate ${SUPPLIER}` })).toBeVisible();

    // ---- cleanup: every created party is deleted again ----------------------
    for (const entry of cases) {
      await deleteParty(page, main, entry.name);
    }
  });

  test('shows the credit terms only for suppliers and customers', async ({ page }) => {
    const main = await openPartiesTab(page);

    await main.getByRole('button', { name: 'Add party' }).click();
    const dialog = page.getByRole('dialog');

    // No type chosen yet: neither credit field is on screen.
    await expect(dialog.getByLabel('Credit limit')).toHaveCount(0);
    await expect(dialog.getByLabel('Payment terms')).toHaveCount(0);

    await dialog.getByLabel('Party type').selectOption('supplier');
    await expect(dialog.getByLabel('Credit limit')).toBeVisible();
    await expect(dialog.getByLabel('Payment terms')).toBeVisible();

    await dialog.getByLabel('Party type').selectOption('sister_company');
    await expect(dialog.getByLabel('Credit limit')).toHaveCount(0);
    await expect(dialog.getByLabel('Payment terms')).toHaveCount(0);

    await dialog.getByLabel('Party type').selectOption('internal');
    await expect(dialog.getByLabel('Credit limit')).toHaveCount(0);

    await dialog.getByLabel('Party type').selectOption('customer');
    await expect(dialog.getByLabel('Credit limit')).toBeVisible();

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('owner edits a customer while type and code stay read-only', async ({ page }) => {
    const main = await openPartiesTab(page);

    // ---- create with contact + credit details -------------------------------
    await main.getByRole('button', { name: 'Add party' }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Party type').selectOption('customer');
    await dialog.getByLabel('Party name').fill(EDIT_CUSTOMER);
    await dialog.getByLabel('Email').fill('auto@edit-customer.example.com');
    await dialog.getByLabel('Credit limit').fill('5000');
    await dialog.getByLabel('Payment terms').selectOption('30');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const row = main.locator('li', { hasText: EDIT_CUSTOMER });
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
    // credit) plus the address textarea — no eighth field for the code.
    await expect(dialog.locator('input')).toHaveCount(7);
    await expect(dialog.locator('textarea')).toHaveCount(1);

    await dialog.getByLabel('Party name').fill(EDIT_RENAMED);
    await dialog.getByLabel('Credit limit').fill('7500');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    /* The rename landed; the code the trigger minted did not move. */
    const renamedRow = main.locator('li', { hasText: EDIT_RENAMED });
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

    await dialog.getByLabel('Party type').selectOption('customer');
    await dialog.getByLabel('Party name').fill('ع');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText('The name must be at least two characters.')).toBeVisible();

    await dialog.getByLabel('Party name').fill('عميل التحقق الآلي');
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
    await expect(main.getByText('عميل التحقق الآلي')).toHaveCount(0);
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

    const { error: insertError } = await client
      .from('parties')
      .insert({ type: 'supplier', name: 'مورّد ممنوع' })
      .select('id');
    expect(insertError?.code).toBe('42501');

    /* Under RLS an UPDATE/DELETE the caller cannot see matches zero rows and
       raises no error; the affected-row count is what proves nothing moved. */
    const { data: updated, error: updateError } = await client
      .from('parties')
      .update({ is_active: false })
      .eq('code', 'SUP-001')
      .select('id, is_active');
    expect(updateError).toBeNull();
    expect(updated).toEqual([]);

    const { data: deleted, error: deleteError } = await client
      .from('parties')
      .delete()
      .eq('code', 'SUP-001')
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
      .eq('code', 'SUP-001')
      .single();
    expect(untouched?.is_active).toBe(true);

    await page.goto('/settings/project');
  });

  test('the database refuses type/code changes and credit terms on internal parties', async () => {
    const client = await ownerClient();
    const { supabaseUrl, anonKey } = await readFixtures();

    // Type is write-once: the trigger raises 22023 even for the owner.
    const { error: typeChange } = await client
      .from('parties')
      .update({ type: 'customer' })
      .eq('code', 'SUP-001')
      .select('id');
    expect(typeChange?.code).toBe('22023');

    /* A hand-rolled API consumer is not bound by the app client's types, so
       drive the two forgery attempts through an untyped client. */
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
      .update({ code: 'SUP-999' })
      .eq('code', 'SUP-001')
      .select('id');
    expect(codeChange?.code).toBe('22023');

    // And a code sent on insert is simply overwritten by the sequence mint.
    const { data: forged, error: forgeError } = await raw
      .from('parties')
      .insert({ type: 'supplier', name: 'جهة تجاوز الكود', code: 'SUP-999' })
      .select('id, code')
      .single();
    expect(forgeError).toBeNull();
    expect(forged?.code).toMatch(CODE_PATTERN.supplier!);
    expect(forged?.code).not.toBe('SUP-999');
    await raw.from('parties').delete().eq('id', forged!.id);

    // Internal parties carry no credit terms — the CHECK, not the UI, refuses.
    const { error: internalCredit } = await client
      .from('parties')
      .insert({ type: 'internal', name: 'جهة داخلية بحد ائتماني', credit_limit: 100 })
      .select('id');
    expect(internalCredit?.code).toBe('23514');

    /* Sister companies stay open at the database level on purpose (possible
       intercompany settlement terms later); hiding the fields is a UI rule
       only. This row proves the asymmetry is deliberate, then cleans up. */
    const { data: sister, error: sisterError } = await client
      .from('parties')
      .insert({
        type: 'sister_company',
        name: 'شقيقة بشروط تسوية',
        credit_limit: 100,
        payment_terms: 15,
      })
      .select('id')
      .single();
    expect(sisterError).toBeNull();
    await client.from('parties').delete().eq('id', sister!.id);
  });
});
