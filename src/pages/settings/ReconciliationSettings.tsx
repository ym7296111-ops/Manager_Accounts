import { useState } from 'react';
import {
  createReconciliationScope,
  renameReconciliationScope,
  archiveReconciliationScope,
  deleteReconciliationScope,
  setReconciliationSettings,
  useReconciliationSettings,
  useReconciliationScopes,
  useOtherReconciliationSettings,
} from '@/hooks/useApsReconciliation';
import { useI18n } from '@/i18n/I18nContext';
import type {
  ReconciliationClassification,
  ReconciliationSettings as Settings,
} from '@/lib/apsReconciliation';
import { ReconciliationError } from '@/lib/apsReconciliation';
import { useUnsavedChangesRegistration } from './unsavedChanges';

const button =
  'rounded-lg border border-border px-3 py-2 text-sm font-semibold disabled:opacity-50';
export default function ReconciliationSettings() {
  const { t } = useI18n();
  const scopes = useReconciliationScopes();
  const [chosen, setChosen] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [message, setMessage] = useState('');
  const scope = scopes.data?.find((s) => s.id === chosen) ?? scopes.data?.find((s) => s.is_default);
  const query = useReconciliationSettings(scope?.id ?? null);
  const others = useOtherReconciliationSettings(
    (scopes.data ?? []).filter((s) => s.is_active && s.id !== scope?.id).map((s) => s.id),
  );
  async function perform(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setMessage('');
    try {
      await action();
      await scopes.refetch();
      setName('');
    } catch {
      setMessage(t('aps.recon.v3.scopeError'));
    } finally {
      setBusy(false);
    }
  }
  async function removeScope(id: string) {
    if (busy || !window.confirm(t('aps.recon.v3.deleteScopeConfirm'))) return;
    if (dirty && !window.confirm(t('aps.recon.v3.settingsDiscardConfirm'))) return;
    setBusy(true);
    setMessage('');
    try {
      await deleteReconciliationScope(id);
      const result = await scopes.refetch();
      if (result.isError || !result.data || result.data.some((s) => s.id === id))
        throw new Error('unconfirmed');
      setChosen('');
      setDirty(false);
      setMessage(t('aps.recon.v3.deleteScopeSuccess'));
    } catch (e) {
      setMessage(
        e instanceof ReconciliationError && e.code === '23503'
          ? t('aps.recon.v3.deleteScopeHistory')
          : t('aps.recon.v3.scopeError'),
      );
    } finally {
      setBusy(false);
    }
  }
  if (scopes.isPending) return <p>{t('aps.recon.loading')}</p>;
  if (!scopes.data || scopes.isError)
    return (
      <div role="alert">
        {t('aps.recon.v2.settingsError')}
        <button className={button} onClick={() => void scopes.refetch()}>
          {t('aps.recon.retry')}
        </button>
      </div>
    );
  return (
    <div className="space-y-4">
      <h2>{t('aps.recon.v3.scopes')}</h2>
      <label>
        {t('aps.recon.v3.scope')}{' '}
        <select
          value={scope?.id ?? ''}
          disabled={busy}
          onChange={(e) => {
            if (!dirty || window.confirm(t('aps.recon.v3.settingsDiscardConfirm'))) {
              setChosen(e.target.value);
              setDirty(false);
            }
          }}
        >
          {scopes.data.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {!s.is_active ? ` (${t('aps.recon.v3.scopeArchived')})` : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t('aps.recon.v3.scopeName')}{' '}
        <input value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
      </label>
      <button
        className={button}
        disabled={busy || !name.trim()}
        onClick={() => void perform(() => createReconciliationScope(name.trim()))}
      >
        {t('aps.recon.v3.scopeCreate')}
      </button>
      <button
        className={button}
        disabled={busy || !name.trim() || !scope}
        onClick={() => void perform(() => renameReconciliationScope(scope!.id, name.trim()))}
      >
        {t('aps.recon.v3.scopeRename')}
      </button>
      <button
        className={button}
        disabled={busy || !scope?.is_active || scope.is_default}
        onClick={() => {
          if (window.confirm(t('aps.recon.v3.scopeArchive')))
            void perform(() => archiveReconciliationScope(scope!.id));
        }}
      >
        {t('aps.recon.v3.scopeArchive')}
      </button>
      {scope && !scope.is_default && (
        <button
          type="button"
          className={button}
          disabled={busy}
          onClick={() => void removeScope(scope.id)}
        >
          {t('aps.recon.v3.deleteScope')}
        </button>
      )}
      {message && <p role="alert">{message}</p>}
      {scope && query.isPending && <p>{t('aps.recon.loading')}</p>}
      {query.isError && (
        <div role="alert">
          {t('aps.recon.v2.settingsError')}
          <button className={button} onClick={() => void query.refetch()}>
            {t('aps.recon.retry')}
          </button>
        </div>
      )}
      {others.some((q) => q.isError) && (
        <div role="alert">
          {t('aps.recon.v3.scopeError')}{' '}
          <button
            type="button"
            className={button}
            onClick={() => {
              others.forEach((q) => {
                if (q.isError) void q.refetch();
              });
            }}
          >
            {t('aps.recon.retry')}
          </button>
        </div>
      )}
      {scope && query.data && (
        <SettingsEditor
          key={scope.id}
          initial={query.data}
          refetch={query.refetch}
          disabled={!scope.is_active || busy || others.some((q) => !q.data || q.isError)}
          others={others.flatMap((q) => (q.data ? [q.data] : []))}
          onDirty={setDirty}
        />
      )}
    </div>
  );
}
function SettingsEditor({
  initial,
  refetch,
  disabled,
  others,
  onDirty,
}: {
  initial: Settings;
  refetch: ReturnType<typeof useReconciliationSettings>['refetch'];
  disabled: boolean;
  others: Settings[];
  onDirty: (value: boolean) => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState(initial.selected);
  const [baseline, setBaseline] = useState(initial.selected);
  const [revision, setRevision] = useState(initial.revision_id);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const dirty = [...selected].sort().join(',') !== [...baseline].sort().join(',');
  useUnsavedChangesRegistration(dirty, 'reconciliation-settings');
  const nodes = initial.classifications;
  function isAncestor(ancestor: string, descendant: string) {
    const seen = new Set<string>();
    let current = nodes.find((n) => n.id === descendant);
    while (current?.parent_id && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.parent_id === ancestor) return true;
      current = nodes.find((n) => n.id === current?.parent_id);
    }
    return false;
  }
  function toggle(node: ReconciliationClassification) {
    const next = selected.includes(node.id)
      ? selected.filter((id) => id !== node.id)
      : [...selected, node.id];
    setSelected(next);
    onDirty([...next].sort().join(',') !== [...baseline].sort().join(','));
    setMessage('');
  }
  function renderNode(node: ReconciliationClassification, ancestors: Set<string>) {
    if (ancestors.has(node.id)) return null;
    const children = nodes.filter((n) => n.parent_id === node.id);
    const overlap = selected.some(
      (id) => id !== node.id && (isAncestor(id, node.id) || isAncestor(node.id, id)),
    );
    const owned =
      node.is_leaf &&
      others.some((other) =>
        other.selected.some((id) => id === node.id || isAncestor(id, node.id)),
      );
    const hasLeaf = node.is_leaf;
    const next = new Set(ancestors).add(node.id);
    return (
      <li key={node.id} className="space-y-1">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={selected.includes(node.id)}
            disabled={
              busy ||
              disabled ||
              (!selected.includes(node.id) && (!node.is_active || overlap || !hasLeaf || owned))
            }
            onChange={() => toggle(node)}
          />{' '}
          <span>{node.name}</span>
          {owned && <span>({t('aps.recon.v3.scopeOwners')})</span>}
          {!node.is_active && (
            <span className="text-muted-foreground text-xs">({t('aps.recon.v2.inactive')})</span>
          )}
        </label>
        {children.length > 0 && (
          <ul className="ms-6 space-y-1 border-s ps-3">
            {children.map((child) => renderNode(child, next))}
          </ul>
        )}
      </li>
    );
  }
  async function save() {
    if (busy || !dirty || !selected.length) return;
    setBusy(true);
    setMessage('');
    try {
      await setReconciliationSettings(initial.scope_id, selected, revision);
      const result = await refetch();
      if (
        !result.data ||
        result.isError ||
        [...result.data.selected].sort().join(',') !== [...selected].sort().join(',')
      )
        throw new Error('not confirmed');
      setBaseline(result.data.selected);
      setRevision(result.data.revision_id);
      onDirty(false);
      setMessage(t('aps.recon.v2.settingsSaved'));
    } catch {
      setMessage(t('aps.recon.v3.scopeConflict'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <p>{t('aps.recon.v3.scopeBranches')}</p>
      <ul className="space-y-2">
        {nodes
          .filter((n) => n.parent_id === null || !nodes.some((p) => p.id === n.parent_id))
          .map((n) => renderNode(n, new Set()))}
      </ul>
      {!selected.length && <p role="alert">{t('aps.recon.v2.settingsEmpty')}</p>}
      <button
        type="button"
        className={button}
        disabled={busy || disabled || !dirty || !selected.length}
        onClick={() => void save()}
      >
        {t('aps.recon.save')}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
