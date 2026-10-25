import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  CheckCircle2,
  Loader2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Trash2,
  Truck,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusIcon } from '@/components/ui/StatusIcon';
import {
  classifyPartiesError,
  useParties,
  type PartiesErrorCode,
  type Party,
} from '@/hooks/useParties';
import {
  classifyPartyWriteError,
  useCreateParty,
  useDeleteParty,
  useSetPartyActive,
  useUpdateParty,
  type PartyWriteErrorCode,
  type PartyWriteOperation,
} from '@/hooks/usePartiesMutations';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import type { PartyType } from '@/lib/database.types';
import {
  isInboundPartyType,
  partyTypesForScope,
  type PartyFormValues,
  type PartyScope,
} from '@/lib/partyValidation';
import { PartyDeleteDialog, PartyFormDialog } from './PartyDialogs';

/**
 * Inbound and outbound counterparties — one flat read, two tables.
 *
 * The directory is a single request (`useParties`) of a few dozen rows. The
 * inbound sub-tab shows the two supplier kinds, the outbound sub-tab shows
 * customers; the split runs on the client because the whole directory is
 * already in memory, exactly as the schema was designed for.
 *
 * Every mutation invalidates the directory so the table re-renders from the
 * database rather than from optimistic local state. Codes are never sent
 * (per-type sequences mint `LOC-###` / `FRN-###` / `CUS-###` server-side) and
 * `type` travels exactly once, on create — the payload builders in
 * `usePartiesMutations` enforce both, and the trigger refuses any later change
 * with 22023.
 *
 * The create dialog receives `partyTypesForScope(scope)`; the outbound tab can
 * therefore only ever create a customer, and the inbound tab a supplier of one
 * of the two kinds.
 *
 * Authorization is the database's. `RequireCapability` on the route reads a
 * capability snapshot that can disagree with a live revoked or delegated
 * grant, so both the read (`forbidden`) and every write are classified and
 * surfaced as an explicit alert instead of a silent no-op or an empty table.
 */

const READ_ERROR_KEY: Record<PartiesErrorCode, TranslationKey> = {
  forbidden: 'settings.project.parties.error.forbidden',
  unavailable: 'settings.project.parties.error.unavailable',
  network: 'settings.project.parties.error.network',
  unknown: 'settings.project.parties.error.unknown',
};

const WRITE_ERROR_KEY: Record<PartyWriteErrorCode, TranslationKey> = {
  forbidden: 'settings.project.parties.writeError.forbidden',
  unavailable: 'settings.project.parties.writeError.unavailable',
  network: 'settings.project.parties.writeError.network',
  validation: 'settings.project.parties.writeError.validation',
  immutable: 'settings.project.parties.writeError.immutable',
  hasReferences: 'settings.project.parties.writeError.hasReferences',
  notFound: 'settings.project.parties.writeError.notFound',
  unknown: 'settings.project.parties.writeError.unknown',
};

/**
 * The type is a category, so each badge owns a fixed hue (local = emerald,
 * foreign = sky, customer = amber) that reads the same in both themes. The
 * badge never travels by colour alone: every one carries an icon and the type's
 * name as text, so the table is just as legible in greyscale.
 */
const TYPE_BADGE: Record<
  PartyType,
  { readonly icon: LucideIcon; readonly className: string; readonly labelKey: TranslationKey }
> = {
  local_supplier: {
    icon: Truck,
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
    labelKey: 'settings.project.parties.type.localSupplier',
  },
  foreign_supplier: {
    icon: Truck,
    className: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-400',
    labelKey: 'settings.project.parties.type.foreignSupplier',
  },
  customer: {
    icon: Users,
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-400',
    labelKey: 'settings.project.parties.type.customer',
  },
};

