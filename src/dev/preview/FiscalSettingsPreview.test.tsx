import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SupabaseModule from '@/lib/supabase';
import { I18nProvider } from '@/i18n/I18nContext';
import FiscalSettings from '@/pages/settings/FiscalSettings';
import { getSupabase as getPreviewSupabase } from './memorySupabase';

vi.mock('@/lib/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof SupabaseModule>();
  const preview = await import('./memorySupabase');
  return { ...actual, getSupabase: preview.getSupabase };
});

function renderPreviewFiscalSettings() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider defaultLocale="en">
        <FiscalSettings />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('fiscal settings with the preview-only Supabase stand-in', () => {
  it('creates and activates a year, updates its period, and upserts opening balances', async () => {
    renderPreviewFiscalSettings();

    const yearTable = await screen.findByRole('table');
    await within(yearTable).findByRole('button', { name: 'Show months for 2025-2026' });
    fireEvent.click(screen.getByRole('button', { name: 'Add fiscal year' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(screen.getByLabelText('Start date'), { target: { value: '2035-07-01' } });
    fireEvent.change(screen.getByLabelText('End date'), { target: { value: '2036-06-30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save fiscal year' }));

    await within(yearTable).findByRole('button', { name: 'Show months for 2035-2036' });
    await waitFor(() => expect(screen.getAllByTestId('fiscal-month-row')).toHaveLength(12));
    expect(dialog.isConnected).toBe(false);

    fireEvent.click(within(yearTable).getByRole('button', { name: 'Activate 2035-2036' }));
    await within(yearTable).findByText('Current', { exact: true });

    fireEvent.click(screen.getByRole('tab', { name: 'Period settings' }));
    await screen.findByText('We are now in period 1 of July 2035.');
    fireEvent.change(screen.getByLabelText('Current period'), { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save period' }));
    await screen.findByText('We are now in period 4 of July 2035.');

    fireEvent.click(screen.getByRole('button', { name: 'Activate July 2035' }));
    await screen.findByText('The month is now the project posting period.');
    fireEvent.click(screen.getByRole('button', { name: 'Activate August 2035' }));
    await waitFor(() => {
      const activeRows = screen
        .getAllByTestId('fiscal-period-month')
        .filter((row) => row.getAttribute('data-active') === 'true');
      expect(activeRows).toHaveLength(1);
      expect(
        within(activeRows[0]!).getByRole('button', { name: 'Activate August 2035' }),
      ).toHaveProperty('disabled', true);
    });

    fireEvent.click(screen.getByRole('tab', { name: 'Opening balances' }));
    await screen.findByRole('button', { name: 'Show warehouses for المحطة الرئيسية' });
    fireEvent.click(screen.getByRole('button', { name: 'Show warehouses for المحطة الرئيسية' }));
    await screen.findByRole('button', {
      name: 'Show classifications for مخزن المواد الخام',
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Show classifications for مخزن المواد الخام' }),
    );
    /* The new year starts empty, so the editor renders no amount inputs at all
       until a classification is explicitly added. */
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Add classification' }));
    const picker = screen.getByTestId('classification-picker');
    fireEvent.click(within(picker).getByRole('option', { name: /حديد وصلب/ }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Add (1)' }));

    const balanceInput = await screen.findByRole('spinbutton', {
      name: /Opening balance: .*حديد وصلب/,
    });
    fireEvent.change(balanceInput, { target: { value: '125.50' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save balances for مخزن المواد الخام' }));
    await screen.findByText('Warehouse balances saved successfully.');

    const { data: yearRows, error: yearError } = await getPreviewSupabase()
      .from('fiscal_years')
      .select('id, name, is_active')
      .eq('name', '2035-2036');
    expect(yearError).toBeNull();
    const year = (yearRows as { id: string; is_active: boolean }[])[0];
    expect(year?.is_active).toBe(true);

    const { data: monthRows, error: monthError } = await getPreviewSupabase()
      .from('fiscal_months')
      .select('month_number, current_period, is_active')
      .eq('fiscal_year_id', year!.id);
    expect(monthError).toBeNull();
    expect(monthRows as { month_number: number }[]).toHaveLength(12);
    expect(
      (monthRows as { month_number: number; current_period: number }[])[0]?.current_period,
    ).toBe(4);
    expect(
      (monthRows as { month_number: number; is_active: boolean }[])
        .filter((month) => month.is_active)
        .map((month) => month.month_number),
    ).toEqual([2]);

    const { data: activeRows, error: activeError } = await getPreviewSupabase()
      .from('fiscal_months')
      .select('id')
      .eq('is_active', true);
    expect(activeError).toBeNull();
    expect(activeRows).toHaveLength(1);
    const { error: directWriteError } = await getPreviewSupabase()
      .from('fiscal_months')
      .update({ is_active: true })
      .eq('month_number', 1);
    expect(directWriteError).toMatchObject({ code: '42501' });

    const { data: balanceRows, error: balanceError } = await getPreviewSupabase()
      .from('opening_balances')
      .select('fiscal_year_id, warehouse_id, classification_id, amount')
      .eq('fiscal_year_id', year!.id);
    expect(balanceError).toBeNull();
    expect(balanceRows).toMatchObject([
      {
        fiscal_year_id: year!.id,
        warehouse_id: 'w-1',
        classification_id: 'i-steel',
        amount: 125.5,
      },
    ]);
  });

  /*
   * The stand-in reproduces the freeze as well, so the preview cannot show an
   * editable tree for a year the real RLS policy would refuse. This runs
   * against `memorySupabase`, not mocks: the switch, the hook and the fake
   * PostgREST handler are all the same code the review build runs.
   */
  it('freezes the active year through the switch and refuses writes in the stand-in', async () => {
    const client = getPreviewSupabase();
    const { data: yearRows, error: yearError } = await client
      .from('fiscal_years')
      .select('id, name, is_active, opening_balances_locked')
      .eq('is_active', true);
    expect(yearError).toBeNull();
    const activeYear = (
      yearRows as { id: string; name: string; opening_balances_locked: boolean }[]
    )[0];
    expect(activeYear?.opening_balances_locked).toBe(false);

    renderPreviewFiscalSettings();
    fireEvent.click(await screen.findByRole('tab', { name: 'Opening balances' }));
    const lockSwitch = await screen.findByRole('switch');
    expect(lockSwitch.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(lockSwitch);
    fireEvent.click(screen.getByRole('button', { name: 'Lock balances' }));

    await screen.findByText('Opening balances are now locked.');
    expect(
      screen.getByRole('switch').getAttribute('aria-checked'),
      'The switch follows the row the database returned.',
    ).toBe('true');

    const { data: lockedRows, error: lockedError } = await client
      .from('fiscal_years')
      .select('opening_balances_locked')
      .eq('id', activeYear!.id);
    expect(lockedError).toBeNull();
    expect(lockedRows).toMatchObject([{ opening_balances_locked: true }]);

    /* A write that bypassed the disabled UI would still be refused. */
    const { error: frozenWriteError } = await client.from('opening_balances').upsert([
      {
        fiscal_year_id: activeYear!.id,
        warehouse_id: 'w-1',
        classification_id: 'i-wood',
        amount: '9.99',
      },
    ]);
    expect(frozenWriteError).toEqual(expect.objectContaining({ code: '42501' }));

    /* The other direction: reopen, and the same write succeeds. */
    fireEvent.click(screen.getByRole('switch'));
    fireEvent.click(screen.getByRole('button', { name: 'Unlock balances' }));
    await screen.findByText('Opening balances are open for editing again.');

    const { error: reopenedWriteError } = await client.from('opening_balances').upsert([
      {
        fiscal_year_id: activeYear!.id,
        warehouse_id: 'w-1',
        classification_id: 'i-wood',
        amount: '9.99',
      },
    ]);
    expect(reopenedWriteError).toBeNull();
  });
});
