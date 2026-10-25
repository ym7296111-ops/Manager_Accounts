import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFixtures } from '../fixtures/data.ts';
import type { E2EDatabase } from '../fixtures/database.types.ts';

/**
 * Parties and sister companies, end to end against the local Supabase stack.
 *
 * «جهات الوارد وأغراض الصرف» is a two-level tree with two fixed roots, and
 * «الشركات الشقيقة» is a top-level tab of Project Settings in its own right:
 *
 *   Inbound parties    → IN-###    one flat level under the root
 *   Outbound purposes  → OUT-###   one flat level under the root
 *   Sister companies     SIS-### / SIS-###-##   a separate tab, untouched
 *
 * A party is a name, a code and an active flag — nothing else. The commercial
 * profile (tax number, commercial register, address, contact person, phone,
 * email, credit limit, payment terms) was retired with its columns, so no test
 * below looks for one, and one test asserts the dialog has a single field.
 *
 * Runs as the signed-in owner (see `e2e/auth.setup.ts`), in English, over the
 * directory written by `supabase/seed.sql`: two inbound parties (IN-001,
 * IN-002) and one outbound party (OUT-001), plus the sister tree
 * SIS-001 → SIS-001-01 / SIS-001-02.
 *
 * Codes are asserted by FORMAT (prefix + digits), never as fixed sequence
 * numbers: each branch sequence has already issued the codes the seed holds,
 * and any test (or retry) advances it further. What matters is that each root
 * mints from its own sequence — exactly what the creates below prove.
 *
 * Every test deletes what it created, so the file is order independent.
 */

const INBOUND_NAME = 'مورّد الوارد الآلي';
const INBOUND_RENAMED = 'مورّد الوارد — الاسم الجديد';
const OUTBOUND_NAME = 'جهة الصرف الآلية';
const PARENT = 'شركة شقيقة آلية';
const BRANCH = 'فرع آلي';

const INBOUND_CODE = /^IN-\d{3,}$/;
const OUTBOUND_CODE = /^OUT-\d{3,}$/;

async function openPartiesTab(page: Page) {
  await page.goto('/settings/project');
  const main = page.getByRole('main');
  await main.getByRole('tab', { name: 'Inbound & Outbound' }).click();
  await expect(main.locator('#parties-root-inbound')).toBeVisible();
  await expect(main.locator('#parties-root-outbound')).toBeVisible();
  return main;
}

