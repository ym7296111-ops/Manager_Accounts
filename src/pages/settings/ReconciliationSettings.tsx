import { useState } from 'react';
import { setReconciliationSettings, useReconciliationSettings } from '@/hooks/useApsReconciliation';
import { useI18n } from '@/i18n/I18nContext';
import type {
  ReconciliationClassification,
  ReconciliationSettings as Settings,
} from '@/lib/apsReconciliation';
import { useUnsavedChangesRegistration } from './unsavedChanges';

const button =
  'rounded-lg border border-border px-3 py-2 text-sm font-semibold disabled:opacity-50';
export default function ReconciliationSettings() {
  const { t } = useI18n();
  const query = useReconciliationSettings();
  if (query.isPending) return <p>{t('aps.recon.loading')}</p>;
  if (!query.data)
    return (
      <div role="alert">
        <p>{t('aps.recon.v2.settingsError')}</p>
        <button type="button" className={button} onClick={() => void query.refetch()}>
          {t('aps.recon.retry')}
        </button>
      </div>
    );
  return <SettingsEditor initial={query.data} refetch={query.refetch} />;
}
function SettingsEditor({
  initial,
  refetch,
}: {
  initial: Settings;
  refetch: ReturnType<typeof useReconciliationSettings>['refetch'];
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState(initial.selected);
  const [baseline, setBaseline] = useState(initial.selected);
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
    setSelected((old) =>
      old.includes(node.id) ? old.filter((id) => id !== node.id) : [...old, node.id],
    );
    setMessage('');
  }
  function renderNode(node: ReconciliationClassification, ancestors: Set<string>) {
    if (ancestors.has(node.id)) return null;
    const children = nodes.filter((n) => n.parent_id === node.id);
    const overlap = selected.some(
      (id) => id !== node.id && (isAncestor(id, node.id) || isAncestor(node.id, id)),
    );
    const hasLeaf = node.is_leaf || nodes.some((n) => n.is_leaf && isAncestor(node.id, n.id));
    const next = new Set(ancestors).add(node.id);
    return (
      <li key={node.id} className="space-y-1">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={selected.includes(node.id)}
            disabled={
              busy || (!selected.includes(node.id) && (!node.is_active || overlap || !hasLeaf))
            }
            onChange={() => toggle(node)}
          />{' '}
          <span>{node.name}</span>
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
      await setReconciliationSettings(selected);
      const result = await refetch();
      if (
        !result.data ||
        result.isError ||
        [...result.data.selected].sort().join(',') !== [...selected].sort().join(',')
      )
        throw new Error('not confirmed');
      setBaseline(result.data.selected);
      setMessage(t('aps.recon.v2.settingsSaved'));
    } catch {
      setMessage(t('aps.recon.v2.settingsFailed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-4">
      <p>{t('aps.recon.v2.settingsIntro')}</p>
      <ul className="space-y-2">
        {nodes
          .filter((n) => n.parent_id === null || !nodes.some((p) => p.id === n.parent_id))
          .map((n) => renderNode(n, new Set()))}
      </ul>
      {!selected.length && <p role="alert">{t('aps.recon.v2.settingsEmpty')}</p>}
      <button
        type="button"
        className={button}
        disabled={busy || !dirty || !selected.length}
        onClick={() => void save()}
      >
        {t('aps.recon.save')}
      </button>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
