import { expect, test, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';
import { readFixtures } from '../fixtures/data.ts';
import type { E2EDatabase } from '../fixtures/database.types.ts';

/**
 * Classifications CRUD against the local Supabase stack.
 *
 * Runs as the signed-in owner (see `e2e/auth.setup.ts`), in English, over the
 * demo tree written by `supabase/seed.sql`:
 *
 *   CLS-001 المواد والمستلزمات ─┬─ CLS-003 المواد الخام ─┬─ CLS-006 حديد وصلب
 *                              │                        ├─ CLS-007 أخشاب
 *                              │                        └─ CLS-008 بلاستيك ومطاط
 *                              └─ CLS-004 مستلزمات التشغيل ─┬─ CLS-009 زيوت وشحوم
 *                                                           └─ CLS-010 قطع غيار
 *   CLS-002 الخدمات ── CLS-005 خدمات الصيانة (inactive) ─┬─ CLS-011 صيانة دورية
 *                                                        └─ CLS-012 إصلاح أعطال
 *
 * Codes are NEVER asserted as fixed numbers here. Classification codes come from
 * `classification_code_seq`, which the seed has already advanced to 12 and which
 * any other test (or a retry) advances further — an exact `CLS-013` assertion
 * would encode test order instead of behaviour. The spec asserts the FORMAT
 * (`CLS-` + at least three digits), that each created node has a distinct code,
 * and that the level is rendered where it belongs. That is the property that
 * matters: the client never sends a code and the server always mints one.
 *
 * Every test cleans up what it created, so the file is order independent.
 */

const CATEGORY = 'Automated test category';
const GROUP = 'Automated test group';
const ITEM = 'Automated test item';
const RENAMED = 'Automated test item renamed';

const CODE_PATTERN = /^CLS-\d{3,}$/;

async function openClassificationsTab(page: Page) {
  await page.goto('/settings/project');
  const main = page.getByRole('main');
  await main.getByRole('tab', { name: 'Classifications' }).click();
  await expect(main.getByRole('heading', { name: 'Classifications tree' })).toBeVisible();
  return main;
}

/** The disclosure button for a node, targeted by `aria-expanded` so that the
 *  row's Edit / Deactivate / Delete buttons (which also carry its name) cannot
 *  make the locator ambiguous. */
function toggleOf(page: Page, name: string) {
  return page.getByRole('main').locator('button[aria-expanded]').filter({ hasText: name }).first();
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

test.describe('classifications CRUD', () => {
  /* The sign-in fixture leaves the locale at the Arabic default; pin English so
     the accessible names below are the ones in `en.ts`. */
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('admin-system:locale', 'en'));
  });

  test('owner builds category → group → item, then renames, toggles and unwinds the tree', async ({
    page,
  }) => {
    const main = await openClassificationsTab(page);

    // ---- create a category: name only, no code field -----------------------
    await main.getByRole('button', { name: 'Add category' }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add category' })).toBeVisible();
    // One editable field and no code/level/parent control of any kind.
    await expect(dialog.locator('input')).toHaveCount(1);
    await expect(dialog.locator('select')).toHaveCount(0);
    await dialog.getByLabel('category name').fill(CATEGORY);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const categoryToggle = toggleOf(page, CATEGORY);
    await expect(categoryToggle).toBeVisible();

    /* Ask the database what it minted, then assert the screen shows it. Scraping
       a code out of the row would also match descendant codes once the subtree
       is open, and would prove nothing about who chose the value. */
    const client = await ownerClient();
    const readRow = async (name: string) => {
      const { data } = await client
        .from('classifications')
        .select('id, parent_id, code, name, level, is_leaf, is_active')
        .eq('name', name)
        .single();
      return data;
    };

    const createdCategory = await readRow(CATEGORY);
    expect(createdCategory?.code).toMatch(CODE_PATTERN);
    // The client never supplied a code; the server minted one and the UI shows it.
    await expect(main.getByText(createdCategory?.code ?? '')).toBeVisible();

    // ---- create a group inside it: the parent is carried by the request ----
    await categoryToggle.click();
    await expect(categoryToggle).toHaveAttribute('aria-expanded', 'true');
    await main.getByRole('button', { name: 'Add group' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add group' })).toBeVisible();
    // The dialog states where the node lands; it does not offer to change it.
    await expect(dialog.getByText(CATEGORY, { exact: false })).toBeVisible();
    await dialog.getByLabel('group name').fill(GROUP);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    const groupToggle = toggleOf(page, GROUP);
    await expect(groupToggle).toBeVisible();
    const createdGroup = await readRow(GROUP);
    expect(createdGroup?.code).toMatch(CODE_PATTERN);
    expect(createdGroup?.code).not.toBe(createdCategory?.code);
    await expect(main.getByText(createdGroup?.code ?? '')).toBeVisible();

    // ---- create an item inside the group -----------------------------------
    await groupToggle.click();
    await expect(groupToggle).toHaveAttribute('aria-expanded', 'true');
    await main.getByRole('button', { name: 'Add item' }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Add item' })).toBeVisible();
    await dialog.getByLabel('item name').fill(ITEM);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);

    await expect(main.getByText(ITEM)).toBeVisible();

    /* ---- the tree really is three levels deep ------------------------------
       Re-read all three rows now that the subtree is complete: `is_leaf` is
       derived from the child list, so the snapshots taken at creation time
       predate the children that flip a parent from leaf to branch. */
    const finishedCategory = await readRow(CATEGORY);
    const finishedGroup = await readRow(GROUP);
    const createdItem = await readRow(ITEM);

    expect(finishedCategory?.level).toBe(1);
    expect(finishedGroup?.level).toBe(2);
    expect(createdItem?.level).toBe(3);
    expect(finishedGroup?.parent_id).toBe(finishedCategory?.id);
    expect(createdItem?.parent_id).toBe(finishedGroup?.id);
    // The two parents flipped to non-leaf without anybody sending is_leaf.
    expect(finishedCategory?.is_leaf).toBe(false);
    expect(finishedGroup?.is_leaf).toBe(false);
    expect(createdItem?.is_leaf).toBe(true);

    // ---- rename: the code is shown, never editable -------------------------
    await main.getByRole('button', { name: `Edit ${ITEM}` }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Rename' })).toBeVisible();
    await expect(dialog.getByLabel('item name')).toHaveValue(ITEM);
    await expect(dialog.locator('input')).toHaveCount(1);
    await dialog.getByLabel('item name').fill(RENAMED);
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(main.getByText(RENAMED)).toBeVisible();

    const { data: renamed } = await client
      .from('classifications')
      .select('code, name, level, parent_id')
      .eq('id', createdItem?.id ?? '')
      .single();
    // A rename changes the name and nothing else.
    expect(renamed?.name).toBe(RENAMED);
    expect(renamed?.code).toBe(createdItem?.code);
    expect(renamed?.level).toBe(3);
    expect(renamed?.parent_id).toBe(finishedGroup?.id);

    // ---- activate / deactivate --------------------------------------------
    await main.getByRole('button', { name: `Deactivate ${RENAMED}` }).click();
    await expect(main.getByRole('button', { name: `Activate ${RENAMED}` })).toBeVisible();
    const { data: disabled } = await client
      .from('classifications')
      .select('is_active')
      .eq('id', createdItem?.id ?? '')
      .single();
    expect(disabled?.is_active).toBe(false);

    await main.getByRole('button', { name: `Activate ${RENAMED}` }).click();
    await expect(main.getByRole('button', { name: `Deactivate ${RENAMED}` })).toBeVisible();

    // ---- delete is offered only for a childless node ----------------------
    await expect(main.getByRole('button', { name: `Delete ${CATEGORY}` })).toHaveCount(0);
    await expect(main.getByRole('button', { name: `Delete ${GROUP}` })).toHaveCount(0);
    await expect(main.getByRole('button', { name: `Delete ${RENAMED}` })).toBeVisible();

    // ---- unwind: item, then group, then category --------------------------
    for (const name of [RENAMED, GROUP, CATEGORY]) {
      await main.getByRole('button', { name: `Delete ${name}` }).click();
      const confirm = page.getByRole('dialog');
      await expect(confirm.getByRole('heading', { name: 'Delete item' })).toBeVisible();
      await confirm.getByRole('button', { name: 'Confirm delete' }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(main.getByText(name, { exact: true })).toHaveCount(0);
    }

    const { data: leftovers } = await client
      .from('classifications')
      .select('id')
      .in('name', [CATEGORY, GROUP, ITEM, RENAMED]);
    expect(leftovers).toEqual([]);
  });

  test('a category with children offers no delete, and the database refuses one anyway', async ({
    page,
  }) => {
    const main = await openClassificationsTab(page);

    // CLS-001 holds two groups: no delete affordance at all.
    await expect(main.getByRole('button', { name: 'Delete المواد والمستلزمات' })).toHaveCount(0);
    await expect(main.getByRole('button', { name: 'Edit المواد والمستلزمات' })).toBeVisible();

    /* The hidden button is the courtesy; ON DELETE RESTRICT is the guard. Bypass
       the UI entirely and ask the database to delete a parent: it must refuse
       with 23503, which the screen translates to the "has child items" copy. */
    const client = await ownerClient();
    const { data: parent } = await client
      .from('classifications')
      .select('id, name')
      .eq('code', 'CLS-001')
      .single();
    expect(parent?.id).toBeTruthy();

    const { error } = await client
      .from('classifications')
      .delete()
      .eq('id', parent?.id ?? '');
    expect(error).not.toBeNull();
    expect(error?.code).toBe('23503');

    // The row is still there, with its children.
    const { data: stillThere } = await client
      .from('classifications')
      .select('id')
      .eq('id', parent?.id ?? '');
    expect(stillThere).toHaveLength(1);
  });
});

test.describe('classifications authorization', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('an ordinary admin without project.settings:manage cannot write the tree', async () => {
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

    // Read is refused by RLS: the rows are filtered away rather than erroring.
    const { data: visible, error: readError } = await client
      .from('classifications')
      .select('id, code');
    expect(readError).toBeNull();
    expect(visible).toEqual([]);

    // Writes are refused at the table level with 42501.
    const { error: insertError } = await client
      .from('classifications')
      .insert({ name: 'فئة ممنوعة' })
      .select('id');
    expect(insertError?.code).toBe('42501');

    /* Under RLS an UPDATE/DELETE the caller cannot see raises no error — the
       policy simply matches zero rows. The affected-row count is what proves
       nothing changed. */
    const { data: updated, error: updateError } = await client
      .from('classifications')
      .update({ name: 'اسم ممنوع' })
      .eq('code', 'CLS-001')
      .select('id');
    expect(updateError).toBeNull();
    expect(updated).toEqual([]);

    const { data: deleted, error: deleteError } = await client
      .from('classifications')
      .delete()
      .eq('code', 'CLS-006')
      .select('id');
    expect(deleteError).toBeNull();
    expect(deleted).toEqual([]);
  });
});
