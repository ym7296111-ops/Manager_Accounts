import {
  Ban,
  ChevronDown,
  Folder,
  FolderOpen,
  FolderTree,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  Tag,
} from 'lucide-react';
import { useCallback, useState } from 'react';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusIcon } from '@/components/ui/StatusIcon';
import {
  classifyClassificationsError,
  useClassifications,
  type ClassificationNode,
  type ClassificationsErrorCode,
} from '@/hooks/useClassifications';
import { useI18n, type TranslationKey } from '@/i18n/I18nContext';

/**
 * Classifications — read-only tree (Phase 2).
 *
 * One flat read (`useClassifications`) is assembled into three levels:
 *
 *   level 1  فئة رئيسية  → an accordion row, collapsed by default
 *   level 2  مجموعة      → an accordion row inside the category panel
 *   level 3  صنف         → a flat row inside the group panel
 *
 * The level is not read from the wire: `parent_id` is the only structural
 * input, exactly as on the server, so a row cannot claim a level that
 * contradicts where it is rendered. `isLeaf` is the server's derived flag and
 * is carried on the node for the future letter-creation screen, which may only
 * offer leaves — the tree still renders every node, because a non-leaf is a
 * legitimate container.
 *
 * Every add affordance is rendered on purpose and refused on purpose: the
 * write path is not part of this phase, so the buttons are `disabled` and
 * describe themselves as such (`aria-describedby` → a visually hidden note)
 * rather than looking live and doing nothing.
 *
 * ARIA: this is a nested list, not `role="tree"`. A tree role promises
 * roving-tabindex and arrow-key navigation; shipping the role without the
 * keyboard model would announce a widget that does not behave like one.
 * Disclosure rows (`aria-expanded` + `aria-controls` → `role="region"`) are the
 * pattern already used by Stations & Warehouses.
 */

const READ_ERROR_KEY: Record<ClassificationsErrorCode, TranslationKey> = {
  forbidden: 'settings.project.classifications.error.forbidden',
  unavailable: 'settings.project.classifications.error.unavailable',
  network: 'settings.project.classifications.error.network',
  unknown: 'settings.project.classifications.error.unknown',
};

/** Shared description for the not-yet-wired add buttons. */
const ADD_HINT_ID = 'classifications-add-hint';

const TOGGLE_CLASS =
  'focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-3 rounded-lg text-start focus-visible:ring-2 focus-visible:outline-none';

const CHEVRON_CLASS = 'text-muted-foreground size-4 shrink-0 transition-transform';

const ADD_BUTTON_CLASS =
  'text-primary inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';

function AddButton({ label }: { readonly label: string }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      disabled
      aria-describedby={ADD_HINT_ID}
      title={t('settings.project.classifications.addHint')}
      className={`${ADD_BUTTON_CLASS} border-border border`}
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

/** `level 3` row. The schema caps the tree at three levels, so it has no children. */
function ItemRow({ node }: { readonly node: ClassificationNode }) {
  return (
    <li className="bg-card border-border flex items-center gap-3 rounded-lg border px-3 py-2">
      <Tag className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
      <span className="text-foreground min-w-0 flex-1 truncate text-sm">{node.name}</span>
      <span className="text-muted-foreground/70 shrink-0 font-mono text-xs">{node.code}</span>
      <ClassificationStatus isActive={node.isActive} />
    </li>
  );
}

function GroupRow({
  node,
  isOpen,
  onToggle,
}: {
  readonly node: ClassificationNode;
  readonly isOpen: boolean;
  readonly onToggle: () => void;
}) {
  const { t } = useI18n();
  const buttonId = `classification-group-${node.id}`;
  const panelId = `classification-group-panel-${node.id}`;

  return (
    <li className="bg-background border-border rounded-lg border">
      <div className="hover:bg-muted/30 flex items-center gap-2 px-3 py-2">
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
            <AddButton label={t('settings.project.classifications.addItem')} />
          </div>

          {node.children.length === 0 ? (
            <p className="text-muted-foreground py-1 text-sm">
              {t('settings.project.classifications.noItems')}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {node.children.map((item) => (
                <ItemRow key={item.id} node={item} />
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
}: {
  readonly node: ClassificationNode;
  readonly isOpen: boolean;
  readonly openGroups: ReadonlySet<string>;
  readonly onToggle: () => void;
  readonly onToggleGroup: (id: string) => void;
}) {
  const { t } = useI18n();
  const buttonId = `classification-category-${node.id}`;
  const panelId = `classification-category-panel-${node.id}`;
  const FolderIcon = isOpen ? FolderOpen : Folder;

  return (
    <li className="border-border bg-card overflow-hidden rounded-xl border">
      <div className="hover:bg-muted/30 flex items-center gap-2 px-4 py-3">
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
            <AddButton label={t('settings.project.classifications.addGroup')} />
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

export default function Classifications() {
  const { t } = useI18n();
  const query = useClassifications();
  const [openCategories, setOpenCategories] = useState<ReadonlySet<string>>(() => new Set());
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());

  const toggleCategory = useCallback((id: string) => {
    setOpenCategories((current) => toggleIn(current, id));
  }, []);

  const toggleGroup = useCallback((id: string) => {
    setOpenGroups((current) => toggleIn(current, id));
  }, []);

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
        <AddButton label={t('settings.project.classifications.addCategory')} />
      </div>

      {/* One hint node for every add button: disabled buttons are skipped by
          keyboard navigation, so the "why" has to be reachable another way. */}
      <p id={ADD_HINT_ID} className="sr-only">
        {t('settings.project.classifications.addHint')}
      </p>

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
            />
          ))}
        </ul>
      )}
    </section>
  );
}
