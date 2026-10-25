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
 * Classifications — the tree, read and write.
 *
 * Arbitrary depth, assembled client-side from one flat read:
 *
 *   level 1  تصنيف أساسي  → a folder; the roots of the screen
 *   level 2+ تصنيف فرعي   → a branch, nested under its parent, indent +16px
 *   any leaf              → a tag; the only deletable node, and the one a
 *                           future letter can select
 *
 * The depth is the database's to decide (there is no ceiling — see
 * 20261105000000_classifications_unbounded_depth.sql), so nothing here assumes
 * three levels: one recursive row component renders every node, and one open-set
 * tracks disclosure state for the whole tree.
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

/**
 * One row of the tree, plus its children when it is open.
 *
 * The design is depth-agnostic: there is no "category row / group row / item
 * row" trio any more, because the tree can be any number of levels deep. Every
 * node renders the same row and can be opened — including a leaf, which opens
 * onto an empty panel carrying the "add sub-classification" button, so
 * extending a branch never runs out of affordances however deep it goes.
 *
 * Three cues carry the depth, and they are complementary rather than
 * redundant, because indentation alone stops being legible past four or five
 * levels:
 *
 *   * indentation — every panel adds `INDENT_PX` of logical padding, so the
 *     tree reads as a staircase in both LTR and RTL (`paddingInlineStart`, not
 *     `padding-left`, which would indent the wrong edge in Arabic);
 *   * icon — a folder for the root of a branch, a layers icon for the levels
 *     below it, and a tag for a leaf (the nodes a letter can actually select);
 *   * the full path, as a tooltip on the row and as text in the edit dialog.
 */
const INDENT_PX = 16;

/** Folder for a branch, tag for a leaf — the leaf is what a letter can select. */
function levelIcon(node: ClassificationNode, isOpen: boolean): ReactNode {
  if (node.isLeaf && node.children.length === 0) {
    return <Tag className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />;
  }
  if (node.level <= 1) {
    const Icon = isOpen ? FolderOpen : Folder;
    return <Icon className="text-primary size-4 shrink-0" aria-hidden="true" />;
  }
  return <Layers className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />;
}

interface TreeNodeProps {
  readonly node: ClassificationNode;
  /** Ancestor names, ending with this node: the breadcrumb for this row. */
  readonly path: readonly string[];
  readonly open: ReadonlySet<string>;
  readonly busy: boolean;
  readonly onToggle: (id: string) => void;
  readonly onAddChild: (node: ClassificationNode) => void;
  readonly onEdit: (node: ClassificationNode) => void;
  readonly onToggleActive: (node: ClassificationNode) => void;
  readonly onDelete: (node: ClassificationNode) => void;
}

