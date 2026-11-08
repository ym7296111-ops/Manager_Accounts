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
let rpc: ReturnType<
  typeof vi.fn<(name: string, args?: Record<string, unknown>) => Promise<unknown>>
>;
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
  rpc = vi.fn(async (name: string, args?: Record<string, unknown>) => {
    await Promise.resolve();
    if (name === 'aps_get_reconciliation_scopes_v3')
      return {
        data: [{ id: 'scope', name: 'النطاق', is_default: true, is_active: true }],
        error: null,
      };
    if (name === 'aps_get_reconciliation_settings_v3')
      return failRead
        ? { data: null, error: { code: 'network' } }
        : {
            data: {
              scope_id: 'scope',
              revision_id: 'revision',
              classifications: classes,
              selected: [...selected],
            },
            error: null,
          };
    if (name === 'aps_set_reconciliation_settings_v3') {
      selected = [...(args!.p_classifications as string[])];
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
describe('v3 reconciliation settings', () => {
  it('renders a hierarchy and prevents overlapping selections', async () => {
    mount();
    const root = await screen.findByRole('checkbox', { name: 'الفرع' }),
      leaf = screen.getByRole('checkbox', { name: 'الورقة' }),
      inactive = screen.getByRole('checkbox', { name: /قديمة/ });
    expect(inactive).toHaveProperty('disabled', true);
    expect(root).toHaveProperty('disabled', true);
    fireEvent.click(leaf);
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('aps_set_reconciliation_settings_v3', {
        p_scope_id: 'scope',
        p_expected_revision: 'revision',
        p_classifications: ['leaf'],
      }),
    );
    expect(await screen.findByText('تم حفظ الإعدادات والتحقق منها.')).toBeTruthy();
    expect(
      rpc.mock.calls.filter(([name]) => name === 'aps_get_reconciliation_settings_v3').length,
    ).toBeGreaterThan(1);
  });
  it('keeps selection when confirmation fails', async () => {
    mount();
    const root = await screen.findByRole('checkbox', { name: 'الورقة' });
    fireEvent.click(root);
    failRead = true;
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText(/تتداخل التصنيفات/)).toBeTruthy();
    expect(root).toHaveProperty('checked', true);
  });
});

describe('v3 scope management', () => {
  it('creates, renames and archives scopes via RPC', async () => {
    const scopes = [
      { id: 'scope', name: 'النطاق', is_default: true, is_active: true },
      { id: 'second', name: 'آخر', is_default: false, is_active: true },
    ];
    rpc.mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
      await Promise.resolve();
      if (name === 'aps_get_reconciliation_scopes_v3')
        return { data: structuredClone(scopes), error: null };
      if (name === 'aps_get_reconciliation_settings_v3')
        return {
          data: {
            scope_id: args.p_scope_id,
            revision_id: 'revision',
            classifications: classes,
            selected: [],
          },
          error: null,
        };
      if (name === 'aps_create_reconciliation_scope_v3') {
        scopes.push({
          id: 'third',
          name: args.p_name as string,
          is_default: false,
          is_active: true,
        });
        return { data: 'third', error: null };
      }
      if (name === 'aps_rename_reconciliation_scope_v3') {
        scopes[1]!.name = args.p_name as string;
        return { data: null, error: null };
      }
      if (name === 'aps_archive_reconciliation_scope_v3') {
        scopes[1]!.is_active = false;
        return { data: null, error: null };
      }
      throw new Error(name);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount();
    const select = await screen.findByLabelText('النطاق');
    const name = screen.getByLabelText('اسم النطاق');
    fireEvent.change(name, { target: { value: 'جديد' } });
    fireEvent.click(screen.getByRole('button', { name: 'إضافة نطاق' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('aps_create_reconciliation_scope_v3', { p_name: 'جديد' }),
    );
    await screen.findByRole('option', { name: 'جديد' });
    fireEvent.change(select, { target: { value: 'second' } });
    fireEvent.change(name, { target: { value: 'معدل' } });
    fireEvent.click(screen.getByRole('button', { name: 'تعديل الاسم' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('aps_rename_reconciliation_scope_v3', {
        p_scope_id: 'second',
        p_name: 'معدل',
      }),
    );
    await screen.findByRole('option', { name: 'معدل' });
    fireEvent.click(screen.getByRole('button', { name: 'أرشفة النطاق' }));
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith('aps_archive_reconciliation_scope_v3', {
        p_scope_id: 'second',
      }),
    );
    await screen.findByRole('option', { name: 'معدل (مؤرشف)' });
  });
  it('preserves legacy branch selections and disables leaves owned by another scope', async () => {
    rpc.mockImplementation(async (name: string, args: Record<string, unknown> = {}) => {
      await Promise.resolve();
      if (name === 'aps_get_reconciliation_scopes_v3')
        return {
          data: [
            { id: 'scope', name: 'النطاق', is_default: true, is_active: true },
            { id: 'other', name: 'آخر', is_default: false, is_active: true },
          ],
          error: null,
        };
      if (name === 'aps_get_reconciliation_settings_v3')
        return {
          data: {
            scope_id: args.p_scope_id,
            revision_id: 'revision',
            classifications: classes,
            selected: args.p_scope_id === 'scope' ? ['root'] : ['leaf'],
          },
          error: null,
        };
      throw new Error(name);
    });
    mount();
    const root = await screen.findByRole('checkbox', { name: 'الفرع' });
    expect(root).toHaveProperty('checked', true);
    expect(screen.getByRole('checkbox', { name: /الورقة/ })).toHaveProperty('disabled', true);
    expect(screen.getByText(/لن تتحول لأوراق تلقائياً/)).toBeTruthy();
    expect(rpc.mock.calls.some(([name]) => name === 'aps_set_reconciliation_settings_v3')).toBe(
      false,
    );
  });
  it('keeps dirty selections on a concurrency error', async () => {
    const original = rpc.getMockImplementation() as (
      name: string,
      args?: Record<string, unknown>,
    ) => Promise<unknown>;
    rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) =>
      name === 'aps_set_reconciliation_settings_v3'
        ? { data: null, error: { code: '40001' } }
        : original(name, args),
    );
    mount();
    const leaf = await screen.findByRole('checkbox', { name: 'الورقة' });
    fireEvent.click(leaf);
    fireEvent.click(screen.getByRole('button', { name: 'حفظ' }));
    expect(await screen.findByText(/تتداخل التصنيفات/)).toBeTruthy();
    expect(leaf).toHaveProperty('checked', true);
  });
});
