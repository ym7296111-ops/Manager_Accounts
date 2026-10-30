import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as IssuersModule from '@/hooks/useIssuers';
import { IssuersError, type Issuer } from '@/hooks/useIssuers';
import type * as IssuerMutationsModule from '@/hooks/useIssuerMutations';
import { IssuerWriteError } from '@/hooks/useIssuerMutations';
import { I18nProvider } from '@/i18n/I18nContext';
import IssuersSettings from '@/pages/settings/IssuersSettings';

interface QueryStub {
  isLoading: boolean;
  isError: boolean;
  data: readonly Issuer[] | undefined;
  error: unknown;
  refetch: ReturnType<typeof vi.fn>;
}

interface MutationStub {
  mutate: ReturnType<typeof vi.fn>;
  isPending: boolean;
}

const { queryState, mutations } = vi.hoisted(() => {
  const make = (): MutationStub => ({ mutate: vi.fn(), isPending: false });
  return {
    queryState: { value: null as unknown as QueryStub },
    mutations: { create: make(), rename: make(), toggle: make() },
  };
});

vi.mock('@/hooks/useIssuers', async (importOriginal) => {
  const actual = await importOriginal<typeof IssuersModule>();
  return { ...actual, useIssuers: () => queryState.value };
});

vi.mock('@/hooks/useIssuerMutations', async (importOriginal) => {
  const actual = await importOriginal<typeof IssuerMutationsModule>();
  return {
    ...actual,
    useCreateIssuer: () => mutations.create,
    useRenameIssuer: () => mutations.rename,
    useSetIssuerActive: () => mutations.toggle,
  };
});

const ISSUERS: readonly Issuer[] = [
  { id: 'i1', code: 'YM', name: 'ياسر', isActive: true },
  { id: 'i2', code: 'AA', name: 'أحمد عبد الله', isActive: false },
];

function mount() {
  return render(
    <I18nProvider defaultLocale="ar">
      <IssuersSettings />
    </I18nProvider>,
  );
}

function query(patch: Partial<QueryStub> = {}) {
  queryState.value = {
    isLoading: false,
    isError: false,
    data: ISSUERS,
    error: null,
    refetch: vi.fn(),
    ...patch,
  };
}

beforeEach(() => {
  query();
  for (const stub of Object.values(mutations)) {
    stub.mutate.mockReset();
    stub.isPending = false;
  }
});

describe('IssuersSettings', () => {
  it('lists the register as a table of code, name and status', () => {
    mount();

    const table = screen.getByRole('table');
    // The code is the row header: it is the identity of the record.
    expect(within(table).getByRole('rowheader', { name: 'YM' })).toBeTruthy();
    expect(within(table).getByText('ياسر')).toBeTruthy();
    expect(within(table).getByText('أحمد عبد الله')).toBeTruthy();
    expect(within(table).getAllByText('نشط')).toHaveLength(2);
    expect(within(table).getAllByText('معطّل')).toHaveLength(2);
    // There is no delete verb anywhere: a used code is deactivated instead.
    expect(screen.queryByRole('button', { name: /حذف/ })).toBeNull();
  });

  it('adds a code from a dialog that asks for two letters and an optional name', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'إضافة كود جديد' }));

    const dialog = screen.getByRole('dialog');
    const code = within(dialog).getByLabelText('الحرفان (مثال: YM)');

    // Only Latin letters survive the field, up-cased.
    fireEvent.change(code, { target: { value: 'ab' } });
    expect((code as HTMLInputElement).value).toBe('AB');
    fireEvent.change(within(dialog).getByLabelText('الاسم / الوصف (اختياري)'), {
      target: { value: ' أحمد ' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.create.mutate).toHaveBeenCalledWith(
      { code: 'AB', name: 'أحمد' },
      expect.anything(),
    );
    expect(mutations.rename.mutate).not.toHaveBeenCalled();
  });

  it('refuses to submit a code that is not two letters', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'إضافة كود جديد' }));
    const dialog = screen.getByRole('dialog');

    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(within(dialog).getByText('أدخل الحرفين الإنجليزيين للكود.')).toBeTruthy();
    expect(mutations.create.mutate).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('الحرفان (مثال: YM)'), {
      target: { value: 'y' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));
    expect(within(dialog).getByText('الكود حرفان إنجليزيان فقط، مثل YM.')).toBeTruthy();
    expect(mutations.create.mutate).not.toHaveBeenCalled();
  });

  it('renames the name only, with the two letters shown read-only', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'تعديل اسم YM — ياسر' }));

    const dialog = screen.getByRole('dialog');
    // The code is printed as plain text, not as an editable field.
    expect(within(dialog).getByText('YM')).toBeTruthy();
    expect(within(dialog).queryByLabelText('الحرفان (مثال: YM)')).toBeNull();
    expect(within(dialog).getByText(/هوية الكود ولا يقبلان التعديل/)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('الاسم / الوصف (اختياري)'), {
      target: { value: 'ياسر عبد الله' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    expect(mutations.rename.mutate).toHaveBeenCalledWith(
      { id: 'i1', code: 'YM', name: 'ياسر عبد الله' },
      expect.anything(),
    );
  });

  it('toggles a code instead of deleting it', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'تعطيل YM — ياسر' }));
    expect(mutations.toggle.mutate).toHaveBeenCalledWith(
      { id: 'i1', isActive: false },
      expect.anything(),
    );

    fireEvent.click(screen.getByRole('button', { name: 'تفعيل AA — أحمد عبد الله' }));
    expect(mutations.toggle.mutate).toHaveBeenLastCalledWith(
      { id: 'i2', isActive: true },
      expect.anything(),
    );
  });

  it('reports a duplicate code with its own message', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'إضافة كود جديد' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('الحرفان (مثال: YM)'), {
      target: { value: 'ym' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'حفظ' }));

    const [, options] = mutations.create.mutate.mock.calls[0] as [
      unknown,
      { onError: (error: unknown) => void },
    ];
    act(() => options.onError(new IssuerWriteError('duplicate')));

    expect(screen.getByRole('alert').textContent).toContain('هذا الكود مسجل بالفعل');
  });

  it('explains a denied read instead of showing an empty register', () => {
    query({ isError: true, data: undefined, error: new IssuersError('forbidden') });
    mount();

    expect(screen.getByRole('alert').textContent).toContain('لا تملك صلاحية قراءة أكواد المُصدرين');
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeTruthy();
  });

  it('shows an empty state that points at the entry screen', () => {
    query({ data: [] });
    mount();

    expect(screen.getByText('لا توجد أكواد مُصدرين بعد')).toBeTruthy();
  });
});
