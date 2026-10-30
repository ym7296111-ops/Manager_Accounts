import {
  Ban,
  CheckCircle2,
  KeyRound,
  Loader2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  X,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusIcon } from '@/components/ui/StatusIcon';
import {
  classifyIssuersError,
  useIssuers,
  type Issuer,
  type IssuersErrorCode,
} from '@/hooks/useIssuers';
import {
  classifyIssuerWriteError,
  useCreateIssuer,
  useRenameIssuer,
  useSetIssuerActive,
  type IssuerWriteErrorCode,
  type IssuerWriteOperation,
} from '@/hooks/useIssuerMutations';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import { issuerLabel } from '@/lib/issuers';
import { IssuerFormDialog, type IssuerFormMode } from './IssuerDialogs';

/**
 * Issuers — the controlled list behind «كود الخطاب» on the entry screen.
 *
 * Three columns and three verbs, nothing else:
 *
 *   الكود      two Latin letters, typed once, rendered as plain text on edit
 *   الاسم      optional free text; the only editable field
 *   الحالة     active / disabled
 *
 * * add       → `{ code, name }`; a duplicate code is refused by
 *               `issuers_code_upper_key` and classified as `duplicate`
 * * rename    → `{ name }`; the code is never sent, so it cannot change
 * * toggle    → `{ is_active }`; disabling is the alternative to deletion,
 *               because `letters.issuer_code` references the row
 *
 * There is no delete button: the table grants `select, insert, update` only,
 * and a letter that was printed with `YM:63` must keep meaning ياسر.
 *
 * Authorization is `project.settings:manage`, enforced by RLS. The whole screen
 * is already behind `RequireCapability` in `ProjectSettings`; a denied read is
 * still classified so the panel explains itself rather than looking empty.
 */

const READ_ERROR_KEY: Record<IssuersErrorCode, TranslationKey> = {
  forbidden: 'settings.project.issuers.error.forbidden',
  unavailable: 'settings.project.issuers.error.unavailable',
  network: 'settings.project.issuers.error.network',
  unknown: 'settings.project.issuers.error.unknown',
};

const WRITE_ERROR_KEY: Record<IssuerWriteErrorCode, TranslationKey> = {
  forbidden: 'settings.project.issuers.writeError.forbidden',
  unavailable: 'settings.project.issuers.writeError.unavailable',
  network: 'settings.project.issuers.writeError.network',
  validation: 'settings.project.issuers.writeError.validation',
  duplicate: 'settings.project.issuers.writeError.duplicate',
  notFound: 'settings.project.issuers.writeError.notFound',
  unknown: 'settings.project.issuers.writeError.unknown',
};

const ADD_BUTTON_CLASS =
  'text-primary border-border hover:bg-muted/40 inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';

const ACTION_CLASS =
  'text-muted-foreground hover:text-foreground hover:bg-muted/60 focus-visible:ring-ring inline-grid size-8 shrink-0 place-items-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';

interface Banner {
  readonly tone: 'error' | 'success';
  readonly key: TranslationKey;
}

interface FormTarget {
  readonly mode: IssuerFormMode;
  readonly issuer?: Issuer;
}

function IssuerStatus({ isActive }: { readonly isActive: boolean }) {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusIcon
        active={isActive}
        label={t(
          isActive
            ? 'settings.project.issuers.status.active'
            : 'settings.project.issuers.status.inactive',
        )}
      />
      {/* The icon carries the state on a narrow screen; the word stays in the
          accessible name rather than widening the row. */}
      <span
        className={`text-xs font-semibold max-sm:sr-only ${
          isActive ? 'text-success' : 'text-muted-foreground'
        }`}
      >
        {t(
          isActive
            ? 'settings.project.issuers.status.active'
            : 'settings.project.issuers.status.inactive',
        )}
      </span>
    </span>
  );
}