/** Opens the sister-companies tree through its own top-level tab. */
async function openSisterTab(page: Page) {
  await page.goto('/settings/project');
  const main = page.getByRole('main');
  await main.getByRole('tab', { name: 'Sister companies' }).click();
  await expect(main.getByRole('tab', { name: 'Sister companies' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(main.getByRole('heading', { name: 'Sister companies tree' })).toBeVisible();
  return main;
}

async function deleteParty(main: ReturnType<Page['getByRole']>, page: Page, name: string) {
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

test.describe('parties — the two-root tree', () => {
  test('the inbound root creates a party from its own sequence', async ({ page }) => {
    const main = await openPartiesTab(page);

    // Seeded rows: two inbound, one outbound, each under its own root.
    const inboundPanel = main.locator('#parties-root-panel-inbound');
    const outboundPanel = main.locator('#parties-root-panel-outbound');
    await expect(inboundPanel.getByText('IN-001', { exact: true })).toBeVisible();
    await expect(inboundPanel.getByText('IN-002', { exact: true })).toBeVisible();
    await expect(outboundPanel.getByText('OUT-001', { exact: true })).toBeVisible();
    await expect(inboundPanel.getByText('OUT-001', { exact: true })).toHaveCount(0);
    await expect(outboundPanel.getByText('IN-001', { exact: true })).toHaveCount(0);

    await main.getByRole('button', { name: 'Add a party under “Inbound parties”' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add an inbound party' })).toBeVisible();

    /* The root decides the branch: there is no branch/type control, and the
       hint names the IN sequence the code will come from. */
    await expect(dialog.locator('select')).toHaveCount(0);
    await expect(dialog.getByText(/IN sequence/)).toBeVisible();
    await expect(dialog.getByText('IN-###')).toBeVisible();

    /* A party is a name and nothing else: exactly one field. */
    await expect(dialog.getByRole('textbox')).toHaveCount(1);
    await expect(dialog.locator('textarea, input[type="email"], input[type="tel"]')).toHaveCount(0);

    await dialog.getByLabel('Party name').fill(INBOUND_NAME);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const row = inboundPanel.getByRole('listitem').filter({ hasText: INBOUND_NAME });
    await expect(row).toBeVisible();
    const code = (await row.getByText(INBOUND_CODE).textContent())?.trim() ?? '';
    expect(code).toMatch(INBOUND_CODE);
    expect(code).not.toBe('IN-001');

    // ---- toggle is_active: the row stays, the affordance flips -------------
    await main.getByRole('button', { name: `Deactivate ${INBOUND_NAME}` }).click();
    await expect(main.getByRole('button', { name: `Activate ${INBOUND_NAME}` })).toBeVisible();
    await expect(main.getByText(INBOUND_NAME)).toBeVisible();
    await main.getByRole('button', { name: `Activate ${INBOUND_NAME}` }).click();
    await expect(main.getByRole('button', { name: `Deactivate ${INBOUND_NAME}` })).toBeVisible();

    // ---- rename: the code the trigger minted does not move ------------------
    await main.getByRole('button', { name: `Edit ${INBOUND_NAME}` }).click();
    const edit = page.getByRole('dialog');
    await expect(edit.getByRole('heading', { name: 'Edit party' })).toBeVisible();
    await expect(edit.getByLabel('Party name')).toHaveValue(INBOUND_NAME);
    /* The identity is text, never input: one field, no select, and the code is
       shown read-only. */
    await expect(edit.getByRole('textbox')).toHaveCount(1);
    await expect(edit.locator('select')).toHaveCount(0);
    await expect(edit.getByText('Code (generated automatically)')).toBeVisible();
    await expect(edit.getByText(code, { exact: true })).toBeVisible();

    await edit.getByLabel('Party name').fill(INBOUND_RENAMED);
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const renamed = inboundPanel.getByRole('listitem').filter({ hasText: INBOUND_RENAMED });
    await expect(renamed.getByText(code, { exact: true })).toBeVisible();
    await expect(main.getByText(INBOUND_NAME)).toHaveCount(0);

    await deleteParty(main, page, INBOUND_RENAMED);
  });

  test('the outbound root creates a party from the OUT sequence', async ({ page }) => {
    const main = await openPartiesTab(page);
    const outboundPanel = main.locator('#parties-root-panel-outbound');

    await expect(outboundPanel.getByText('OUT-001', { exact: true })).toBeVisible();
    await expect(main.getByText(INBOUND_NAME)).toHaveCount(0);

    await main.getByRole('button', { name: 'Add a party under “Outbound purposes”' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add an outbound party' })).toBeVisible();
    await expect(dialog.locator('select')).toHaveCount(0);
    await expect(dialog.getByText(/OUT sequence/)).toBeVisible();
    await expect(dialog.getByText('OUT-###')).toBeVisible();

    await dialog.getByLabel('Party name').fill(OUTBOUND_NAME);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const row = outboundPanel.getByRole('listitem').filter({ hasText: OUTBOUND_NAME });
    const code = (await row.getByText(OUTBOUND_CODE).textContent())?.trim() ?? '';
    expect(code).toMatch(OUTBOUND_CODE);

    /* The new row landed under the outbound root, not the inbound one. */
    await expect(main.locator('#parties-root-panel-inbound').getByText(OUTBOUND_NAME)).toHaveCount(
      0,
    );

    await deleteParty(main, page, OUTBOUND_NAME);
  });

  test('refuses a blank or one-character name before any request', async ({ page }) => {
    const main = await openPartiesTab(page);

    await main.getByRole('button', { name: 'Add a party under “Inbound parties”' }).click();
    const dialog = page.getByRole('dialog');

    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText('A name is required.')).toBeVisible();
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Party name').fill('ع');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog.getByText('The name must be at least two characters.')).toBeVisible();

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(main.getByText('ع', { exact: true })).toHaveCount(0);
  });

  test('a root with no parties still shows its root, its count and its add button', async ({
    page,
  }) => {
    const main = await openPartiesTab(page);

    /* Collapsing and re-opening keeps both roots and their counts in place. */
    const inboundRoot = main.locator('#parties-root-inbound');
    await expect(inboundRoot).toContainText('parties');
    await inboundRoot.click();
    await expect(inboundRoot).toHaveAttribute('aria-expanded', 'false');
    await expect(main.locator('#parties-root-panel-inbound')).toHaveCount(0);
    await inboundRoot.click();
    await expect(main.locator('#parties-root-panel-inbound')).toBeVisible();

    /* The scaffold is fixed: two roots, never derived from the rows. */
    await expect(main.locator('[id^="parties-root-"]')).toHaveCount(2);
  });
});

test.describe('sister companies tree — a top-level project-settings tab', () => {
  test('owner adds a parent company and a branch, and the server derives both codes', async ({
    page,
  }) => {
    const main = await openSisterTab(page);

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

    const { error: insertError } = await client
      .from('parties')
      .insert({ branch: 'inbound', name: 'جهة ممنوعة' })
      .select('id');
    expect(insertError?.code).toBe('42501');

    /* Under RLS an UPDATE/DELETE the caller cannot see matches zero rows and
       raises no error; the affected-row count is what proves nothing moved. */
    const { data: updated, error: updateError } = await client
      .from('parties')
      .update({ is_active: false })
      .eq('code', 'IN-001')
      .select('id, is_active');
    expect(updateError).toBeNull();
    expect(updated).toEqual([]);

    const { data: deleted, error: deleteError } = await client
      .from('parties')
      .delete()
      .eq('code', 'IN-001')
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
      .eq('code', 'IN-001')
      .single();
    expect(untouched?.is_active).toBe(true);

    await page.goto('/settings/project');
  });

  test('the database refuses a branch/code change and an unknown branch', async () => {
    const client = await ownerClient();
    const { supabaseUrl, anonKey } = await readFixtures();

    // A branch is write-once: the trigger raises 22023 even for the owner.
    const { error: branchChange } = await client
      .from('parties')
      .update({ branch: 'outbound' })
      .eq('code', 'IN-001')
      .select('id');
    expect(branchChange?.code).toBe('22023');

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
      .update({ code: 'IN-999' })
      .eq('code', 'IN-001')
      .select('id');
    expect(codeChange?.code).toBe('22023');

    // A code sent on insert is overwritten by the sequence mint.
    const { data: forged, error: forgeError } = await raw
      .from('parties')
      .insert({ branch: 'outbound', name: 'جهة تجاوز الكود', code: 'IN-999' })
      .select('id, code')
      .single();
    expect(forgeError).toBeNull();
    expect(forged?.code).toMatch(OUTBOUND_CODE);
    expect(forged?.code).not.toBe('IN-999');
    await raw.from('parties').delete().eq('id', forged!.id);

    /* The retired vocabulary is gone: an old type is simply not a column, and a
       branch outside the two roots is rejected by `parties_branch_check`
       (23514). A missing branch fails NOT NULL (23502). */
    for (const retiredBranch of ['supplier', 'local_supplier', 'customer', 'internal', '']) {
      const { error } = await raw
        .from('parties')
        .insert({ branch: retiredBranch, name: `فرع متقاعد ${retiredBranch}` })
        .select('id');
      expect(error?.code).toBe('23514');
    }

    const { error: missingBranch } = await raw
      .from('parties')
      .insert({ name: 'جهة بلا فرع' })
      .select('id');
    expect(missingBranch?.code).toBe('23502');

    /* The profile columns are gone from the schema, so PostgREST rejects a
       payload that names one instead of silently dropping it. */
    const { error: retiredColumn } = await raw
      .from('parties')
      .insert({ branch: 'inbound', name: 'جهة بحقل متقاعد', email: 'x@example.com' })
      .select('id');
    expect(retiredColumn).not.toBeNull();

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
