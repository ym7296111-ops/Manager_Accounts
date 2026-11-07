import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { useI18n } from '@/i18n/I18nContext';
import { useAuth } from '@/context/AuthContext';
import {
  closeReconciliation,
  openReconciliation,
  recordReconciliation,
  reopenReconciliation,
  useReconciliationOptions,
  useReconciliationState,
} from '@/hooks/useApsReconciliation';
import {
  normalizeReconciliationAmount,
  ReconciliationError,
  type ReconciliationLine,
  type ReconciliationState,
} from '@/lib/apsReconciliation';
import {
  ReasonDialog,
  ReconciliationActions,
  ReconciliationHeader,
  ReconciliationStatus,
  ReconciliationSummary,
  ReconciliationTable,
  type Draft,
} from './reconciliation/ReconciliationComponents';

function loadDrafts(storageKey: string): Record<string, Draft> {
  try {
    const raw: unknown = JSON.parse(window.sessionStorage.getItem(storageKey) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const drafts: Record<string, Draft> = {};
    for (const [id, value] of Object.entries(raw)) {
      if (
        !/^[0-9a-f-]{36}$/i.test(id) ||
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value)
      )
        continue;
      const item = value as Record<string, unknown>;
      if (
        typeof item.value === 'string' &&
        item.value.length <= 50 &&
        typeof item.baseline === 'string' &&
        /^-?\d+\.\d{2}$/.test(item.baseline)
      )
        drafts[id] = { value: item.value, baseline: item.baseline };
    }
    return drafts;
  } catch {
    return {};
  }
}

export default function ApsReconciliationPage() {
  const { session } = useAuth();
  return <ReconciliationPage key={session?.user.id ?? ''} actorId={session?.user.id ?? ''} />;
}

