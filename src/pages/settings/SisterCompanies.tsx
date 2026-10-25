import {
  Ban,
  Building2,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Network,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusIcon } from '@/components/ui/StatusIcon';
import {
  classifySisterCompaniesError,
  useSisterCompanies,
  type SisterCompaniesErrorCode,
  type SisterCompany,
} from '@/hooks/useSisterCompanies';
import {
  classifySisterCompanyWriteError,
  useCreateSisterCompany,
  useDeleteSisterCompany,
  useRenameSisterCompany,
  useSetSisterCompanyActive,
  type SisterCompanyWriteErrorCode,
  type SisterCompanyWriteOperation,
} from '@/hooks/useSisterCompaniesMutations';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import {
  SisterCompanyDeleteDialog,
  SisterCompanyFormDialog,
  type SisterCompanyFormKind,
} from './SisterCompanyDialogs';

/**
 * Sister companies — the intercompany tree, read and write.
 *
 * Two levels, exactly as the database enforces them:
 *
 *   level 1  شركة أم   → a parent company, the roots of the screen
 *   level 2  فرع       → a branch, nested under its parent, indent +16px
 *
 * The accordion mirrors the classifications tree (a disclosure button with
 * `aria-expanded` / `aria-controls` onto a `role="region"` panel) but stops at
 * two levels, because `sister_companies_before_write` refuses a third.
 *
 * What the UI sends, and what it never sends:
 *
 * * create parent → `{ name }`
 * * create branch → `{ name, parentId }` (the parent whose panel opened the dialog)
 * * rename        → `{ id, name }`
 * * toggle        → `{ id, is_active }`
 * * delete        → `{ id }`
 *
 * `code` and `level` are never sent — the trigger mints `SIS-001` for a parent
 * and `SIS-001-01` for its first branch, and derives the level. `parent_id` is
 * written once, on insert; the trigger refuses a change with 22023, and the
 * payload builders in `useSisterCompaniesMutations` cannot emit it on update.
 *
 * Delete is offered on a parent only while it has no branches (the FK's
 * `on delete restrict` is the real guard, and a refused delete is classified
 * as `hasBranches` and explained).
 */

const READ_ERROR_KEY: Record<SisterCompaniesErrorCode, TranslationKey> = {
  forbidden: 'settings.project.sisterCompanies.error.forbidden',
  unavailable: 'settings.project.sisterCompanies.error.unavailable',
  network: 'settings.project.sisterCompanies.error.network',
  unknown: 'settings.project.sisterCompanies.error.unknown',
};

const WRITE_ERROR_KEY: Record<SisterCompanyWriteErrorCode, TranslationKey> = {
  forbidden: 'settings.project.sisterCompanies.writeError.forbidden',
  unavailable: 'settings.project.sisterCompanies.writeError.unavailable',
  network: 'settings.project.sisterCompanies.writeError.network',
  validation: 'settings.project.sisterCompanies.writeError.validation',
  immutable: 'settings.project.sisterCompanies.writeError.immutable',
  hasBranches: 'settings.project.sisterCompanies.writeError.hasBranches',
  missingParent: 'settings.project.sisterCompanies.writeError.missingParent',
  notFound: 'settings.project.sisterCompanies.writeError.notFound',
  unknown: 'settings.project.sisterCompanies.writeError.unknown',
};

const INDENT_PX = 16;

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
  | { readonly mode: 'create'; readonly kind: 'parent' }
  | {
      readonly mode: 'create';
      readonly kind: 'branch';
      readonly parentId: string;
      readonly parentName: string;
      readonly parentCode: string;
    }
  | {
      readonly mode: 'edit';
      readonly kind: SisterCompanyFormKind;
      readonly company: SisterCompany;
    };

function CompanyStatus({ isActive }: { readonly isActive: boolean }) {
  const { t } = useI18n();
  return (
    <StatusIcon
      active={isActive}
      label={
        isActive
          ? t('settings.project.sisterCompanies.status.active')
          : t('settings.project.sisterCompanies.status.inactive')
      }
    />
  );
}