export default function IssuersSettings() {
  const { t } = useI18n();
  const query = useIssuers();

  const createIssuer = useCreateIssuer();
  const renameIssuer = useRenameIssuer();
  const toggleIssuer = useSetIssuerActive();

  const [form, setForm] = useState<FormTarget | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const busy = createIssuer.isPending || renameIssuer.isPending || toggleIssuer.isPending;

  const failWith = useCallback((error: unknown, operation: IssuerWriteOperation) => {
    setBanner({
      tone: 'error',
      key: WRITE_ERROR_KEY[classifyIssuerWriteError(error, operation)],
    });
  }, []);

  const succeedWith = useCallback((key: TranslationKey) => {
    setForm(null);
    setBanner({ tone: 'success', key });
  }, []);

  function submitForm(values: { readonly code: string; readonly name: string }) {
    if (form === null) {
      return;
    }
    setBanner(null);

    if (form.mode === 'create') {
      createIssuer.mutate(values, {
        onSuccess: () => succeedWith('settings.project.issuers.success.added'),
        onError: (error) => failWith(error, 'create'),
      });
      return;
    }

    const issuer = form.issuer;
    if (issuer === undefined) {
      return;
    }
    renameIssuer.mutate(
      { id: issuer.id, code: issuer.code, name: values.name },
      {
        onSuccess: () => succeedWith('settings.project.issuers.success.renamed'),
        onError: (error) => failWith(error, 'rename'),
      },
    );
  }

  function toggleActive(issuer: Issuer) {
    setBanner(null);
    toggleIssuer.mutate(
      { id: issuer.id, isActive: !issuer.isActive },
      {
        onSuccess: () =>
          setBanner({
            tone: 'success',
            key: issuer.isActive
              ? 'settings.project.issuers.success.deactivated'
              : 'settings.project.issuers.success.activated',
          }),
        onError: (error) => failWith(error, 'toggle'),
      },
    );
  }

  if (query.isLoading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t('settings.project.issuers.loading')}
      </div>
    );
  }

  const readErrorKey = query.isError ? READ_ERROR_KEY[classifyIssuersError(query.error)] : null;
  const issuers = query.data ?? [];

  return (
    <section aria-labelledby="issuers-heading" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 id="issuers-heading" className="text-foreground text-sm font-semibold">
            {t('settings.project.issuers.heading')}
          </h3>
          <p className="text-muted-foreground max-w-xl text-xs leading-relaxed">
            {t('settings.project.issuers.description')}
          </p>
        </div>
        {readErrorKey === null ? (
          <button
            type="button"
            onClick={() => {
              setBanner(null);
              setForm({ mode: 'create' });
            }}
            disabled={busy}
            className={ADD_BUTTON_CLASS}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t('settings.project.issuers.add')}
          </button>
        ) : null}
      </div>

      {banner !== null ? (
        <div
          role="alert"
          className={
            banner.tone === 'error'
              ? 'border-destructive/40 bg-destructive/5 text-destructive flex items-start gap-3 rounded-xl border px-4 py-3 text-sm'
              : 'border-success/40 bg-success/5 text-success flex items-start gap-3 rounded-xl border px-4 py-3 text-sm'
          }
        >
          {banner.tone === 'error' ? (
            <Ban className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          )}
          <span className="flex-1">{t(banner.key)}</span>
          <button
            type="button"
            onClick={() => setBanner(null)}
            aria-label={t('settings.project.issuers.dismiss')}
            className="shrink-0 opacity-70 hover:opacity-100"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {readErrorKey !== null ? (
        <div className="space-y-4">
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 text-destructive flex items-start gap-3 rounded-xl border px-4 py-3 text-sm"
          >
            <Ban className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{t(readErrorKey)}</span>
          </div>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="text-foreground border-border hover:bg-muted/40 inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-semibold transition-colors"
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {t('settings.project.issuers.retry')}
          </button>
        </div>
      ) : issuers.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title={t('settings.project.issuers.empty.title')}
          description={t('settings.project.issuers.empty.description')}
        />
      ) : (
        <div className="border-border w-full max-w-full min-w-0 overflow-x-auto rounded-xl border">
          <table className="w-full min-w-0 border-collapse text-start text-sm">
            <caption className="sr-only">{t('settings.project.issuers.heading')}</caption>
            <thead>
              <tr className="bg-muted/40 text-muted-foreground text-xs">
                <th scope="col" className="px-3 py-2 text-start font-semibold whitespace-nowrap">
                  {t('settings.project.issuers.column.code')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-semibold">
                  {t('settings.project.issuers.column.name')}
                </th>
                <th scope="col" className="px-3 py-2 text-start font-semibold whitespace-nowrap">
                  {t('settings.project.issuers.column.status')}
                </th>
                <th scope="col" className="px-3 py-2 text-end font-semibold">
                  <span className="sr-only">{t('settings.project.issuers.column.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {issuers.map((issuer) => (
                <tr
                  key={issuer.id}
                  className="border-border hover:bg-muted/25 border-t transition-colors"
                >
                  <th
                    scope="row"
                    className="text-foreground px-3 py-2 text-start align-middle font-mono text-sm font-semibold"
                  >
                    <span dir="ltr">{issuer.code}</span>
                  </th>
                  <td className="text-foreground max-w-[16rem] px-3 py-2 align-middle">
                    <span className="block truncate text-sm">{issuer.name}</span>
                  </td>
                  <td className="px-3 py-2 align-middle whitespace-nowrap">
                    <IssuerStatus isActive={issuer.isActive} />
                  </td>
                  <td className="px-3 py-2 align-middle">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setBanner(null);
                          setForm({ mode: 'edit', issuer });
                        }}
                        disabled={busy}
                        aria-label={`${t('settings.project.issuers.action.edit')} ${issuerLabel(issuer)}`}
                        className={ACTION_CLASS}
                      >
                        <Pencil className="size-3.5" aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleActive(issuer)}
                        disabled={busy}
                        aria-label={`${
                          issuer.isActive
                            ? t('settings.project.issuers.action.deactivate')
                            : t('settings.project.issuers.action.activate')
                        } ${issuerLabel(issuer)}`}
                        className={ACTION_CLASS}
                      >
                        <Power className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {form !== null ? (
        <IssuerFormDialog
          mode={form.mode}
          code={form.issuer?.code}
          initialName={form.issuer?.name}
          busy={busy}
          onSubmit={submitForm}
          onClose={() => setForm(null)}
        />
      ) : null}
    </section>
  );
}