function TypeBadge({ type }: { readonly type: PartyType }) {
  const { t } = useI18n();
  const badge = TYPE_BADGE[type];
  const Icon = badge.icon;
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge.className}`}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {t(badge.labelKey)}
    </span>
  );
}

interface FormTarget {
  readonly mode: 'create' | 'edit';
  /** Present in edit mode: the row being edited (its type is rule context). */
  readonly party?: Party;
}

interface Banner {
  readonly tone: 'error' | 'success';
  readonly key: TranslationKey;
}

const ACTION_CLASS =
  'text-muted-foreground hover:text-foreground hover:bg-muted/60 focus-visible:ring-ring inline-grid size-8 shrink-0 place-items-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';

const HEADER_CELL_CLASS =
  'text-muted-foreground border-border border-b px-3 py-2.5 text-start text-[11px] font-semibold tracking-wide uppercase sm:px-4';

const CELL_CLASS = 'border-border/60 border-b px-3 py-3 align-middle sm:px-4';

function RowActions({
  party,
  busy,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  readonly party: Party;
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onToggleActive: () => void;
  readonly onDelete: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex shrink-0 items-center justify-end gap-1">
      <button
        type="button"
        onClick={onEdit}
        disabled={busy}
        aria-label={`${t('settings.project.parties.action.edit')} ${party.name}`}
        className={ACTION_CLASS}
      >
        <Pencil className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onToggleActive}
        disabled={busy}
        aria-label={`${
          party.isActive
            ? t('settings.project.parties.action.deactivate')
            : t('settings.project.parties.action.activate')
        } ${party.name}`}
        className={ACTION_CLASS}
      >
        <Power className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        aria-label={`${t('settings.project.parties.action.delete')} ${party.name}`}
        className={`${ACTION_CLASS} hover:text-destructive`}
      >
        <Trash2 className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

const SCOPE_COPY: Record<
  PartyScope,
  {
    readonly icon: LucideIcon;
    readonly emptyTitle: TranslationKey;
    readonly emptyDescription: TranslationKey;
    readonly tableCaption: TranslationKey;
  }
> = {
  inbound: {
    icon: ArrowDownToLine,
    emptyTitle: 'settings.project.parties.empty.inbound.title',
    emptyDescription: 'settings.project.parties.empty.inbound.description',
    tableCaption: 'settings.project.parties.table.inboundCaption',
  },
  outbound: {
    icon: ArrowUpFromLine,
    emptyTitle: 'settings.project.parties.empty.outbound.title',
    emptyDescription: 'settings.project.parties.empty.outbound.description',
    tableCaption: 'settings.project.parties.table.outboundCaption',
  },
};

export default function PartiesDirectory({ scope }: { readonly scope: PartyScope }) {
  const { t } = useI18n();
  const query = useParties();
  const copy = SCOPE_COPY[scope];

  const createParty = useCreateParty();
  const updateParty = useUpdateParty();
  const setPartyActive = useSetPartyActive();
  const deleteParty = useDeleteParty();

  const [form, setForm] = useState<FormTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Party | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const busy =
    createParty.isPending ||
    updateParty.isPending ||
    setPartyActive.isPending ||
    deleteParty.isPending;

  const allowedTypes = useMemo(() => partyTypesForScope(scope), [scope]);

  const parties = useMemo(() => {
    const all = query.data ?? [];
    return scope === 'inbound'
      ? all.filter((party) => isInboundPartyType(party.type))
      : all.filter((party) => party.type === 'customer');
  }, [query.data, scope]);

  /**
   * Write failure. The form dialog deliberately stays open so the user keeps
   * what they typed and can retry; a delete confirmation is dismissed instead,
   * because a refused delete means the row is no longer deletable and there is
   * nothing to resubmit unchanged.
   */
  const failWith = useCallback((error: unknown, operation: PartyWriteOperation) => {
    setBanner({ tone: 'error', key: WRITE_ERROR_KEY[classifyPartyWriteError(error, operation)] });
  }, []);

  const failDeleteWith = useCallback(
    (error: unknown) => {
      setDeleteTarget(null);
      failWith(error, 'delete');
    },
    [failWith],
  );

  const succeedWith = useCallback((key: TranslationKey) => {
    setForm(null);
    setDeleteTarget(null);
    setBanner({ tone: 'success', key });
  }, []);

  function submitForm(values: PartyFormValues) {
    if (form === null) {
      return;
    }
    setBanner(null);

    const fields = {
      name: values.name,
      taxNumber: values.taxNumber,
      commercialRegister: values.commercialRegister,
      address: values.address,
      contactPerson: values.contactPerson,
      phone: values.phone,
      email: values.email,
      creditLimit: values.creditLimit,
      paymentTerms: values.paymentTerms,
    };

    if (form.mode === 'create') {
      createParty.mutate(
        { type: values.type, ...fields },
        {
          onSuccess: () => succeedWith('settings.project.parties.success.saved'),
          onError: (error) => failWith(error, 'create'),
        },
      );
      return;
    }

    /* The party's stored type is immutable and never part of an update; the
       payload builder has no key for it. */
    const party = form.party as Party;
    updateParty.mutate(
      { id: party.id, ...fields },
      {
        onSuccess: () => succeedWith('settings.project.parties.success.saved'),
        onError: (error) => failWith(error, 'update'),
      },
    );
  }

  function confirmDelete() {
    if (deleteTarget === null) {
      return;
    }
    setBanner(null);
    deleteParty.mutate(
      { id: deleteTarget.id },
      {
        onSuccess: () => succeedWith('settings.project.parties.success.deleted'),
        onError: failDeleteWith,
      },
    );
  }

  function togglePartyActive(party: Party) {
    setBanner(null);
    setPartyActive.mutate(
      { id: party.id, isActive: !party.isActive },
      { onError: (error) => failWith(error, 'toggle') },
    );
  }

  if (query.isLoading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t('settings.project.parties.loading')}
      </div>
    );
  }

  const readErrorKey = query.isError ? READ_ERROR_KEY[classifyPartiesError(query.error)] : null;

  return (
    <div className="space-y-4">
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
            aria-label={t('settings.project.parties.dismiss')}
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
            {t('settings.project.parties.retry')}
          </button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs">
              {t(
                scope === 'inbound'
                  ? 'settings.project.parties.inbound.description'
                  : 'settings.project.parties.outbound.description',
              )}
            </p>
            <button
              type="button"
              onClick={() => {
                setBanner(null);
                setForm({ mode: 'create' });
              }}
              disabled={busy}
              className="bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t('settings.project.parties.add')}
            </button>
          </div>

          {parties.length === 0 ? (
            <EmptyState
              icon={copy.icon}
              title={t(copy.emptyTitle)}
              description={t(copy.emptyDescription)}
            />
          ) : (
            /* Narrow screens scroll the table sideways rather than squeezing a
               badge into two lines: the wrapper is the scroll container, so the
               card edge never cuts a badge in half. */
            /* Five columns do not fit a phone, so the wrapper scrolls sideways
               rather than wrapping a badge in half. `contain: paint` is not
               cosmetic: without it an RTL horizontal scroller makes Chromium
               widen the document past the viewport and paint the card shifted. */
            <div className="border-border overflow-x-auto rounded-xl border [contain:paint]">
              <table className="w-full min-w-[28rem] border-collapse text-sm">
                <caption className="sr-only">{t(copy.tableCaption)}</caption>
                <thead className="bg-muted/40">
                  <tr>
                    <th scope="col" className={HEADER_CELL_CLASS}>
                      {t('settings.project.parties.table.name')}
                    </th>
                    <th scope="col" className={HEADER_CELL_CLASS}>
                      {t('settings.project.parties.table.code')}
                    </th>
                    <th scope="col" className={HEADER_CELL_CLASS}>
                      {t('settings.project.parties.table.type')}
                    </th>
                    <th scope="col" className={HEADER_CELL_CLASS}>
                      {t('settings.project.parties.table.status')}
                    </th>
                    <th scope="col" className={`${HEADER_CELL_CLASS} text-end`}>
                      <span className="sr-only">{t('settings.project.parties.table.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {parties.map((party) => (
                    <tr key={party.id} className="hover:bg-muted/20 transition-colors">
                      <td className={`${CELL_CLASS} text-foreground font-medium`}>
                        <span className="block max-w-[14rem] truncate sm:max-w-[22rem]">
                          {party.name}
                        </span>
                      </td>
                      <td
                        className={`${CELL_CLASS} text-muted-foreground/80 font-mono text-xs whitespace-nowrap`}
                      >
                        {party.code}
                      </td>
                      <td className={`${CELL_CLASS} whitespace-nowrap`}>
                        <TypeBadge type={party.type} />
                      </td>
                      <td className={CELL_CLASS}>
                        <StatusIcon
                          active={party.isActive}
                          label={
                            party.isActive
                              ? t('settings.project.parties.status.active')
                              : t('settings.project.parties.status.inactive')
                          }
                        />
                      </td>
                      <td className={CELL_CLASS}>
                        <RowActions
                          party={party}
                          busy={busy}
                          onEdit={() => {
                            setBanner(null);
                            setForm({ mode: 'edit', party });
                          }}
                          onToggleActive={() => togglePartyActive(party)}
                          onDelete={() => {
                            setBanner(null);
                            setDeleteTarget(party);
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {form !== null ? (
        <PartyFormDialog
          mode={form.mode}
          initialParty={form.party}
          allowedTypes={allowedTypes}
          busy={busy}
          onSubmit={submitForm}
          onClose={() => setForm(null)}
        />
      ) : null}

      {deleteTarget !== null ? (
        <PartyDeleteDialog
          name={deleteTarget.name}
          code={deleteTarget.code}
          busy={busy}
          onConfirm={confirmDelete}
          onClose={() => setDeleteTarget(null)}
        />
      ) : null}
    </div>
  );
}