function RowActions({
  company,
  canDelete,
  busy,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  readonly company: SisterCompany;
  readonly canDelete: boolean;
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
        aria-label={`${t('settings.project.sisterCompanies.action.edit')} ${company.name}`}
        className={ACTION_CLASS}
      >
        <Pencil className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onToggleActive}
        disabled={busy}
        aria-label={`${
          company.isActive
            ? t('settings.project.sisterCompanies.action.deactivate')
            : t('settings.project.sisterCompanies.action.activate')
        } ${company.name}`}
        className={ACTION_CLASS}
      >
        <Power className="size-3.5" aria-hidden="true" />
      </button>
      {canDelete ? (
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          aria-label={`${t('settings.project.sisterCompanies.action.delete')} ${company.name}`}
          className={`${ACTION_CLASS} hover:text-destructive`}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** One branch row inside an open parent panel. */
function BranchRow({
  branch,
  busy,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  readonly branch: SisterCompany;
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onToggleActive: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <li className="border-border bg-card flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <Network
          className="size-4 shrink-0 text-violet-600 dark:text-violet-400"
          aria-hidden="true"
        />
        <span className="text-foreground truncate text-sm font-medium">{branch.name}</span>
        <span className="text-muted-foreground/70 shrink-0 font-mono text-xs">{branch.code}</span>
      </span>
      <CompanyStatus isActive={branch.isActive} />
      <RowActions
        company={branch}
        canDelete
        busy={busy}
        onEdit={onEdit}
        onToggleActive={onToggleActive}
        onDelete={onDelete}
      />
    </li>
  );
}

export default function SisterCompanies() {
  const { t } = useI18n();
  const query = useSisterCompanies();

  const createCompany = useCreateSisterCompany();
  const renameCompany = useRenameSisterCompany();
  const toggleCompany = useSetSisterCompanyActive();
  const deleteCompany = useDeleteSisterCompany();

  const [openCompanies, setOpenCompanies] = useState<ReadonlySet<string>>(() => new Set());
  const [form, setForm] = useState<FormTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const busy =
    createCompany.isPending ||
    renameCompany.isPending ||
    toggleCompany.isPending ||
    deleteCompany.isPending;

  const failWith = useCallback((error: unknown, operation: SisterCompanyWriteOperation) => {
    setBanner({
      tone: 'error',
      key: WRITE_ERROR_KEY[classifySisterCompanyWriteError(error, operation)],
    });
  }, []);

  const succeedWith = useCallback((key: TranslationKey) => {
    setForm(null);
    setDeleteTarget(null);
    setBanner({ tone: 'success', key });
  }, []);

  function toggleOpen(id: string) {
    setOpenCompanies((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
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
      const parentId = form.kind === 'branch' ? form.parentId : undefined;
      createCompany.mutate(parentId === undefined ? { name } : { name, parentId }, {
        onSuccess: () => {
          /* Reveal what was just created: a new branch opens its parent. */
          if (parentId !== undefined) {
            setOpenCompanies((current) => new Set([...current, parentId]));
          }
          succeedWith('settings.project.sisterCompanies.success.saved');
        },
        onError: (error) => failWith(error, 'create'),
      });
      return;
    }

    renameCompany.mutate(
      { id: form.company.id, name },
      {
        onSuccess: () => succeedWith('settings.project.sisterCompanies.success.saved'),
        onError: (error) => failWith(error, 'rename'),
      },
    );
  }

  function confirmDelete() {
    if (deleteTarget === null) {
      return;
    }
    setBanner(null);
    deleteCompany.mutate(
      { id: deleteTarget.id },
      {
        onSuccess: () => succeedWith('settings.project.sisterCompanies.success.deleted'),
        onError: (error) => {
          setDeleteTarget(null);
          failWith(error, 'delete');
        },
      },
    );
  }

  function toggleActive(company: SisterCompany) {
    setBanner(null);
    toggleCompany.mutate(
      { id: company.id, isActive: !company.isActive },
      { onError: (error) => failWith(error, 'toggle') },
    );
  }

  if (query.isLoading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t('settings.project.sisterCompanies.loading')}
      </div>
    );
  }

  const readErrorKey = query.isError
    ? READ_ERROR_KEY[classifySisterCompaniesError(query.error)]
    : null;

  const companies = query.data ?? [];

  const formDialog =
    form === null ? null : (
      <SisterCompanyFormDialog
        mode={form.mode}
        kind={form.kind}
        parentName={form.mode === 'create' && form.kind === 'branch' ? form.parentName : undefined}
        parentCode={form.mode === 'create' && form.kind === 'branch' ? form.parentCode : undefined}
        initialName={form.mode === 'edit' ? form.company.name : undefined}
        code={form.mode === 'edit' ? form.company.code : undefined}
        busy={busy}
        onSubmit={submitForm}
        onClose={() => setForm(null)}
      />
    );

  return (
    <section aria-labelledby="sister-companies-heading" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 id="sister-companies-heading" className="text-foreground text-sm font-semibold">
            {t('settings.project.sisterCompanies.heading')}
          </h3>
          <p className="text-muted-foreground max-w-2xl text-xs leading-relaxed">
            {t('settings.project.sisterCompanies.description')}
          </p>
        </div>
        {readErrorKey === null ? (
          <button
            type="button"
            onClick={() => {
              setBanner(null);
              setForm({ mode: 'create', kind: 'parent' });
            }}
            disabled={busy}
            className={`${ADD_BUTTON_CLASS} text-violet-600 dark:text-violet-400`}
          >
            <Plus className="size-3.5" aria-hidden="true" />
            {t('settings.project.sisterCompanies.addParent')}
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
            aria-label={t('settings.project.sisterCompanies.dismiss')}
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
            {t('settings.project.sisterCompanies.retry')}
          </button>
        </div>
      ) : companies.length === 0 ? (
        <EmptyState
          icon={Building2}
          title={t('settings.project.sisterCompanies.empty.title')}
          description={t('settings.project.sisterCompanies.empty.description')}
        />
      ) : (
        <ul aria-labelledby="sister-companies-heading" className="space-y-2">
          {companies.map((company) => {
            const isOpen = openCompanies.has(company.id);
            const hasBranches = company.branches.length > 0;
            const buttonId = `sister-company-${company.id}`;
            const panelId = `sister-company-panel-${company.id}`;

            return (
              <li key={company.id}>
                <div className="hover:bg-muted/30 border-border bg-card flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
                  <button
                    type="button"
                    id={buttonId}
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => toggleOpen(company.id)}
                    className={TOGGLE_CLASS}
                  >
                    <ChevronDown
                      className={`${CHEVRON_CLASS} ${isOpen ? 'rotate-180' : ''}`}
                      aria-hidden="true"
                    />
                    <Building2
                      className="size-4 shrink-0 text-violet-600 dark:text-violet-400"
                      aria-hidden="true"
                    />
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span className="text-foreground truncate text-sm font-semibold">
                        {company.name}
                      </span>
                      <span className="text-muted-foreground/70 shrink-0 font-mono text-xs">
                        {company.code}
                      </span>
                    </span>
                    <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
                      {t('settings.project.sisterCompanies.branchCount', {
                        count: company.branches.length,
                      })}
                    </span>
                    <CompanyStatus isActive={company.isActive} />
                  </button>
                  <RowActions
                    company={company}
                    canDelete={!hasBranches}
                    busy={busy}
                    onEdit={() => {
                      setBanner(null);
                      setForm({ mode: 'edit', kind: 'parent', company });
                    }}
                    onToggleActive={() => toggleActive(company)}
                    onDelete={() => {
                      setBanner(null);
                      setDeleteTarget({
                        id: company.id,
                        name: company.name,
                        code: company.code,
                      });
                    }}
                  />
                </div>

                {isOpen ? (
                  <div
                    id={panelId}
                    role="region"
                    aria-labelledby={buttonId}
                    style={{ paddingInlineStart: INDENT_PX }}
                    className="bg-foreground/[0.025] mt-1.5 space-y-1.5 border-s-2 border-violet-500/30 py-1 pe-2"
                  >
                    <div className="flex items-center justify-between gap-3 py-1">
                      <h4 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
                        {t('settings.project.sisterCompanies.branchesHeading')}
                      </h4>
                      <button
                        type="button"
                        onClick={() => {
                          setBanner(null);
                          setForm({
                            mode: 'create',
                            kind: 'branch',
                            parentId: company.id,
                            parentName: company.name,
                            parentCode: company.code,
                          });
                        }}
                        disabled={busy}
                        aria-label={t('settings.project.sisterCompanies.addBranchUnder', {
                          parent: company.name,
                        })}
                        className={ADD_BUTTON_CLASS}
                      >
                        <Plus className="size-3.5" aria-hidden="true" />
                        {t('settings.project.sisterCompanies.addBranch')}
                      </button>
                    </div>

                    {hasBranches ? (
                      <ul className="space-y-1.5">
                        {company.branches.map((branch) => (
                          <BranchRow
                            key={branch.id}
                            branch={branch}
                            busy={busy}
                            onEdit={() => {
                              setBanner(null);
                              setForm({ mode: 'edit', kind: 'branch', company: branch });
                            }}
                            onToggleActive={() => toggleActive(branch)}
                            onDelete={() => {
                              setBanner(null);
                              setDeleteTarget({
                                id: branch.id,
                                name: branch.name,
                                code: branch.code,
                              });
                            }}
                          />
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground py-1 text-sm">
                        {t('settings.project.sisterCompanies.noBranches')}
                      </p>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {formDialog}

      {deleteTarget !== null ? (
        <SisterCompanyDeleteDialog
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