function TreeNode({
  node,
  path,
  open,
  busy,
  onToggle,
  onAddChild,
  onEdit,
  onToggleActive,
  onDelete,
}: TreeNodeProps) {
  const { t } = useI18n();
  const buttonId = `classification-${node.id}`;
  const panelId = `classification-panel-${node.id}`;
  const isOpen = open.has(node.id);
  const hasChildren = node.children.length > 0;
  const canDelete = node.isLeaf && !hasChildren;

  return (
    <li>
      <div className="hover:bg-muted/30 border-border bg-card flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
        <button
          type="button"
          id={buttonId}
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={() => onToggle(node.id)}
          /* The path is a tooltip rather than a column: a fifth-level row is
             already under width pressure at 16px of indent per level. */
          title={path.join(' / ')}
          className={TOGGLE_CLASS}
        >
          <ChevronDown
            className={`${CHEVRON_CLASS} ${isOpen ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
          {levelIcon(node, isOpen)}
          <span className="flex min-w-0 flex-1 items-baseline gap-2">
            <span
              className={
                node.level <= 1
                  ? 'text-foreground truncate text-sm font-semibold'
                  : 'text-foreground truncate text-sm font-medium'
              }
            >
              {node.name}
            </span>
            <span className="text-muted-foreground/70 shrink-0 font-mono text-xs">{node.code}</span>
          </span>
          <span className="text-muted-foreground hidden shrink-0 text-xs sm:inline">
            {t('settings.project.classifications.childCount', { count: node.children.length })}
          </span>
          <ClassificationStatus isActive={node.isActive} />
        </button>
        <RowActions
          node={node}
          canDelete={canDelete}
          busy={busy}
          onEdit={() => onEdit(node)}
          onToggleActive={() => onToggleActive(node)}
          onDelete={() => onDelete(node)}
        />
      </div>

      {isOpen ? (
        <div
          id={panelId}
          role="region"
          aria-labelledby={buttonId}
          style={{ paddingInlineStart: INDENT_PX }}
          className="border-primary/25 mt-1.5 space-y-1.5 border-s-2"
        >
          <div className="flex items-center justify-between gap-3 py-1">
            {/* The heading earns its place on the first two levels; deeper than
                that it would repeat on every row and crowd the indent, so the
                add button stands alone. */}
            {node.level <= 2 ? (
              <h3 className="text-muted-foreground text-[11px] font-semibold tracking-wide uppercase">
                {t('settings.project.classifications.childrenHeading')}
              </h3>
            ) : (
              <span />
            )}
            <AddButton
              label={t('settings.project.classifications.addChild')}
              ariaLabel={t('settings.project.classifications.addUnderParent', {
                parent: node.name,
              })}
              onClick={() => onAddChild(node)}
              disabled={busy}
            />
          </div>

          {hasChildren ? (
            <ul className="space-y-1.5">
              {node.children.map((child) => (
                <TreeNode
                  key={child.id}
                  node={child}
                  path={[...path, child.name]}
                  open={open}
                  busy={busy}
                  onToggle={onToggle}
                  onAddChild={onAddChild}
                  onEdit={onEdit}
                  onToggleActive={onToggleActive}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground py-1 text-sm">
              {t('settings.project.classifications.noChildren')}
            </p>
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

  /* One set for the whole tree: depth is unbounded, so a per-level pair of
     sets cannot describe it. */
  const [openNodes, setOpenNodes] = useState<ReadonlySet<string>>(() => new Set());
  const [form, setForm] = useState<ClassificationFormTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);

  const busy =
    createNode.isPending || renameNode.isPending || toggleNode.isPending || deleteNode.isPending;

  const toggleNodeOpen = useCallback((id: string) => {
    setOpenNodes((current) => toggleIn(current, id));
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

  function openAdd(
    kind: ClassificationNodeKind,
    parentId?: string,
    parentName?: string,
    parentPath?: readonly string[],
  ) {
    setBanner(null);
    setForm({ kind, mode: 'create', parentId, parentName, parentPath });
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
      nodePath: pathOf(node.id),
    });
  }

  function submitForm(name: string) {
    if (form === null) {
      return;
    }
    setBanner(null);

    if (form.mode === 'create') {
      const parentId = form.parentId;
      /* A category has no parent; a group's parent is its category and an
         item's parent is its group. That is the whole contract — the level is
         the server's to derive. */
      createNode.mutate(parentId === undefined ? { name } : { name, parentId }, {
        onSuccess: () => {
          /* Reveal what was just created: a new group opens its category, a new
             item opens its group. Saves two clicks and makes the result obvious. */
          if (parentId !== undefined) {
            /* Reveal what was just created: opening the parent is what makes
               the new row visible. One set, whatever the depth. */
            setOpenNodes((current) => withId(current, parentId));
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
   * Names from the root down to `id`, for the breadcrumb shown in the edit
   * dialog. Walks the read tree rather than reading a `path` column: the tree
   * is already in memory, and a stored path would be one more thing to keep in
   * step with `parent_id` on every write.
   */
  function pathOf(id: string): readonly string[] {
    const walk = (
      nodes: readonly ClassificationNode[],
      trail: readonly string[],
    ): readonly string[] | null => {
      for (const node of nodes) {
        const next = [...trail, node.name];
        if (node.id === id) {
          return next;
        }
        const found = walk(node.children, next);
        if (found !== null) {
          return found;
        }
      }
      return null;
    };
    return walk(query.data ?? [], []) ?? [];
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
            <TreeNode
              key={category.id}
              node={category}
              path={[category.name]}
              open={openNodes}
              busy={busy}
              onToggle={toggleNodeOpen}
              onAddChild={(parent) =>
                openAdd(kindOfLevel(parent.level + 1), parent.id, parent.name, pathOf(parent.id))
              }
              onEdit={openEdit}
              onToggleActive={toggleActive}
              onDelete={(node) => {
                setBanner(null);
                setDeleteTarget({ id: node.id, name: node.name, code: node.code });
              }}
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
