import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router';
import { ModalShell } from '@/components/ui/ModalShell';
import { useAuth } from '@/context/AuthContext';
import {
  closeReconciliation,
  openReconciliation,
  recordReconciliation,
  refreshReconciliation,
  reopenReconciliation,
  useReconciliationOptions,
  useReconciliationState,
  useReconciliationScopes,
  syncReconciliation,
  useCanDeleteReconciliationSession,
  deleteReconciliationSession,
} from '@/hooks/useApsReconciliation';
import { useI18n } from '@/i18n/I18nContext';
import { createDraftStorage } from '@/lib/reconciliationDraftStorage';
import {
  makeDraft,
  normalizeReconciliationAmount,
  ReconciliationError,
  type ReconciliationLine,
  type ReconciliationState,
  type RecordAmounts,
  type Draft,
} from '@/lib/apsReconciliation';
import {
  button,
  EntryDialog,
  ReconciliationTables,
} from './reconciliation/ReconciliationComponents';

function consistent(pages: ReconciliationState[]) {
  const first = pages[0]?.selected_session;
  const lines = pages.flatMap((p) => p.selected_lines);
  return (
    pages.every(
      (p) =>
        p.selected_session?.id === first?.id &&
        p.selected_session?.snapshot_version === first?.snapshot_version &&
        p.selected_session?.config_generation === first?.config_generation &&
        p.current_config_revision_id === pages[0]?.current_config_revision_id &&
        p.selected_session?.status === first?.status,
    ) && new Set(lines.map((l) => l.id)).size === lines.length
  );
}
function confirmed(line: ReconciliationLine, draft: Draft) {
  const a = draft.submitted;
  return (
    !!a &&
    !draft.conflicted &&
    BigInt(line.version) > BigInt(draft.version) &&
    line.monthly.accountant_inbound === a.monthlyInbound &&
    line.monthly.accountant_outbound === a.monthlyOutbound &&
    line.ytd.accountant_inbound === a.ytdInbound &&
    line.ytd.accountant_outbound === a.ytdOutbound &&
    (a.opening === null
      ? line.ytd.accountant_opening_source !== 'manual'
      : line.ytd.accountant_opening_source === 'manual' &&
        line.ytd.accountant_opening === a.opening)
  );
}
export default function ApsReconciliationPage() {
  const { session } = useAuth();
  return <Page key={session?.user.id ?? ''} actor={session?.user.id ?? ''} />;
}
function Page({ actor }: { actor: string }) {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const optionsQuery = useReconciliationOptions(),
    options = optionsQuery.data;
  const requested = params.get('month');
  const invalidMonth = !!options && !!requested && !options.months.some((m) => m.id === requested);
  const month =
    !options || invalidMonth
      ? ''
      : requested === null
        ? (options.months.find((m) => m.is_active)?.id ?? '')
        : requested;
  const scopesQuery = useReconciliationScopes();
  const requestedScope = params.get('scope');
  const scope =
    requestedScope === null
      ? (scopesQuery.data?.find((s) => s.is_default)?.id ?? '')
      : scopesQuery.data?.some((s) => s.id === requestedScope)
        ? requestedScope
        : '';
  const query = useReconciliationState(month || null, scope || null);
  const pages = query.data?.pages ?? [],
    first = pages[0],
    session = first?.selected_session;
  const deleteEligibility = useCanDeleteReconciliationSession(
    session?.id ?? null,
    session?.snapshot_version ?? null,
    !!options?.can_manage && session?.status === 'open',
  );
  const lines = pages.flatMap((p) => p.selected_lines),
    inconsistent = !consistent(pages);
  const storageKey = `aps-reconciliation-v3-drafts:${actor}`;
  const [storage] = useState(() => createDraftStorage(storageKey));
  const [legacyStorage] = useState(() =>
    createDraftStorage(`aps-reconciliation-v2-drafts:${actor}`),
  );
  const [legacyDrafts, setLegacyDrafts] = useState(() => legacyStorage.initial);
  const storageMode = useSyncExternalStore(storage.subscribe, storage.getMode, storage.getMode);
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => storage.initial);
  const [editing, setEditing] = useState<string | null>(null),
    [notice, setNotice] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [mustRefresh, setMustRefresh] = useState(false);
  const [operation, setOperation] = useState<'close' | 'reopen' | null>(null),
    [reason, setReason] = useState('');
  const locked = useRef(false);
  const draftKey = (id: string) => `${scope}:${month}:${session?.id ?? ''}:${id}`;
  const monthDrafts = Object.keys(drafts).filter((k) =>
    k.startsWith(`${scope}:${month}:${session?.id ?? ''}:`),
  );
  const isDefault = scopesQuery.data?.find((s) => s.id === scope)?.is_default;
  const legacyKeys = isDefault
    ? Object.keys(legacyDrafts).filter((k) => k.startsWith(`${month}:${session?.id ?? ''}:`))
    : [];
  const hasDrafts = monthDrafts.length > 0 || legacyKeys.length > 0 || editing !== null;
  const hasAnyDrafts =
    Object.keys(drafts).length > 0 || Object.keys(legacyDrafts).length > 0 || editing !== null;
  const draftIds = new Set(monthDrafts.map((k) => k.slice(k.lastIndexOf(':') + 1)));
  const selectedLine = lines.find((l) => l.id === editing);
  const readOnly =
    busy ||
    mustRefresh ||
    inconsistent ||
    query.isError ||
    query.isFetching ||
    !options?.can_manage ||
    !session ||
    session.status !== 'open' ||
    session.needs_review;
  useEffect(() => {
    storage.persist(drafts);
  }, [drafts, storage]);
  useEffect(() => {
    if (!Object.keys(drafts).length) return;
    const before = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', before);
    return () => window.removeEventListener('beforeunload', before);
  }, [drafts]);
  function setDraft(line: ReconciliationLine, draft: Draft) {
    setDrafts((old) => ({ ...old, [draftKey(line.id)]: draft }));
  }
  function showError(e: unknown) {
    setError(
      e instanceof ReconciliationError && e.code === '42501'
        ? t('aps.recon.forbidden')
        : e instanceof ReconciliationError && e.code === '40001'
          ? t('aps.recon.v3.concurrentChange')
          : t('aps.recon.requestError'),
    );
  }
  async function reload(confirmDrafts = true): Promise<ReconciliationState[] | null> {
    const result = await query.refetch();
    if (result.isError || !result.data || !consistent(result.data.pages)) {
      setMustRefresh(true);
      return null;
    }
    const resultPages = result.data.pages;
    const current = resultPages[0]?.selected_session;
    const currentLines = resultPages.flatMap((p) => p.selected_lines);
    setDrafts((old) => {
      const next = { ...old };
      for (const line of currentLines) {
        const key = `${scope}:${month}:${current?.id ?? ''}:${line.id}`;
        const draft = next[key];
        if (confirmDrafts && draft && confirmed(line, draft)) delete next[key];
      }
      return next;
    });
    setMustRefresh(false);
    return resultPages;
  }
  async function run(action: () => Promise<unknown>, success: string) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      const latest = await reload();
      setNotice(latest ? success : t('aps.recon.v2.draftUnconfirmed'));
    } catch (e) {
      showError(e);
      setMustRefresh(true);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function removeSession() {
    if (
      !session ||
      locked.current ||
      busy ||
      hasAnyDrafts ||
      query.isError ||
      query.isFetching ||
      mustRefresh ||
      inconsistent ||
      deleteEligibility.data !== true ||
      deleteEligibility.isFetching
    )
      return;
    if (!window.confirm(t('aps.recon.v3.deleteSessionConfirm'))) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await deleteReconciliationSession(session.id);
      const latest = await reload(false);
      if (!latest || latest[0]?.selected_session?.id === session.id) {
        setMustRefresh(true);
        setError(t('aps.recon.v2.draftUnconfirmed'));
      } else setNotice(t('aps.recon.v3.deleteSessionSuccess'));
    } catch (e) {
      showError(e);
      setMustRefresh(true);
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function save(line: ReconciliationLine, draft: Draft) {
    if (locked.current || readOnly || draft.version !== line.version || draft.submitted) return;
    const monthlyInbound = normalizeReconciliationAmount(draft.monthlyInbound),
      monthlyOutbound = normalizeReconciliationAmount(draft.monthlyOutbound),
      ytdInbound = normalizeReconciliationAmount(draft.ytdInbound),
      ytdOutbound = normalizeReconciliationAmount(draft.ytdOutbound),
      opening = draft.manual ? normalizeReconciliationAmount(draft.opening) : null;
    if (
      monthlyInbound === null ||
      monthlyOutbound === null ||
      ytdInbound === null ||
      ytdOutbound === null ||
      (draft.manual && opening === null)
    ) {
      setError(t('aps.recon.invalidAmount'));
      return;
    }
    const amounts: RecordAmounts = {
      monthlyInbound,
      monthlyOutbound,
      ytdInbound,
      ytdOutbound,
      opening,
    };
    const submitted = { ...draft, submitted: amounts };
    setDraft(line, submitted);
    locked.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await recordReconciliation(
        session.id,
        scope,
        line.id,
        line.classification_id,
        session.config_generation,
        amounts,
        draft.version,
      );
      const latest = await reload();
      const fresh = latest?.flatMap((p) => p.selected_lines).find((l) => l.id === line.id);
      if (fresh && confirmed(fresh, submitted)) {
        setEditing(null);
        setNotice(t('aps.recon.v2.draftSaved'));
      } else {
        setMustRefresh(true);
        setError(t('aps.recon.v2.draftUnconfirmed'));
      }
    } catch (e) {
      if (e instanceof ReconciliationError && e.code === '40001') {
        // The write was rejected, even if another actor stored identical values.
        setDraft(line, { ...submitted, conflicted: true });
        const latest = await reload(false);
        setError(t('aps.recon.v2.versionConflict'));
        if (!latest) setMustRefresh(true);
      } else {
        showError(e);
        setMustRefresh(true);
      }
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function rebase(line: ReconciliationLine, draft: Draft) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const latest = await reload();
      const fresh = latest?.flatMap((p) => p.selected_lines).find((l) => l.id === line.id);
      if (!fresh) {
        setError(t('aps.recon.v2.draftUnconfirmed'));
        return;
      }
      if (confirmed(fresh, draft)) {
        setEditing(null);
        setNotice(t('aps.recon.v2.draftSaved'));
        return;
      }
      setError(t('aps.recon.v2.versionConflict'));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  function acceptCurrent(line: ReconciliationLine, draft: Draft) {
    if (mustRefresh || query.isError || query.isFetching || inconsistent || busy) return;
    if (window.confirm(t('aps.recon.v2.rebaseConfirm'))) {
      setDraft(line, {
        ...draft,
        version: line.version,
        submitted: undefined,
        conflicted: undefined,
      });
      setError(null);
    }
  }
  const reasons: Record<string, string> = {
    no_eligible_open_sessions: t('aps.recon.noEligible'),
    other_open_sessions: t('aps.recon.v2.otherSessions'),
    needs_review: t('aps.recon.v2.needsReview'),
    incomplete: t('aps.recon.v2.incomplete'),
    missing_system_opening: t('aps.recon.v2.missingOpening'),
    nonzero_differences: t('aps.recon.v2.differences'),
  };
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-bold">{t('aps.recon.title')}</h1>
        <p className="text-muted-foreground text-sm">{t('aps.recon.v3.treeWarning')}</p>
      </header>
      {storageMode !== 'local' && (
        <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
          {t(
            storageMode === 'session'
              ? 'aps.recon.v2.sessionStorageWarning'
              : 'aps.recon.v2.memoryStorageWarning',
          )}
        </p>
      )}
      {optionsQuery.isPending && <p>{t('aps.recon.loading')}</p>}
      {optionsQuery.isError && (
        <div role="alert">
          <p>{t('aps.recon.requestError')}</p>
          <button type="button" className={button} onClick={() => void optionsQuery.refetch()}>
            {t('aps.recon.retry')}
          </button>
        </div>
      )}
      {scopesQuery.isError && (
        <div role="alert">
          {t('aps.recon.requestError')}
          <button className={button} onClick={() => void scopesQuery.refetch()}>
            {t('aps.recon.retry')}
          </button>
        </div>
      )}
      {scopesQuery.data && (
        <label className="grid max-w-sm gap-1 text-sm font-semibold">
          {t('aps.recon.v3.scope')}
          <select
            value={scope}
            disabled={busy}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              next.set('scope', e.target.value);
              next.delete('station');
              setParams(next);
              setEditing(null);
              setError(null);
              setNotice(null);
              setMustRefresh(false);
            }}
          >
            <option value="">{t('aps.recon.v3.scopeChoose')}</option>
            {scopesQuery.data.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {!s.is_active ? ` (${t('aps.recon.v3.scopeArchived')})` : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      {options && (
        <label className="grid max-w-sm gap-1 text-sm font-semibold">
          {t('aps.recon.month')}
          <select
            className="bg-card border-border rounded border p-2"
            value={month}
            disabled={busy}
            onChange={(e) => {
              const next = new URLSearchParams(params);
              next.set('month', e.target.value);
              next.delete('station');
              setParams(next);
              setEditing(null);
              setError(null);
              setNotice(null);
              setMustRefresh(false);
            }}
          >
            <option value="">{t('aps.recon.chooseMonth')}</option>
            {options.months.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {invalidMonth && <p role="alert">{t('aps.recon.v2.v2Select')}</p>}
      {options && !options.months.length && <p>{t('aps.recon.v2.v2Empty')}</p>}
      {month && scope && query.isPending && <p>{t('aps.recon.loading')}</p>}
      {query.isError && (
        <div role="alert">
          <p>{t('aps.recon.requestError')}</p>
          {!first && (
            <button
              type="button"
              className={button}
              onClick={() => void run(async () => {}, t('aps.recon.updated'))}
            >
              {t('aps.recon.retry')}
            </button>
          )}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && !editing && <p role="alert">{error}</p>}
      {first && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span>
              {t('aps.recon.v2.v2Status')}:{' '}
              {session
                ? t(session.status === 'open' ? 'aps.recon.status.open' : 'aps.recon.status.closed')
                : t('aps.recon.v2.noSession')}
            </span>
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() => void run(async () => {}, t('aps.recon.updated'))}
            >
              {t('aps.recon.v2.refreshRead')}
            </button>
            <button
              type="button"
              className={button}
              disabled={
                busy ||
                query.isError ||
                query.isFetching ||
                mustRefresh ||
                inconsistent ||
                !options?.can_manage ||
                !!session ||
                !scopesQuery.data?.find((s) => s.id === scope)?.is_active
              }
              onClick={() =>
                void run(() => openReconciliation(month, scope), t('aps.recon.openSuccess'))
              }
            >
              {t('aps.recon.v2.v2Open')}
            </button>
            {session?.status === 'open' && (
              <button
                type="button"
                className={button}
                disabled={
                  busy ||
                  query.isError ||
                  query.isFetching ||
                  mustRefresh ||
                  inconsistent ||
                  !options?.can_manage
                }
                onClick={() =>
                  void run(() => refreshReconciliation(session.id, scope), t('aps.recon.updated'))
                }
              >
                {t('aps.recon.v2.refreshSnapshot')}
              </button>
            )}
            <button
              type="button"
              className={button}
              disabled={
                busy ||
                query.isError ||
                query.isFetching ||
                mustRefresh ||
                inconsistent ||
                hasDrafts ||
                !options?.can_close ||
                !first.flags.can_close_now
              }
              onClick={() => {
                setOperation('close');
                setReason('');
              }}
            >
              {t('aps.recon.v3.closeScope')}
            </button>
            {session?.status === 'open' &&
              options?.can_manage &&
              deleteEligibility.data === true && (
                <button
                  type="button"
                  className={button}
                  disabled={
                    busy ||
                    query.isError ||
                    query.isFetching ||
                    mustRefresh ||
                    inconsistent ||
                    hasAnyDrafts ||
                    deleteEligibility.isFetching
                  }
                  onClick={() => void removeSession()}
                >
                  {t('aps.recon.v3.deleteSession')}
                </button>
              )}
            {options?.can_reopen_as_owner && session?.status === 'closed' && (
              <button
                type="button"
                className={button}
                disabled={
                  busy ||
                  query.isError ||
                  query.isFetching ||
                  mustRefresh ||
                  inconsistent ||
                  hasDrafts
                }
                onClick={() => {
                  setOperation('reopen');
                  setReason('');
                }}
              >
                {t('aps.recon.reopen')}
              </button>
            )}
          </div>
          {first.historical_overlap && <p role="alert">{t('aps.recon.v3.historicalOverlap')}</p>}
          {session && first.flags.settings_changed === null && (
            <p>{t('aps.recon.v3.unknownSettings')}</p>
          )}
          {session?.status === 'open' &&
            first.flags.can_sync_from_settings === true &&
            first.flags.settings_changed === true && (
              <div>
                <p>{t('aps.recon.v3.syncWarning')}</p>
                {hasAnyDrafts && <p role="alert">{t('aps.recon.v3.syncDraft')}</p>}
                <button
                  type="button"
                  className={button}
                  disabled={
                    hasAnyDrafts ||
                    busy ||
                    query.isFetching ||
                    query.isError ||
                    mustRefresh ||
                    inconsistent
                  }
                  onClick={() => {
                    if (hasAnyDrafts || !window.confirm(t('aps.recon.v3.syncWarning'))) return;
                    void run(
                      () =>
                        syncReconciliation(
                          session.id,
                          scope,
                          session.snapshot_version,
                          session.config_generation,
                          first.current_config_revision_id,
                        ),
                      t('aps.recon.v3.syncDone'),
                    );
                  }}
                >
                  {t('aps.recon.v3.sync')}
                </button>
              </div>
            )}
          {Object.keys(drafts).filter((key) => !lines.some((line) => draftKey(line.id) === key))
            .length > 0 && (
            <section>
              <p role="alert">{t('aps.recon.v3.orphanDraft')}</p>
              {Object.keys(drafts)
                .filter((key) => !lines.some((line) => draftKey(line.id) === key))
                .map((key) => (
                  <div key={key}>
                    <pre className="whitespace-pre-wrap">
                      {key}: {JSON.stringify(drafts[key], null, 2)}
                    </pre>
                    <button
                      type="button"
                      className={button}
                      onClick={() => {
                        if (!window.confirm(t('aps.recon.v3.legacyDeleteConfirm'))) return;
                        setDrafts((old) => {
                          const next = { ...old };
                          delete next[key];
                          return next;
                        });
                      }}
                    >
                      {t('aps.recon.v3.legacyDelete')}
                    </button>
                  </div>
                ))}
            </section>
          )}
          {Object.keys(legacyDrafts).length > 0 && (
            <section>
              <p role="alert">{t('aps.recon.v3.legacyDraft')}</p>
              {Object.keys(legacyDrafts).map((key) => (
                <div key={key}>
                  <pre className="whitespace-pre-wrap">
                    {key}: {JSON.stringify(legacyDrafts[key], null, 2)}
                  </pre>
                  <button
                    type="button"
                    className={button}
                    onClick={() => {
                      if (!window.confirm(t('aps.recon.v3.legacyDeleteConfirm'))) return;
                      const next = { ...legacyDrafts };
                      delete next[key];
                      legacyStorage.persist(next);
                      setLegacyDrafts(next);
                    }}
                  >
                    {t('aps.recon.v3.legacyDelete')}
                  </button>
                </div>
              ))}
            </section>
          )}
          {session?.needs_review && <p role="alert">{t('aps.recon.v2.needsReview')}</p>}
          {inconsistent && <p role="alert">{t('aps.recon.v2.inconsistent')}</p>}
          {mustRefresh && <p role="alert">{t('aps.recon.v2.draftUnconfirmed')}</p>}
          {monthDrafts.length > 0 && <p>{t('aps.recon.v2.draftOther')}</p>}
          {first.flags.close_blocked_reason && (
            <p>
              {t('aps.recon.v2.closeBlocked', {
                reason:
                  reasons[first.flags.close_blocked_reason] ?? first.flags.close_blocked_reason,
              })}
            </p>
          )}
          {session && (
            <>
              <ReconciliationTables
                lines={lines}
                readOnly={readOnly}
                draftIds={draftIds}
                onEdit={(line) => {
                  setError(null);
                  setEditing(line.id);
                }}
              />
              {query.hasNextPage && (
                <button
                  className={button}
                  type="button"
                  disabled={busy || inconsistent || query.isFetching}
                  onClick={() => void query.fetchNextPage()}
                >
                  {t('aps.recon.more')}
                </button>
              )}
            </>
          )}
        </>
      )}
      {selectedLine && (
        <EntryDialog
          line={selectedLine}
          draft={drafts[draftKey(selectedLine.id)] ?? makeDraft(selectedLine)}
          busy={busy}
          error={error}
          onChange={(d) => setDraft(selectedLine, d)}
          onSave={() =>
            void save(selectedLine, drafts[draftKey(selectedLine.id)] ?? makeDraft(selectedLine))
          }
          onClose={() => {
            setEditing(null);
            setError(null);
          }}
          onRebase={() =>
            void rebase(selectedLine, drafts[draftKey(selectedLine.id)] ?? makeDraft(selectedLine))
          }
          canAccept={!mustRefresh && !query.isError && !query.isFetching && !inconsistent}
          onAccept={() =>
            acceptCurrent(
              selectedLine,
              drafts[draftKey(selectedLine.id)] ?? makeDraft(selectedLine),
            )
          }
        />
      )}
      {operation && (
        <ModalShell
          titleId="reason-title"
          title={t(
            operation === 'close' ? 'aps.recon.v2.confirmClose' : 'aps.recon.v2.confirmReopen',
          )}
          closeLabel={t('aps.recon.cancel')}
          busy={busy}
          onClose={() => setOperation(null)}
        >
          <div className="mt-4 space-y-4">
            <p>
              {t(
                operation === 'close' ? 'aps.recon.v3.closeConfirm' : 'aps.recon.v3.reopenConfirm',
              )}
            </p>
            <label className="grid gap-1">
              {t('aps.recon.reason')}
              <textarea
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                className="bg-background border-border rounded border p-2"
              />
            </label>
            <p>{t('aps.recon.reasonHint')}</p>
            <button
              type="button"
              className={button}
              disabled={
                busy || mustRefresh || reason.trim().length < 3 || reason.trim().length > 500
              }
              onClick={() => {
                const op = operation;
                setOperation(null);
                void run(
                  () =>
                    op === 'close'
                      ? closeReconciliation(month, scope, reason.trim())
                      : reopenReconciliation(month, scope, reason.trim()),
                  t(op === 'close' ? 'aps.recon.closeSuccess' : 'aps.recon.reopenSuccess'),
                );
              }}
            >
              {t('aps.recon.confirm')}
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
