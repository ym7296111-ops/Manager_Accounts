import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nContext';
import { ApsEntryError } from '@/hooks/useApsLetterEntry';
import type { EntryForm, EntryOptions } from '@/lib/apsLetterEntry';
import ApsLetterEntryPage from './ApsLetterEntryPage';

type HookState = { isPending: boolean; isError: boolean; data: EntryOptions | null };

const { hooks, save, approve } = vi.hoisted<{
  hooks: { options: HookState; draft: HookState };
  save: ReturnType<typeof vi.fn>;
  approve: ReturnType<typeof vi.fn>;
}>(() => {
  const empty = (): HookState => ({ isPending: false, isError: false, data: null });
  return {
    hooks: { options: empty(), draft: empty() },
    save: vi.fn(),
    approve: vi.fn(),
  };
});

vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ session: { user: { id: '00000000-0000-4000-8000-000000000001' } } }),
}));
vi.mock('@/hooks/useApsLetterEntry', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@/hooks/useApsLetterEntry');
  return {
    ...actual,
    useEntryOptions: () => hooks.options,
    useEntryDraft: () => hooks.draft,
    saveEntryDraft: save,
    approveEntryLetter: approve,
  };
});

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const options: EntryOptions = {
  years: [
    {
      id: id(400),
      name: '2026',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      active: true,
      closed: false,
      supplementsOpen: false,
    },
  ],
  warehouses: [{ id: id(100), name: 'المخزن الرئيسي', code: 'WH-001' }],
  classifications: [
    { id: id(201), name: 'حديد', code: 'CL-001' },
    { id: id(202), name: 'تشغيل', code: 'CL-002' },
  ],
  parties: [{ id: id(501), name: 'شركة النيل', code: 'IN-014', branch: 'inbound' }],
  sisters: [{ id: id(601), name: 'الشقيقة', code: 'SIS-001' }],
};

function mount() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <I18nProvider defaultLocale="ar">
        <MemoryRouter initialEntries={['/workspaces/aps/letters/new']}>
          <ApsLetterEntryPage />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

function choose(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

function fillInbound() {
  fireEvent.click(screen.getByRole('button', { name: /^وارد/ }));
  fireEvent.change(screen.getByLabelText('تاريخ الخطاب'), { target: { value: '2026-03-04' } });
  fireEvent.change(screen.getByLabelText('رقم الخطاب'), { target: { value: '2458' } });
  choose('جهة الوارد', id(501));
  choose('المخزن', id(100));
  choose('التصنيف', id(201));
  fireEvent.change(screen.getByLabelText('القيمة'), { target: { value: '١٢٠٫٥٠' } });
}

describe('APS letter entry screen', () => {
  beforeEach(() => {
    hooks.options = { isPending: false, isError: false, data: options };
    hooks.draft = { isPending: false, isError: false, data: null };
    save.mockReset().mockResolvedValue({ id: id(900), updatedAt: '2026-03-04T10:00:00Z' });
    approve.mockReset().mockResolvedValue(undefined);
    window.localStorage.clear();
  });

  it('offers exactly the four ordinary types and saves an exact inbound draft', async () => {
    mount();
    for (const name of ['وارد', 'منصرف', 'تحويل داخلي', 'تحويل خارجي']) {
      expect(screen.getByRole('button', { name: new RegExp(name) })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: /تسوية/ })).toBeNull();
    fillInbound();
    expect(screen.getByText('١٢٠٫٥٠')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ كمسودة' }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const [, version, form] = save.mock.calls[0] as [string, string | null, EntryForm];
    expect(version).toBeNull();
    expect(form).toMatchObject({ type: 'inbound', number: '2458', partyId: id(501) });
    expect(await screen.findByText(/حُفظت المسودة بنجاح/)).toBeTruthy();
    expect(approve).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'حفظ التعديلات' })).toBeTruthy();
  });

  it('validates before any request and keeps the reason rule for reclassification', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'اعتماد الخطاب' }));
    expect(await screen.findByText(/أدخل رقم خطاب صحيحاً/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /تحويل داخلي/ }));
    fireEvent.change(screen.getByLabelText('تاريخ الخطاب'), { target: { value: '2026-03-04' } });
    fireEvent.change(screen.getByLabelText('رقم الخطاب'), { target: { value: '90' } });
    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBeGreaterThanOrEqual(4);
    choose('المصدر — المخزن', id(100));
    choose('المصدر — التصنيف', id(201));
    choose('الوجهة — المخزن', id(100));
    choose('الوجهة — التصنيف', id(202));
    fireEvent.change(screen.getByLabelText('قيمة الزوج'), { target: { value: '10' } });
    expect(await screen.findByLabelText(/سبب إعادة التصنيف/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'اعتماد الخطاب' }));
    expect(await screen.findByText(/أدخل سبب إعادة التصنيف/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/سبب إعادة التصنيف/), {
      target: { value: 'إعادة تصنيف أثناء النقل' },
    });
    save.mockResolvedValue({ id: id(901), updatedAt: '2026-03-04T10:00:00Z' });
    fireEvent.click(screen.getByRole('button', { name: 'اعتماد الخطاب' }));
    await waitFor(() => expect(approve).toHaveBeenCalledWith(save.mock.calls[0]![0]));
    expect(await screen.findByText('تم اعتماد الخطاب بنجاح.')).toBeTruthy();
  });

  it('reports a duplicate number without losing the entered data', async () => {
    save.mockRejectedValue(new ApsEntryError('duplicate'));
    mount();
    fillInbound();
    fireEvent.click(screen.getByRole('button', { name: 'حفظ كمسودة' }));
    expect(await screen.findByText(/رقم الخطاب مستخدم بالفعل/)).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('رقم الخطاب').value).toBe('2458');
    expect(screen.getByLabelText<HTMLInputElement>('القيمة').value).toBe('١٢٠٫٥٠');
  });

  it('keeps the saved draft and warns when approval fails afterwards', async () => {
    approve.mockRejectedValue(new ApsEntryError('invalid'));
    mount();
    fillInbound();
    fireEvent.click(screen.getByRole('button', { name: 'اعتماد الخطاب' }));
    await waitFor(() => expect(approve).toHaveBeenCalled());
    expect(await screen.findByText(/حُفظت المسودة، لكن تعذّر اعتمادها/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'عرض المسودة' })).toBeTruthy();
    expect(screen.queryByText('تم اعتماد الخطاب بنجاح.')).toBeNull();
  });

  it('shows the server refusal on a load error and offers a retry', () => {
    hooks.options = { isPending: false, isError: true, data: null };
    mount();
    expect(screen.getByRole('alert').textContent).toContain('تعذّر تحميل بيانات الإدخال');
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeTruthy();
  });
});
