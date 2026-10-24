import {
  Ban,
  CheckCircle2,
  ChevronDown,
  Folder,
  FolderOpen,
  FolderTree,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Tag,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useState, type ReactNode } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusIcon } from '@/components/ui/StatusIcon';
import {
  classifyClassificationsError,
  useClassifications,
  type ClassificationNode,
  type ClassificationsErrorCode,
} from '@/hooks/useClassifications';
import {
  classifyClassificationWriteError,
  useCreateClassification,
  useDeleteClassification,
  useRenameClassification,
  useSetClassificationActive,
  type ClassificationWriteErrorCode,
  type ClassificationWriteOperation,
} from '@/hooks/useClassificationsMutations';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';
import {
  ClassificationDeleteDialog,
  ClassificationFormDialog,
  type ClassificationFormTarget,
  type ClassificationNodeKind,
} from './ClassificationDialogs';

/**
 * Classifications — the tree, read and write (Phase 3).
 *
 * Three levels, assembled client-side from one flat read:
 *
 *   level 1  تصنيف أساسي        → an accordion row, collapsed by default
 *   level 2  تصنيف فرعي         → an accordion row inside the parent panel
 *   level 3  تصنيف فرعي (ورقي)  → a flat row; the only deletable level
 *
 * What the UI sends, and what it never sends:
 *
 * * create → `{ name }` (a category) or `{ name, parent_id }` (a child)
 * * rename → `{ id, name }`
 * * toggle → `{ id, is_active }`
 * * delete → `{ id }`
 *
 * `code`, `level` and `is_leaf` are never sent — they are the database's, and
 * the mutation payloads are allowlists that cannot carry them
 * (`useClassificationsMutations`). `parent_id` is written once, on insert, and
 * has no update path: moving a node re-derives a whole subtree, and that is
 * deliberately out of scope here, so the UI offers no way to ask for it.
 *
 * Delete is doubly guarded, exactly like the stations directory: the button is
 * offered only when the node has no children (`is_leaf` AND an empty child
 * list), while `ON DELETE RESTRICT` stays the real guard — a child added by
 * somebody else between render and click still produces SQLSTATE 23503, which
 * is classified as `hasChildren` and shown as a readable message.
 *
 * ARIA: a nested list with disclosure rows (`aria-expanded` / `aria-controls` →
 * `role="region"`), not `role="tree"` — that role promises roving-tabindex and
 * arrow-key navigation this UI does not implement.
 */

const READ_ERROR_KEY: Record<ClassificationsErrorCode, TranslationKey> = {
  forbidden: 'settings.project.classifications.error.forbidden',
  unavailable: 'settings.project.classifications.error.unavailable',
  network: 'settings.project.classifications.error.network',
  unknown: 'settings.project.classifications.error.unknown',
};

