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

    fireEvent.click(screen.getByRole('tab', { name: 'Opening balances' }));
    await screen.findByRole('button', { name: 'Show warehouses for المحطة الرئيسية' });
    fireEvent.click(screen.getByRole('button', { name: 'Show warehouses for المحطة الرئيسية' }));
    await screen.findByRole('button', {
      name: 'Show classifications for مخزن المواد الخام',
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Show classifications for مخزن المواد الخام' }),
    );
    const balanceInput = screen.getByRole('spinbutton', {
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
      .select('month_number, current_period')
      .eq('fiscal_year_id', year!.id);
    expect(monthError).toBeNull();
    expect(monthRows as { month_number: number }[]).toHaveLength(12);
    expect(
      (monthRows as { month_number: number; current_period: number }[])[0]?.current_period,
    ).toBe(4);

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
});
