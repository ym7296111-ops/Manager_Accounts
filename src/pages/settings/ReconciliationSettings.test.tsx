import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nContext';
import ReconciliationSettings from './ReconciliationSettings';

const { getClient } = vi.hoisted(() => ({ getClient: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ getSupabase: getClient }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ session: { user: { id: 'test-user' } } }),
}));
let selected: string[];
let failRead: boolean;
let rpc: ReturnType<typeof vi.fn>;
const classes = [
  { id: 'root', name: 'الفرع', parent_id: null, is_leaf: false, is_active: true },
  { id: 'leaf', name: 'الورقة', parent_id: 'root', is_leaf: true, is_active: true },
  { id: 'inactive', name: 'قديمة', parent_id: 'root', is_leaf: true, is_active: false },
];
function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider defaultLocale="ar">
        <ReconciliationSettings />
      </I18nProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  selected = [];
  failRead = false;
  rpc = vi.fn(async (name: string, args?: { p_classifications: string[] }) => {
    await Promise.resolve();
    if (name === 'aps_get_reconciliation_settings_v2')
      return failRead
        ? { data: null, error: { code: 'network' } }
        : {
            data: { revision_id: 'revision', classifications: classes, selected: [...selected] },
            error: null,
          };
    if (name === 'aps_set_reconciliation_settings_v2') {
      selected = [...args!.p_classifications];
      return { data: 'revision2', error: null };
    }
    throw new Error(name);
  });
  getClient.mockReturnValue({
    rpc,
    from: () => {
      throw new Error('direct access');
    },
  });
  window.localStorage.clear();
});
describe('v2 reconciliation settings', () => {
  it('renders a hierarchy and prevents overlapping selections', async () => {
    mount();
    const root = await screen.findByRole('checkbox', { name: 'الفرع' }),
      leaf = screen.getByRole('checkbox', { name: 'الورقة' }),
      inactive = screen.getByRole('checkbox', { name: /قديمة/ });
    expect(inactive).toHaveProperty('disabled', true);
    fireEvent.click(root);
    expect(leaf).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('aps_set_reconciliation_settings_v2', {
        p_classifications: ['root'],
      }),
    );
    expect(await screen.findByText('تم حفظ الإعدادات والتحقق منها.')).toBeTruthy();
    expect(
      rpc.mock.calls.filter(([name]) => name === 'aps_get_reconciliation_settings_v2').length,
    ).toBeGreaterThan(1);
  });
  it('keeps selection when confirmation fails', async () => {
    mount();
    const root = await screen.findByRole('checkbox', { name: 'الفرع' });
    fireEvent.click(root);
    failRead = true;
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText(/تعذر حفظ الإعدادات أو تأكيدها/)).toBeTruthy();
    expect(root).toHaveProperty('checked', true);
  });
});