function ReconciliationPage({ actorId }: { actorId: string }) {
  const { t } = useI18n();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const optionsQuery = useReconciliationOptions();
  const options = optionsQuery.data;
  const rawMonth = params.get('month');
  const rawStation = params.get('station');
  const badMonth =
    !!options &&
    rawMonth !== null &&
    rawMonth !== '' &&
    !options.months.some((m) => m.id === rawMonth);
  const badStation =
    !!options &&
    rawStation !== null &&
    rawStation !== '' &&
    !options.stations.some((s) => s.id === rawStation);
  const monthId =
    !options || badMonth
      ? ''
      : rawMonth === null
        ? (options.months.find((m) => m.is_active)?.id ?? '')
        : rawMonth;
  const stationId =
    !options || badStation
      ? ''
      : rawStation === null && options.stations.length === 1
        ? options.stations[0]!.id
        : (rawStation ?? '');
  const stateQuery = useReconciliationState(monthId || null, stationId || null);
  const storageKey = `aps-reconciliation-drafts:${actorId}`;
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => loadDrafts(storageKey));
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const [mustRefresh, setMustRefresh] = useState(false);
  const pendingSave = useRef<{ lineId: string; amount: string } | null>(null);
  const [dialog, setDialog] = useState<'close' | 'reopen' | null>(null);
  const [reason, setReason] = useState('');
  const [dialogError, setDialogError] = useState<string | null>(null);
  const dirty = Object.keys(drafts).length > 0;
  const pages = stateQuery.data?.pages ?? [];
  const first = pages[0];
  const current = pages.at(-1);
  const lines = pages.flatMap((page) => page.selected_lines);
  const inconsistent =
    (!!first &&
      pages.some(
        (page) =>
          page.selected_session?.id !== first.selected_session?.id ||
          page.selected_session?.status !== first.selected_session?.status ||
          page.selected_session?.flow_type !== first.selected_session?.flow_type ||
          page.selected_session?.has_legacy_items !== first.selected_session?.has_legacy_items,
      )) ||
    new Set(lines.map((line) => line.id)).size !== lines.length;
  const session = current?.selected_session;
  const legacy = !!session && (session.flow_type === 'legacy' || session.has_legacy_items);
  const readOnly =
    !options?.can_manage ||
    !session ||
    session.status !== 'open' ||
    legacy ||
    inconsistent ||
    mustRefresh ||
    stateQuery.isError;

  // sessionStorage keeps in-progress amounts within this tab when browser Back
  // unmounts the screen. Drafts are scoped by actor and are never sent to a table.
  useEffect(() => {
    try {
      if (dirty) window.sessionStorage.setItem(storageKey, JSON.stringify(drafts));
      else window.sessionStorage.removeItem(storageKey);
    } catch {
      /* Browser storage may be disabled; the navigation warning still applies. */
    }
  }, [dirty, drafts, storageKey]);

  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    const guard = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (
        !(target instanceof HTMLAnchorElement) ||
        target.target === '_blank' ||
        target.hasAttribute('download')
      )
        return;
      const next = new URL(target.href, window.location.href);
      if (
        next.origin !== window.location.origin ||
        (next.pathname === location.pathname && next.search === location.search)
      )
        return;
      if (!window.confirm(t('aps.recon.unsavedConfirm'))) {
        event.preventDefault();
        event.stopPropagation();
      } else {
        try {
          window.sessionStorage.removeItem(storageKey);
        } catch {
          /* Storage unavailable. */
        }
        setDrafts({});
      }
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', guard, true);
    return () => {
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', guard, true);
    };
  }, [dirty, location.pathname, location.search, storageKey, t]);

  function choose(key: 'month' | 'station', value: string) {
    if (busy || (dirty && !window.confirm(t('aps.recon.unsavedConfirm')))) return;
    setDrafts({});
    setNotice(null);
    setMustRefresh(false);
    pendingSave.current = null;
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next);
  }
  const messageFor = useCallback(
    (error: unknown) => {
      const code = error instanceof ReconciliationError ? error.code : 'unknown';
      if (code === '42501') return t('aps.recon.forbidden');
      if (
        code === '22023' ||
        code === 'P0002' ||
        code === '02000' ||
        code === '23505' ||
        code === '40001'
      )
        return t('aps.recon.changed');
      if (code === 'invalidResponse') return t('aps.recon.invalidResponse');
      return t('aps.recon.requestError');
    },
    [t],
  );

  async function refresh(): Promise<ReconciliationState[] | null> {
    const result = await stateQuery.refetch();
    if (result.isError || !result.data) {
      setMustRefresh(true);
      return null;
    }
    const resultPages = result.data.pages;
    const firstSession = resultPages[0]?.selected_session;
    const ids = resultPages.flatMap((p) => p.selected_lines.map((line) => line.id));
    if (
      resultPages.some(
        (p) =>
          p.selected_session?.id !== firstSession?.id ||
          p.selected_session?.status !== firstSession?.status ||
          p.selected_session?.flow_type !== firstSession?.flow_type ||
          p.selected_session?.has_legacy_items !== firstSession?.has_legacy_items,
      ) ||
      new Set(ids).size !== ids.length
    ) {
      setMustRefresh(true);
      return null;
    }
    setMustRefresh(false);
    const pending = pendingSave.current;
    if (pending) {
      const latest = resultPages
        .flatMap((p) => p.selected_lines)
        .find((line) => line.id === pending.lineId);
      if (latest?.accountant_amount === pending.amount)
        setDrafts((old) => {
          const next = { ...old };
          delete next[pending.lineId];
          return next;
        });
      pendingSave.current = null;
    }
    return resultPages;
  }
  async function doRefresh() {
    if (locked.current || !monthId || !stationId) return;
    locked.current = true;
    setBusy(true);
    try {
      const updated = await refresh();
      setNotice(updated ? t('aps.recon.updated') : t('aps.recon.refreshFailed'));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  function changeLine(line: ReconciliationLine, value: string) {
    if (busy || readOnly) return;
    setDrafts((old) => ({
      ...old,
      [line.id]: { value, baseline: old[line.id]?.baseline ?? line.accountant_amount },
    }));
  }
  async function saveLine(line: ReconciliationLine) {
    if (
      locked.current ||
      readOnly ||
      stateQuery.isFetching ||
      !session ||
      !drafts[line.id] ||
      drafts[line.id]!.baseline !== line.accountant_amount
    )
      return;
    const amount = normalizeReconciliationAmount(drafts[line.id]!.value);
    if (amount === null) {
      setDrafts((old) => ({
        ...old,
        [line.id]: { ...old[line.id]!, error: t('aps.recon.invalidAmount') },
      }));
      return;
    }
    locked.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await recordReconciliation(session.id, line.classification_id, amount);
      // RPC numeric fields are JSON numbers and may already be rounded: only
      // the text amounts from the read RPC are used as financial truth.
      pendingSave.current = { lineId: line.id, amount };
      const updated = await refresh();
      const confirmed = updated
        ?.flatMap((page) => page.selected_lines)
        .find((item) => item.id === line.id);
      setNotice(
        !updated
          ? t('aps.recon.savedRefreshFailed')
          : confirmed?.accountant_amount === amount
            ? t('aps.recon.saveConfirmed')
            : t('aps.recon.changed'),
      );
    } catch (error) {
      // Network failures may arrive after commit. Read before permitting retry.
      if (error instanceof ReconciliationError && error.code === 'network')
        pendingSave.current = { lineId: line.id, amount };
      const updated = await refresh();
      setNotice(updated ? messageFor(error) : t('aps.recon.refreshFailed'));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function open() {
    if (locked.current || !monthId || !stationId) return;
    locked.current = true;
    setBusy(true);
    setNotice(null);
    try {
      await openReconciliation(monthId, stationId);
      const updated = await refresh();
      setNotice(updated ? t('aps.recon.openSuccess') : t('aps.recon.savedRefreshFailed'));
    } catch (error) {
      const updated = await refresh();
      setNotice(updated ? messageFor(error) : t('aps.recon.refreshFailed'));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  async function submitReason() {
    if (
      locked.current ||
      !dialog ||
      !monthId ||
      controlBusy ||
      (dialog === 'close' ? !canClose : !canReopen) ||
      Array.from(reason.trim()).length < 3 ||
      Array.from(reason.trim()).length > 500
    )
      return;
    locked.current = true;
    setBusy(true);
    setDialogError(null);
    const operation = dialog;
    try {
      if (operation === 'close') await closeReconciliation(monthId, reason.trim());
      else await reopenReconciliation(monthId, reason.trim());
      setDialog(null);
      setReason('');
      const updated = await refresh();
      setNotice(
        updated
          ? t(operation === 'close' ? 'aps.recon.closeSuccess' : 'aps.recon.reopenSuccess')
          : t('aps.recon.savedRefreshFailed'),
      );
    } catch (error) {
      const updated = await refresh();
      setDialogError(updated ? messageFor(error) : t('aps.recon.refreshFailed'));
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }
  const controlBusy =
    busy || stateQuery.isFetching || stateQuery.isError || mustRefresh || inconsistent;
  const canOpen =
    !!options?.can_manage &&
    !!current &&
    (!session || session.status !== 'open') &&
    !(
      current.month_summary.open_sessions_count === 0 &&
      current.month_summary.eligible_closed_screen_sessions > 0
    ) &&
    !dirty;
  const canClose = !!options?.can_close && !!current?.flags.can_close_now && !dirty;
  const showReopen =
    !!options?.can_reopen_as_owner &&
    !!current &&
    current.month_summary.eligible_closed_screen_sessions > 0;
  const canReopen = showReopen && current.month_summary.open_sessions_count === 0 && !dirty;
  const loadingOptions = optionsQuery.isPending && !options;
  const error = optionsQuery.isError
    ? optionsQuery.error
    : stateQuery.isError && !current
      ? stateQuery.error
      : null;

  return (
    <main className="space-y-5" aria-label={t('aps.recon.title')}>
      <div>
        <h2 className="text-xl font-bold">{t('aps.recon.title')}</h2>
        <p className="text-muted-foreground text-sm">{t('aps.recon.description')}</p>
      </div>
      {loadingOptions && <ReconciliationStatus message={t('aps.recon.loading')} />}
      {error && (
        <ReconciliationStatus
          message={messageFor(error)}
          retry={() => {
            if (optionsQuery.isError) void optionsQuery.refetch();
            else void stateQuery.refetch();
          }}
        />
      )}
      {options && (
        <ReconciliationHeader
          months={options.months}
          stations={options.stations}
          monthId={monthId}
          stationId={stationId}
          onMonthChange={(v) => choose('month', v)}
          onStationChange={(v) => choose('station', v)}
          disabled={busy}
        />
      )}
      {(badMonth || badStation) && (
        <ReconciliationStatus message={t('aps.recon.invalidSelection')} />
      )}
      {options && !badMonth && !badStation && (!monthId || !stationId) && (
        <ReconciliationStatus message={t('aps.recon.selectBoth')} />
      )}
      {monthId && stationId && stateQuery.isPending && (
        <ReconciliationStatus message={t('aps.recon.loading')} />
      )}
      {current && options && (
        <>
          <ReconciliationSummary
            summary={current.month_summary}
            fiscalClosed={current.fiscal_month.is_fiscal_closed}
            onStation={(v) => choose('station', v)}
          />
          <ReconciliationActions
            canOpen={canOpen}
            canClose={canClose}
            showReopen={showReopen}
            canReopen={canReopen}
            busy={controlBusy}
            onOpen={() => void open()}
            onClose={() => {
              setDialog('close');
              setReason('');
              setDialogError(null);
            }}
            onReopen={() => {
              setDialog('reopen');
              setReason('');
              setDialogError(null);
            }}
          />
          {current.flags.close_blocked_reason === 'nonzero_differences' && (
            <ReconciliationStatus message={t('aps.recon.closeDifferences')} />
          )}
          {current.flags.close_blocked_reason === 'no_eligible_open_sessions' && (
            <ReconciliationStatus message={t('aps.recon.noEligible')} />
          )}
          {current.month_summary.open_sessions_count === 0 &&
            current.month_summary.eligible_closed_screen_sessions > 0 && (
              <ReconciliationStatus message={t('aps.recon.monthClosed')} />
            )}
          {session && (
            <p className="text-sm font-semibold">
              {t('aps.recon.sessionStatus')}: {t(`aps.recon.status.${session.status}`)} (
              {session.sequence_number})
            </p>
          )}
          {(pages.length > 1 || current.pagination.has_more) && (
            <p className="text-muted-foreground text-sm">{t('aps.recon.paginationWarning')}</p>
          )}
          {legacy && (
            <ReconciliationStatus
              message={t(
                session?.flow_type === 'legacy' ? 'aps.recon.legacy' : 'aps.recon.mixedLegacy',
              )}
            />
          )}
          {!session && <ReconciliationStatus message={t('aps.recon.noSession')} />}
          {session && !legacy && !inconsistent && (
            <ReconciliationTable
              lines={lines}
              drafts={drafts}
              readOnly={readOnly}
              busy={busy || stateQuery.isFetching}
              hasMore={!!stateQuery.hasNextPage}
              loadingMore={stateQuery.isFetchingNextPage}
              onChange={changeLine}
              onSave={(line) => void saveLine(line)}
              onDiscard={(id) =>
                setDrafts((old) => {
                  const next = { ...old };
                  delete next[id];
                  return next;
                })
              }
              onMore={() => {
                if (!stateQuery.isFetching) void stateQuery.fetchNextPage();
              }}
            />
          )}
          {(inconsistent || mustRefresh || stateQuery.isError) && (
            <ReconciliationStatus message={t('aps.recon.refreshFailed')} />
          )}
          {notice && (
            <div role="status" className="text-sm">
              {notice}
            </div>
          )}
          {dirty && (
            <div className="text-sm text-amber-700 dark:text-amber-300">
              <p>{t('aps.recon.dirtyWarning')}</p>
              <button
                type="button"
                className="border-border mt-2 rounded-lg border px-3 py-2"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(t('aps.recon.unsavedConfirm'))) setDrafts({});
                }}
              >
                {t('aps.recon.discardAll')}
              </button>
            </div>
          )}
          <button
            type="button"
            className="border-border rounded-lg border px-3 py-2 text-sm"
            disabled={busy || stateQuery.isFetching}
            onClick={() => void doRefresh()}
          >
            {t('aps.recon.refresh')}
          </button>
          {dialog && (
            <ReasonDialog
              operation={dialog}
              reason={reason}
              busy={busy}
              canConfirm={!controlBusy && (dialog === 'close' ? canClose : canReopen)}
              error={dialogError}
              summary={current.month_summary}
              onChange={setReason}
              onCancel={() => setDialog(null)}
              onConfirm={() => void submitReason()}
            />
          )}
        </>
      )}
    </main>
  );
}
