import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Trash2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useState } from 'react';
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
  useRenameParty,
  useSetPartyActive,
  type PartyWriteErrorCode,
  type PartyWriteOperation,
} from '@/hooks/usePartiesMutations';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import type { PartyBranch } from '@/lib/database.types';
import { PartyDeleteDialog, PartyFormDialog } from '@/pages/settings/PartyDialogs';

/**
 * Parties — «جهات الوارد وأغراض الصرف» — a two-level tree with two fixed roots.
 *
 *   inbound   green   ArrowDownToLine   «جهات الوارد»
 *   outbound  orange  ArrowUpFromLine   «أغراض الصرف»
 *
 * Each root opens onto one flat level of parties: name, code, active flag. That
 * is the whole row — a party has no other attribute. The commercial profile
 * (tax number, commercial register, address, contact person, phone, email,
 * credit limit, payment terms) was retired with its columns in 20261109000000,
 * and nothing on this screen may bring it back.
 *
 * The roots are fixed, not derived from the data: an empty branch still shows
 * its root, its count (`0`) and its "add" button, so the screen always says
 * where a new party would land. The `branch` is chosen by *which* root's button
 * opened the dialog — there is no branch control to get wrong — and it is
 * write-once: the trigger refuses a change with 22023, and the payload builders
 * cannot emit one.
 *
 * Only the open roots' rows are rendered, and the whole list comes from one
 * flat read (`useParties`); switching a root costs no extra query.
 *
 * Sister companies are deliberately not here: they are a parent → branch tree
 * with their own purpose and their own top-level tab.
 */

interface RootConfig {
  readonly id: PartyBranch;
  readonly labelKey: TranslationKey;
  readonly icon: LucideIcon;
  /** The root's colour, used on the icon, the indentation rail and the button. */
  readonly iconClass: string;
  readonly railClass: string;
  readonly addClass: string;
}

const ROOTS: readonly RootConfig[] = [
  {
    id: 'inbound',
    labelKey: 'settings.project.parties.roots.inbound',
    icon: ArrowDownToLine,
    iconClass: 'text-success',
    railClass: 'border-success/30',
    addClass: 'text-success',
  },
  {
    id: 'outbound',
    labelKey: 'settings.project.parties.roots.outbound',
    icon: ArrowUpFromLine,
    iconClass: 'text-orange-600 dark:text-orange-400',
    railClass: 'border-orange-500/30',
    addClass: 'text-orange-600 dark:text-orange-400',
  },
];

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

const TOGGLE_CLASS =
  'focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-3 rounded-lg text-start focus-visible:ring-2 focus-visible:outline-none';

const CHEVRON_CLASS = 'text-muted-foreground size-4 shrink-0 transition-transform';

const ADD_BUTTON_CLASS =
  'text-primary border-border hover:bg-muted/40 inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';

const ACTION_CLASS =
  'text-muted-foreground hover:text-foreground hover:bg-muted/60 focus-visible:ring-ring inline-grid size-8 shrink-0 place-items-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60';

interface Banner {
  readonly tone: 'error' | 'success';
  readonly key: TranslationKey;
}

interface DeleteTarget {
  readonly id: string;
  readonly name: string;
  readonly code: string;
}

type FormTarget =
  | { readonly mode: 'create'; readonly branch: PartyBranch }
  | { readonly mode: 'edit'; readonly party: Party };

function PartyStatus({ isActive }: { readonly isActive: boolean }) {
  const { t } = useI18n();
  return (
    <StatusIcon
      active={isActive}
      label={
        isActive
          ? t('settings.project.parties.status.active')
          : t('settings.project.parties.status.inactive')
      }
    />
  );
}

/** One party row: name, code and the status icon, plus its row actions. */
function PartyRow({
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
    <li className="border-border bg-card flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="text-foreground truncate text-sm font-medium">{party.name}</span>
        <span className="text-muted-foreground/70 shrink-0 font-mono text-xs">{party.code}</span>
      </span>
      <PartyStatus isActive={party.isActive} />
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
    </li>
  );
}

