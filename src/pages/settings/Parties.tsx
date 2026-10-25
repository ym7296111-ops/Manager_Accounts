import {
  Ban,
  Building2,
  CheckCircle2,
  Landmark,
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
import type { PartyFormValues } from '@/lib/partyValidation';
import { PartyDeleteDialog, PartyFormDialog } from './PartyDialogs';

/**
 * Parties — the counterparty directory (suppliers, customers, sister
 * companies, internal departments), read plus the full write path.
 *
 * The directory is one flat read of a few dozen rows, filtered by type here
 * on the client; every mutation invalidates it so the list re-renders from
 * the database rather than from optimistic local state. Codes are never
 * sent (per-type sequences mint them server-side) and `type` travels exactly
 * once, on create — the payload builders in `usePartiesMutations` enforce
 * both, and the trigger refuses any later change with 22023.
 *
 * Authorization is the database's. `RequireCapability` on the route reads the
 * capability snapshot, which can disagree with a live revoked or delegated
 * grant, so both the read (`forbidden`) and every write are classified and
 * surfaced as an explicit alert instead of a silent no-op or an empty list.
 *
 * Delete is offered on every row in this phase: nothing references a party
 * yet. A refused delete (23503 once letters carry a party FK, or a row that
 * vanished mid-click) is classified and shown, and the list is refetched so
 * the row on screen matches the database.
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

type PartyFilter = 'all' | PartyType;

const FILTERS: readonly { readonly id: PartyFilter; readonly labelKey: TranslationKey }[] = [
  { id: 'all', labelKey: 'settings.project.parties.filter.all' },
  { id: 'supplier', labelKey: 'settings.project.parties.filter.supplier' },
  { id: 'customer', labelKey: 'settings.project.parties.filter.customer' },
  { id: 'sister_company', labelKey: 'settings.project.parties.filter.sisterCompany' },
  { id: 'internal', labelKey: 'settings.project.parties.filter.internal' },
];

/**
 * The type is a category, so it borrows the categorical chart tokens — and it
 * never travels by colour alone: every badge carries an icon and the type's
 * name as text.
 */
const TYPE_BADGE: Record<
  PartyType,
  { readonly icon: LucideIcon; readonly className: string; readonly labelKey: TranslationKey }
> = {
  supplier: {
    icon: Truck,
    className: 'border-chart-1/30 bg-chart-1/10 text-chart-1',
    labelKey: 'settings.project.parties.type.supplier',
  },
  customer: {
    icon: Users,
    className: 'border-chart-2/30 bg-chart-2/10 text-chart-2',
    labelKey: 'settings.project.parties.type.customer',
  },
  sister_company: {
    icon: Building2,
    className: 'border-chart-3/30 bg-chart-3/10 text-chart-3',
    labelKey: 'settings.project.parties.type.sisterCompany',
  },
  internal: {
    icon: Landmark,
    className: 'border-border bg-muted text-muted-foreground',
    labelKey: 'settings.project.parties.type.internal',
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
    <div className="flex shrink-0 items-center gap-1">
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

export default function Parties() {
  const { t } = useI18n();
  const query = useParties();

  const createParty = useCreateParty();
  const updateParty = useUpdateParty();
  const setPartyActive = useSetPartyActive();
  const deleteParty = useDeleteParty();

  const [filter, setFilter] = useState<PartyFilter>('all');
  const [form, setForm] = useState<FormTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Party | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const busy =
    createParty.isPending ||
    updateParty.isPending ||
    setPartyActive.isPending ||
    deleteParty.isPending;

  const parties = useMemo(() => query.data ?? [], [query.data]);

  const countFor = useCallback(
    (id: PartyFilter): number =>
      id === 'all' ? parties.length : parties.filter((party) => party.type === id).length,
    [parties],
  );

  const visible = useMemo(
    () => (filter === 'all' ? parties : parties.filter((party) => party.type === filter)),
    [parties, filter],
  );

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

    /* The party's stored type is the rule context for the update payload; it
       is never itself part of what gets written. */
    const party = form.party as Party;
    updateParty.mutate(
      { id: party.id, type: party.type, ...fields },
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
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              {FILTERS.map((entry) => {
                const isSelected = filter === entry.id;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => setFilter(entry.id)}
                    className={[
                      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors',
                      'focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                      isSelected
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground hover:bg-muted/40',
                    ].join(' ')}
                  >
                    {t(entry.labelKey)}
                    <span className="opacity-70">{countFor(entry.id)}</span>
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => {
                setBanner(null);
                setForm({ mode: 'create' });
              }}
              disabled={busy}
              className="bg-primary text-primary-foreground ms-auto inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-opacity disabled:cursor-not-allowed disabled:opacity-60"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t('settings.project.parties.add')}
            </button>
          </div>

          {parties.length === 0 ? (
            <EmptyState
              icon={Users}
              title={t('settings.project.parties.empty.title')}
              description={t('settings.project.parties.empty.description')}
            />
          ) : visible.length === 0 ? (
            <p className="text-muted-foreground py-10 text-center text-sm">
              {t('settings.project.parties.empty.filtered')}
            </p>
          ) : (
            <ul className="space-y-2">
              {visible.map((party) => (
                <li
                  key={party.id}
                  className="border-border bg-card flex items-center gap-3 rounded-xl border px-4 py-3"
                >
                  <span className="flex min-w-0 flex-1 items-baseline gap-2">
                    <span className="text-foreground truncate text-sm font-medium">
                      {party.name}
                    </span>
                    <span className="text-muted-foreground/70 shrink-0 font-mono text-xs">
                      {party.code}
                    </span>
                  </span>
                  <TypeBadge type={party.type} />
                  <StatusIcon
                    active={party.isActive}
                    label={
                      party.isActive
                        ? t('settings.project.parties.status.active')
                        : t('settings.project.parties.status.inactive')
                    }
                  />
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
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {form !== null ? (
        <PartyFormDialog
          mode={form.mode}
          initialParty={form.party}
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