const WRITE_ERROR_KEY: Record<ClassificationWriteErrorCode, TranslationKey> = {
  forbidden: 'settings.project.classifications.writeError.forbidden',
  unavailable: 'settings.project.classifications.writeError.unavailable',
  network: 'settings.project.classifications.writeError.network',
  validation: 'settings.project.classifications.writeError.validation',
  hasChildren: 'settings.project.classifications.writeError.hasChildren',
  missingParent: 'settings.project.classifications.writeError.missingParent',
  notFound: 'settings.project.classifications.writeError.notFound',
  unknown: 'settings.project.classifications.writeError.unknown',
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

/**
 * The “add” affordance for one level.
 *
 * Level 2 and level 3 are both sub-classifications, so their buttons read the
 * same and two of them can be on screen at once (one inside an open main
 * classification, one inside an open sub-classification). `ariaLabel` names the
 * node the new row will land under, which disambiguates them for both screen
 * readers and tests; it always starts with the visible label, as WCAG 2.5.3
 * requires.
 */
function AddButton({
  label,
  ariaLabel,
  onClick,
  disabled,
}: {
  readonly label: string;
  readonly ariaLabel?: string;
  readonly onClick: () => void;
  readonly disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={ADD_BUTTON_CLASS}
    >
      <Plus className="size-3.5" aria-hidden="true" />
      {label}
    </button>
  );
}

function ClassificationStatus({ isActive }: { readonly isActive: boolean }) {
  const { t } = useI18n();
  return (
    <StatusIcon
      active={isActive}
      label={
        isActive
          ? t('settings.project.classifications.status.active')
          : t('settings.project.classifications.status.inactive')
      }
    />
  );
}

/**
 * Edit / activate-or-deactivate / delete for one node.
 *
 * Delete is rendered only when `canDelete`; the constraint remains the actual
 * guard, so hiding the button is a courtesy rather than the protection.
 */
function RowActions({
  node,
  canDelete,
  busy,
  onEdit,
  onToggleActive,
  onDelete,
}: {
  readonly node: ClassificationNode;
  readonly canDelete: boolean;
  readonly busy: boolean;
  readonly onEdit: () => void;
  readonly onToggleActive: () => void;
  readonly onDelete: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex shrink-0 items-center gap-1 max-sm:w-full max-sm:justify-end">
      <button
        type="button"
        onClick={onEdit}
        disabled={busy}
        aria-label={`${t('settings.project.classifications.action.edit')} ${node.name}`}
        className={ACTION_CLASS}
      >
        <Pencil className="size-3.5" aria-hidden="true" />
      </button>
      <button
        type="button"
        onClick={onToggleActive}
        disabled={busy}
        aria-label={`${
          node.isActive
            ? t('settings.project.classifications.action.deactivate')
            : t('settings.project.classifications.action.activate')
        } ${node.name}`}
        className={ACTION_CLASS}
      >
        <Power className="size-3.5" aria-hidden="true" />
      </button>
      {canDelete ? (
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          aria-label={`${t('settings.project.classifications.action.delete')} ${node.name}`}
          className={`${ACTION_CLASS} hover:text-destructive`}
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/** `level 3` row. The schema caps the tree at three levels, so it has no children. */
function ItemRow({
  node,
  actions,
}: {
  readonly node: ClassificationNode;
  readonly actions: ReactNode;
}) {
  return (
    <li className="bg-card border-border flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2">
      <Tag className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
      <span className="text-foreground min-w-0 flex-1 truncate text-sm">{node.name}</span>
      <span className="text-muted-foreground/70 shrink-0 font-mono text-xs">{node.code}</span>
      <ClassificationStatus isActive={node.isActive} />
      {actions}
    </li>
  );
}

function GroupRow({
  node,
  isOpen,
  onToggle,
  actions,
  addItem,
  renderItemActions,
}: {
  readonly node: ClassificationNode;
  readonly isOpen: boolean;
  readonly onToggle: () => void;
  readonly actions: ReactNode;
  readonly addItem: ReactNode;
  readonly renderItemActions: (item: ClassificationNode) => ReactNode;
}) {
  const { t } = useI18n();
  const buttonId = `classification-group-${node.id}`;
  const panelId = `classification-group-panel-${node.id}`;

  return (
    <li className="bg-background border-border rounded-lg border">
      <div className="hover:bg-muted/30 flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          id={buttonId}
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className={TOGGLE_CLASS}
        >
          <ChevronDown
            className={`${CHEVRON_CLASS} ${isOpen ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
          <Layers className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="text-foreground truncate text-sm font-medium">{node.name}</span>
            <span className="text-muted-foreground/70 shrink-0 font-mono text-xs">{node.code}</span>
          </span>
          <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
            {t('settings.project.classifications.itemCount', { count: node.children.length })}
          </span>
          <ClassificationStatus isActive={node.isActive} />
        </button>
        {actions}
      </div>

      {isOpen ? (
        <div
          id={panelId}
          role="region"
          aria-labelledby={buttonId}
          className="border-border space-y-2 border-t px-3 py-3"
        >
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
              {t('settings.project.classifications.itemsHeading')}
            </h4>
            {addItem}
          </div>

          {node.children.length === 0 ? (
            <p className="text-muted-foreground py-1 text-sm">
              {t('settings.project.classifications.noItems')}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {node.children.map((item) => (
                <ItemRow key={item.id} node={item} actions={renderItemActions(item)} />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

function CategoryRow({
  node,
  isOpen,
  openGroups,
  onToggle,
  onToggleGroup,
  actions,
  addGroup,
  renderGroupActions,
  renderAddItem,
  renderItemActions,
}: {
  readonly node: ClassificationNode;
  readonly isOpen: boolean;
  readonly openGroups: ReadonlySet<string>;
  readonly onToggle: () => void;
  readonly onToggleGroup: (id: string) => void;
  readonly actions: ReactNode;
  readonly addGroup: ReactNode;
  readonly renderGroupActions: (group: ClassificationNode) => ReactNode;
  readonly renderAddItem: (group: ClassificationNode) => ReactNode;
  readonly renderItemActions: (item: ClassificationNode) => ReactNode;
}) {
  const { t } = useI18n();
  const buttonId = `classification-category-${node.id}`;
  const panelId = `classification-category-panel-${node.id}`;
  const FolderIcon = isOpen ? FolderOpen : Folder;

  return (
    <li className="border-border bg-card overflow-hidden rounded-xl border">
      <div className="hover:bg-muted/30 flex flex-wrap items-center gap-2 px-4 py-3">
        <button
          type="button"
          id={buttonId}
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={onToggle}
          className={TOGGLE_CLASS}
        >
          <ChevronDown
            className={`${CHEVRON_CLASS} ${isOpen ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
          <FolderIcon className="text-primary size-4 shrink-0" aria-hidden="true" />
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="text-foreground truncate text-sm font-semibold">{node.name}</span>
            <span className="text-muted-foreground/70 shrink-0 font-mono text-xs">{node.code}</span>
          </span>
          <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
            {t('settings.project.classifications.groupCount', { count: node.children.length })}
          </span>
          <ClassificationStatus isActive={node.isActive} />
        </button>
        {actions}
      </div>

      {isOpen ? (
        <div
          id={panelId}
          role="region"
          aria-labelledby={buttonId}
          className="border-border space-y-3 border-t px-4 py-3"
        >
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
              {t('settings.project.classifications.groupsHeading')}
            </h3>
            {addGroup}
          </div>

          {node.children.length === 0 ? (
            <p className="text-muted-foreground py-1 text-sm">
              {t('settings.project.classifications.noGroups')}
            </p>
          ) : (
            <ul className="space-y-2">
              {node.children.map((group) => (
                <GroupRow
                  key={group.id}
                  node={group}
                  isOpen={openGroups.has(group.id)}
                  onToggle={() => onToggleGroup(group.id)}
                  actions={renderGroupActions(group)}
                  addItem={renderAddItem(group)}
                  renderItemActions={renderItemActions}
                />
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}

/** Adds or removes one id without mutating the previous set. */
function toggleIn(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(set);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

/** The noun for a node at a given depth (1 → category, 2 → group, 3 → item). */
function kindOfLevel(level: number): ClassificationNodeKind {
  if (level <= 1) {
    return 'category';
  }
  return level === 2 ? 'group' : 'item';
}

/** Adds one id without mutating the previous set (unlike `toggleIn`). */
function withId(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return new Set([...set, id]);
}

export default function Classifications() {
  const { t } = useI18n();
  const query = useClassifications();

  const createNode = useCreateClassification();
  const renameNode = useRenameClassification();
  const toggleNode = useSetClassificationActive();
  const deleteNode = useDeleteClassification();

  const [openCategories, setOpenCategories] = useState<ReadonlySet<string>>(() => new Set());
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [form, setForm] = useState<ClassificationFormTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const busy =
    createNode.isPending || renameNode.isPending || toggleNode.isPending || deleteNode.isPending;

  const toggleCategory = useCallback((id: string) => {
    setOpenCategories((current) => toggleIn(current, id));
  }, []);

  const toggleGroup = useCallback((id: string) => {
    setOpenGroups((current) => toggleIn(current, id));
  }, []);

  /**
   * Write failure, classified per operation: the same SQLSTATE does not mean the
   * same thing for a delete and an insert, so the verb travels with the error.
   */
  const failWith = useCallback((error: unknown, operation: ClassificationWriteOperation) => {
    setBanner({
      tone: 'error',
      key: WRITE_ERROR_KEY[classifyClassificationWriteError(error, operation)],
    });
  }, []);

  const succeedWith = useCallback((key: TranslationKey) => {
    setForm(null);
    setDeleteTarget(null);
    setBanner({ tone: 'success', key });
  }, []);

  function openAdd(kind: ClassificationNodeKind, parentId?: string, parentName?: string) {
    setBanner(null);
    setForm({ kind, mode: 'create', parentId, parentName });
  }

  function openEdit(node: ClassificationNode) {
    setBanner(null);
    setForm({
      /* The kind drives the dialog's copy only; `level` is the server's derived
         depth, so it is what decides which noun to use. */
      kind: kindOfLevel(node.level),
      mode: 'edit',
      nodeId: node.id,
      code: node.code,
      initialName: node.name,
    });
  }

  function submitForm(name: string) {
    if (form === null) {
      return;
    }
    setBanner(null);

    if (form.mode === 'create') {
      const parentId = form.parentId;
      const kind = form.kind;
      /* A category has no parent; a group's parent is its category and an
         item's parent is its group. That is the whole contract — the level is
         the server's to derive. */
      createNode.mutate(parentId === undefined ? { name } : { name, parentId }, {
        onSuccess: () => {
          /* Reveal what was just created: a new group opens its category, a new
             item opens its group. Saves two clicks and makes the result obvious. */
          if (parentId !== undefined) {
            if (kind === 'group') {
              setOpenCategories((current) => withId(current, parentId));
            } else {
              setOpenGroups((current) => withId(current, parentId));
            }
          }
          succeedWith('settings.project.classifications.success.saved');
        },
        onError: (error) => failWith(error, 'create'),
      });
      return;
    }

    renameNode.mutate(
      { id: form.nodeId as string, name },
      {
        onSuccess: () => succeedWith('settings.project.classifications.success.saved'),
        onError: (error) => failWith(error, 'rename'),
      },
    );
  }

  function confirmDelete() {
    if (deleteTarget === null) {
      return;
    }
    setBanner(null);
    deleteNode.mutate(
      { id: deleteTarget.id },
      {
        onSuccess: () => succeedWith('settings.project.classifications.success.deleted'),
        onError: (error) => {
          /* Dismiss the confirmation first: a refused delete means there is
             nothing to resubmit unchanged. */
          setDeleteTarget(null);
          failWith(error, 'delete');
        },
      },
    );
  }

  function toggleActive(node: ClassificationNode) {
    setBanner(null);
    toggleNode.mutate(
      { id: node.id, isActive: !node.isActive },
      { onError: (error) => failWith(error, 'toggle') },
    );
  }

  /**
   * Delete is offered only for a childless node. `is_leaf` is what the server
   * derived and the empty child list is what the client rendered; requiring both
   * means neither a stale read nor a misrouted row can expose the button. The
   * FK constraint remains the actual protection.
   */
  function canDelete(node: ClassificationNode): boolean {
    return node.isLeaf && node.children.length === 0;
  }

  function nodeActions(node: ClassificationNode): ReactNode {
    return (
      <RowActions
        node={node}
        canDelete={canDelete(node)}
        busy={busy}
        onEdit={() => openEdit(node)}
        onToggleActive={() => toggleActive(node)}
        onDelete={() => {
          setBanner(null);
          setDeleteTarget({ id: node.id, name: node.name, code: node.code });
        }}
      />
    );
  }

  if (query.isLoading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        {t('settings.project.classifications.loading')}
      </div>
    );
  }

  const readErrorKey = query.isError
    ? (READ_ERROR_KEY[classifyClassificationsError(query.error)] ?? READ_ERROR_KEY.unknown)
    : null;

  const categories = query.data ?? [];

  return (
    <section aria-labelledby="classifications-heading" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="classifications-heading" className="text-foreground text-sm font-semibold">
            {t('settings.project.classifications.heading')}
          </h2>
          <p className="text-muted-foreground max-w-2xl text-xs leading-relaxed">
            {t('settings.project.classifications.description')}
          </p>
        </div>
        <AddButton
          label={t('settings.project.classifications.addCategory')}
          onClick={() => openAdd('category')}
          disabled={busy}
        />
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
            aria-label={t('settings.project.classifications.dismiss')}
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
            {t('settings.project.classifications.retry')}
          </button>
        </div>
      ) : categories.length === 0 ? (
        <EmptyState
          icon={FolderTree}
          title={t('settings.project.classifications.empty.title')}
          description={t('settings.project.classifications.empty.description')}
        />
      ) : (
        <ul aria-labelledby="classifications-heading" className="space-y-2">
          {categories.map((category) => (
            <CategoryRow
              key={category.id}
              node={category}
              isOpen={openCategories.has(category.id)}
              openGroups={openGroups}
              onToggle={() => toggleCategory(category.id)}
              onToggleGroup={toggleGroup}
              actions={nodeActions(category)}
              addGroup={
                <AddButton
                  label={t('settings.project.classifications.addGroup')}
                  ariaLabel={t('settings.project.classifications.addUnderParent', {
                    parent: category.name,
                  })}
                  onClick={() => openAdd('group', category.id, category.name)}
                  disabled={busy}
                />
              }
              renderGroupActions={nodeActions}
              renderAddItem={(group) => (
                <AddButton
                  label={t('settings.project.classifications.addItem')}
                  ariaLabel={t('settings.project.classifications.addUnderParent', {
                    parent: group.name,
                  })}
                  onClick={() => openAdd('item', group.id, group.name)}
                  disabled={busy}
                />
              )}
              renderItemActions={nodeActions}
            />
          ))}
        </ul>
      )}

      {form !== null ? (
        <ClassificationFormDialog
          target={form}
          busy={busy}
          onSubmit={submitForm}
          onClose={() => setForm(null)}
        />
      ) : null}

      {deleteTarget !== null ? (
        <ClassificationDeleteDialog
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