export default function Parties() {
  const { t } = useI18n();
  const query = useParties();

  const createParty = useCreateParty();
  const renameParty = useRenameParty();
  const toggleParty = useSetPartyActive();
  const deleteParty = useDeleteParty();

  /* Both roots start open: the tree holds two branches and a few dozen rows, so
     there is nothing to hide behind a click — and the counts stay readable. */
  const [openRoots, setOpenRoots] = useState<ReadonlySet<PartyBranch>>(
    () => new Set<PartyBranch>(['inbound', 'outbound']),
  );
  const [form, setForm] = useState<FormTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const busy =
    createParty.isPending ||
    renameParty.isPending ||
    toggleParty.isPending ||
    deleteParty.isPending;

  const failWith = useCallback((error: unknown, operation: PartyWriteOperation) => {
    setBanner({
      tone: 'error',
      key: WRITE_ERROR_KEY[classifyPartyWriteError(error, operation)],
    });
  }, []);

  const succeedWith = useCallback((key: TranslationKey) => {
    setForm(null);
    setDeleteTarget(null);
    setBanner({ tone: 'success', key });
  }, []);

  function toggleRoot(branch: PartyBranch) {
    setOpenRoots((current) => {
      const next = new Set(current);
      if (next.has(branch)) {
        next.delete(branch);
      } else {
        next.add(branch);
      }
      return next;
    });
  }

  function submitForm(name: string) {
    if (form === null) {
      return;
    }
    setBanner(null);

    if (form.mode === 'create') {
      const branch = form.branch;
      createParty.mutate(
        { branch, name },
        {
          onSuccess: () => {
            /* Reveal what was just created: a new party opens its root. */
            setOpenRoots((current) => new Set([...current, branch]));
            succeedWith('settings.project.parties.success.saved');
          },
          onError: (error) => failWith(error, 'create'),
        },
      );
      return;
    }

    renameParty.mutate(
      { id: form.party.id, name },
      {
        onSuccess: () => succeedWith('settings.project.parties.success.saved'),
        onError: (error) => failWith(error, 'rename'),
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
        onError: (error) => {
          setDeleteTarget(null);
          failWith(error, 'delete');
        },
      },
    );
  }

  function toggleActive(party: Party) {
    setBanner(null);
    toggleParty.mutate(
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

  const parties = query.data ?? [];
  const byBranch: Record<PartyBranch, readonly Party[]> = {
    inbound: parties.filter((party) => party.branch === 'inbound'),
    outbound: parties.filter((party) => party.branch === 'outbound'),
  };

  return (
    <section aria-labelledby="parties-heading" className="space-y-4">
      <div className="space-y-1">
        <h3 id="parties-heading" className="text-foreground text-sm font-semibold">
          {t('settings.project.parties.heading')}
        </h3>
        <p className="text-muted-foreground max-w-2xl text-xs leading-relaxed">
          {t('settings.project.parties.description')}
        </p>
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
        <ul aria-labelledby="parties-heading" className="space-y-2">
          {ROOTS.map((root) => {
            const isOpen = openRoots.has(root.id);
            const rows = byBranch[root.id];
            const rootLabel = t(root.labelKey);
            const buttonId = `parties-root-${root.id}`;
            const panelId = `parties-root-panel-${root.id}`;
            const Icon = root.icon;

            return (
              <li key={root.id}>
                <div className="hover:bg-muted/30 border-border bg-card flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
                  <button
                    type="button"
                    id={buttonId}
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => toggleRoot(root.id)}
                    className={TOGGLE_CLASS}
                  >
                    <ChevronDown
                      className={`${CHEVRON_CLASS} ${isOpen ? 'rotate-180' : ''}`}
                      aria-hidden="true"
                    />
                    <Icon className={`size-4 shrink-0 ${root.iconClass}`} aria-hidden="true" />
                    <span className="text-foreground flex min-w-0 flex-1 items-baseline gap-2 truncate text-sm font-semibold">
                      {rootLabel}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {t('settings.project.parties.count', { count: rows.length })}
                    </span>
                  </button>
                </div>

                {isOpen ? (
                  <div
                    id={panelId}
                    role="region"
                    aria-labelledby={buttonId}
                    className={`bg-foreground/[0.025] mt-1.5 space-y-1.5 border-s-2 py-1 ps-4 pe-2 ${root.railClass}`}
                  >
                    <div className="flex items-center justify-between gap-3 py-1">
                      <h4 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
                        {t('settings.project.parties.listHeading')}
                      </h4>
                      <button
                        type="button"
                        onClick={() => {
                          setBanner(null);
                          setForm({ mode: 'create', branch: root.id });
                        }}
                        disabled={busy}
                        aria-label={t('settings.project.parties.addUnder', { root: rootLabel })}
                        className={`${ADD_BUTTON_CLASS} ${root.addClass}`}
                      >
                        <Plus className="size-3.5" aria-hidden="true" />
                        {t('settings.project.parties.add')}
                      </button>
                    </div>

                    {rows.length > 0 ? (
                      <ul className="space-y-1.5">
                        {rows.map((party) => (
                          <PartyRow
                            key={party.id}
                            party={party}
                            busy={busy}
                            onEdit={() => {
                              setBanner(null);
                              setForm({ mode: 'edit', party });
                            }}
                            onToggleActive={() => toggleActive(party)}
                            onDelete={() => {
                              setBanner(null);
                              setDeleteTarget({
                                id: party.id,
                                name: party.name,
                                code: party.code,
                              });
                            }}
                          />
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground py-1 text-sm">
                        {t('settings.project.parties.empty.branch')}
                      </p>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {form !== null ? (
        <PartyFormDialog
          branch={form.mode === 'create' ? form.branch : form.party.branch}
          mode={form.mode}
          initialName={form.mode === 'edit' ? form.party.name : undefined}
          code={form.mode === 'edit' ? form.party.code : undefined}
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
    </section>
  );
}
