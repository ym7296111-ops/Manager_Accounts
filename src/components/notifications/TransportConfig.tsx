import { Activity, Check, ChevronDown, Loader2, Server, ShieldAlert } from 'lucide-react';
import { useId, useState, type FormEvent, type MouseEvent } from 'react';
import { SecretManager } from '@/components/notifications/SecretManager';
import {
  fallbackTransportSnapshot,
  toTransportError,
  useNotificationTransport,
  type NotificationTransportSnapshot,
  type TlsMode,
  type TransportErrorCode,
} from '@/hooks/useNotificationTransport';
import {
  evaluateCodedTransportTest,
  useUpdateTransport,
  type CodedTransportTestResult,
} from '@/hooks/useUpdateTransport';
import { useI18n } from '@/i18n/I18nContext';

/**
 * Notification Transport Configuration Card (Phase 3.1).
 *
 * Study references (`docs/consultations/2026-10-02-notifications-smtp-templates-design-study.md`):
 * - §1.2.1: Typed carrier configuration (`host`, `port`, `tls_mode`, `sender_name`, `sender_email`,
 *   `username`, `is_enabled`).
 * - §3.4: Value-free normalized error codes (`42501`, `22023`, `MAIL01..MAIL04`, `SEC01`).
 * - §3.6.1 & §3.6.2: `@container` root with `grid-cols-1 @md:grid-cols-2` field layout (zero `@media` queries).
 * - §3.6.2: Collapsible accordion cards (`<details>`) closed by default (`defaultOpen = false`) to reduce
 *   visual noise and accidental credential edits while keeping inputs mounted in DOM.
 * - §3.6.3: "Test Connection" outputs a strictly coded diagnostic badge (`CodedTransportTestResult`)
 *   and never leaks raw SMTP protocol banners or server responses.
 */

export interface TransportConfigProps {
  /** Optional pre-loaded masked snapshot; falls back to `useNotificationTransport()`. */
  readonly transport?: NotificationTransportSnapshot | null;
  /** Disables editing when the caller lacks `settings.manage` (§3.2 / §3.6.4). */
  readonly disabled?: boolean;
  /** Accordion initial state — defaults to `false` (closed by default per §3.6.2). */
  readonly defaultOpen?: boolean;
}

interface TransportDraft {
  readonly host: string;
  readonly port: string;
  readonly tls_mode: TlsMode;
  readonly sender_name: string;
  readonly sender_email: string;
  readonly username: string;
  readonly is_enabled: boolean;
}

const FIELD_CLASS =
  'border-input bg-background text-foreground placeholder:text-muted-foreground focus:border-primary/60 focus:ring-primary/25 w-full rounded-lg border px-3 py-2 text-sm outline-none transition-shadow focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60';

const BUTTON_CLASS =
  'inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60';

function draftFromSnapshot(snapshot: NotificationTransportSnapshot): TransportDraft {
  return {
    host: snapshot.host,
    port: String(snapshot.port),
    tls_mode: snapshot.tls_mode,
    sender_name: snapshot.sender_name,
    sender_email: snapshot.sender_email,
    username: snapshot.username ?? '',
    is_enabled: snapshot.is_enabled,
  };
}

export function TransportConfig({
  transport: transportProp,
  disabled = false,
  defaultOpen = false,
}: TransportConfigProps) {
  const { t } = useI18n();
  const { transport: queriedTransport } = useNotificationTransport({
    enabled: transportProp === undefined,
  });
  const updateTransport = useUpdateTransport();

  const snapshot = transportProp ?? queriedTransport ?? fallbackTransportSnapshot();

  // §3.6.2: Accordion cards are closed by default (`defaultOpen = false`).
  const [isCarrierOpen, setIsCarrierOpen] = useState<boolean>(defaultOpen);
  const [isSecretOpen, setIsSecretOpen] = useState<boolean>(defaultOpen);

  const [draft, setDraft] = useState<TransportDraft>(() => draftFromSnapshot(snapshot));
  const [baselineUpdatedAt, setBaselineUpdatedAt] = useState<string>(snapshot.updated_at);
  const [testResult, setTestResult] = useState<CodedTransportTestResult | null>(null);
  const [errorCode, setErrorCode] = useState<TransportErrorCode | null>(null);
  const [savedNotice, setSavedNotice] = useState<boolean>(false);

  const hostId = useId();
  const portId = useId();
  const tlsId = useId();
  const senderNameId = useId();
  const senderEmailId = useId();
  const usernameId = useId();
  const enabledSwitchId = useId();

  // Sync clean draft when a newer server snapshot arrives.
  if (snapshot.updated_at !== baselineUpdatedAt) {
    setDraft(draftFromSnapshot(snapshot));
    setBaselineUpdatedAt(snapshot.updated_at);
  }

  const toggleCarrierAccordion = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    setIsCarrierOpen((prev) => !prev);
  };

  const toggleSecretAccordion = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    setIsSecretOpen((prev) => !prev);
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || updateTransport.isPending) {
      return;
    }

    setErrorCode(null);
    setSavedNotice(false);

    const parsedPort = Number.parseInt(draft.port, 10);
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      setErrorCode('VALIDATION');
      return;
    }

    try {
      await updateTransport.mutateAsync({
        slug: snapshot.slug,
        host: draft.host.trim(),
        port: parsedPort,
        tls_mode: draft.tls_mode,
        sender_name: draft.sender_name.trim(),
        sender_email: draft.sender_email.trim(),
        username: draft.username.trim(),
        is_enabled: draft.is_enabled,
        expected_updated_at: snapshot.updated_at,
      });
      setSavedNotice(true);
    } catch (caught) {
      setErrorCode(toTransportError(caught).code);
    }
  };

  // §3.6.3: Connection test returns a coded diagnostic status only — never raw SMTP output.
  const handleTestConnection = () => {
    setErrorCode(null);
    const parsedPort = Number.parseInt(draft.port, 10);
    const coded = evaluateCodedTransportTest({
      host: draft.host,
      port: Number.isNaN(parsedPort) ? 0 : parsedPort,
      tls_mode: draft.tls_mode,
      is_enabled: draft.is_enabled,
      has_password: snapshot.has_password,
      last_test_status: snapshot.last_test_status,
    });
    setTestResult(coded);
  };

  return (
    // §3.6.1 & §3.6.2: Root uses @container (no media queries).
    <div className="@container space-y-3">
      {/* §3.6.2: Collapsible Transport Configuration Accordion (closed by default) */}
      <details
        open={isCarrierOpen}
        className="border-border bg-card text-card-foreground rounded-2xl border shadow-xs"
      >
        <summary
          aria-expanded={isCarrierOpen}
          onClick={toggleCarrierAccordion}
          className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 select-none"
        >
          <div className="flex items-center gap-2.5">
            <Server className="text-primary size-4 shrink-0" aria-hidden="true" />
            <span className="text-sm font-semibold">
              {t('settings.notifications.transport.title')}
            </span>
            <span
              className={[
                'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
                draft.is_enabled
                  ? 'border-success/30 bg-success/10 text-success'
                  : 'border-border bg-muted text-muted-foreground',
              ].join(' ')}
            >
              {draft.is_enabled
                ? t('settings.notifications.transport.enabled')
                : t('settings.notifications.transport.disabled')}
            </span>
          </div>

          <ChevronDown
            className={[
              'text-muted-foreground size-4 shrink-0 transition-transform motion-reduce:transition-none',
              isCarrierOpen ? 'rotate-180' : '',
            ].join(' ')}
            aria-hidden="true"
          />
        </summary>

        <form
          onSubmit={(event) => void handleSave(event)}
          className="border-border space-y-4 border-t px-4 py-4"
        >
          {/* §1.2.1: is_enabled toggle switch */}
          <div className="border-border bg-muted/30 flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5">
            <label htmlFor={enabledSwitchId} className="text-xs font-semibold">
              {draft.is_enabled
                ? t('settings.notifications.transport.enabled')
                : t('settings.notifications.transport.disabled')}
            </label>
            <button
              id={enabledSwitchId}
              type="button"
              role="switch"
              aria-checked={draft.is_enabled}
              aria-label={t('settings.notifications.transport.title')}
              disabled={disabled || updateTransport.isPending}
              onClick={() =>
                setDraft((current) => ({ ...current, is_enabled: !current.is_enabled }))
              }
              className={[
                'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                draft.is_enabled ? 'border-primary bg-primary' : 'border-input bg-muted',
              ].join(' ')}
            >
              <span
                className={[
                  'bg-background pointer-events-none inline-block size-4 rounded-full shadow-xs transition-transform',
                  draft.is_enabled
                    ? 'translate-x-5 rtl:-translate-x-5'
                    : 'translate-x-0.5 rtl:-translate-x-0.5',
                ].join(' ')}
              />
            </button>
          </div>

          {/* §3.6.2: Responsive container-query grid: grid-cols-1 @md:grid-cols-2 */}
          <div className="grid grid-cols-1 gap-3 @md:grid-cols-2 @xl:gap-4">
            <div className="min-w-0 space-y-1.5">
              <label htmlFor={hostId} className="block text-xs font-medium">
                {t('settings.notifications.transport.host')}
              </label>
              <input
                id={hostId}
                name="host"
                type="text"
                dir="ltr"
                disabled={disabled || updateTransport.isPending}
                value={draft.host}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, host: event.target.value }))
                }
                className={FIELD_CLASS}
              />
            </div>

            <div className="min-w-0 space-y-1.5">
              <label htmlFor={portId} className="block text-xs font-medium">
                {t('settings.notifications.transport.port')}
              </label>
              <input
                id={portId}
                name="port"
                type="number"
                min={1}
                max={65535}
                dir="ltr"
                disabled={disabled || updateTransport.isPending}
                value={draft.port}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, port: event.target.value }))
                }
                className={`${FIELD_CLASS} tabular-nums`}
              />
            </div>

            <div className="min-w-0 space-y-1.5">
              <label htmlFor={tlsId} className="block text-xs font-medium">
                {t('settings.notifications.transport.tls')}
              </label>
              <select
                id={tlsId}
                name="tls_mode"
                dir="ltr"
                disabled={disabled || updateTransport.isPending}
                value={draft.tls_mode}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    tls_mode: event.target.value as TlsMode,
                  }))
                }
                className={FIELD_CLASS}
              >
                <option value="starttls">starttls (587)</option>
                <option value="implicit_tls">implicit_tls (465)</option>
                <option value="none">none (local dev)</option>
              </select>
            </div>

            <div className="min-w-0 space-y-1.5">
              <label htmlFor={usernameId} className="block text-xs font-medium">
                {t('settings.notifications.transport.username')}
              </label>
              <input
                id={usernameId}
                name="username"
                type="text"
                dir="ltr"
                disabled={disabled || updateTransport.isPending}
                value={draft.username}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, username: event.target.value }))
                }
                className={FIELD_CLASS}
              />
            </div>

            <div className="min-w-0 space-y-1.5">
              <label htmlFor={senderNameId} className="block text-xs font-medium">
                {t('settings.notifications.transport.sender_name')}
              </label>
              <input
                id={senderNameId}
                name="sender_name"
                type="text"
                dir="auto"
                disabled={disabled || updateTransport.isPending}
                value={draft.sender_name}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, sender_name: event.target.value }))
                }
                className={FIELD_CLASS}
              />
            </div>

            <div className="min-w-0 space-y-1.5">
              <label htmlFor={senderEmailId} className="block text-xs font-medium">
                {t('settings.notifications.transport.sender_email')}
              </label>
              <input
                id={senderEmailId}
                name="sender_email"
                type="email"
                dir="ltr"
                disabled={disabled || updateTransport.isPending}
                value={draft.sender_email}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, sender_email: event.target.value }))
                }
                className={FIELD_CLASS}
              />
            </div>
          </div>

          {/* §3.6.3: Coded connection test result — never displays raw SMTP banners */}
          {testResult !== null && (
            <div
              role="status"
              aria-live="polite"
              data-testid="transport-test-result"
              className={[
                'flex flex-wrap items-center justify-between gap-2 rounded-xl border px-3 py-2 font-mono text-xs',
                testResult.ok
                  ? 'border-success/30 bg-success/10 text-success'
                  : 'border-destructive/30 bg-destructive/10 text-destructive',
              ].join(' ')}
            >
              <span>code: {testResult.code}</span>
              <span className="tabular-nums">
                tls={testResult.tls_mode} • {testResult.latency_ms}ms
              </span>
            </div>
          )}

          {savedNotice && (
            <p
              role="status"
              aria-live="polite"
              className="text-success inline-flex items-center gap-1.5 font-mono text-xs"
            >
              <Check className="size-3.5" aria-hidden="true" />
              TRANSPORT_UPDATED
            </p>
          )}

          {errorCode !== null && (
            <p
              role="alert"
              className="text-destructive inline-flex items-center gap-1.5 font-mono text-xs"
            >
              <ShieldAlert className="size-3.5" aria-hidden="true" />
              {errorCode}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
            {/* §3.6.3: Test Connection button */}
            <button
              type="button"
              disabled={disabled || updateTransport.isPending}
              onClick={handleTestConnection}
              className={`${BUTTON_CLASS} border-border bg-background hover:bg-muted border`}
            >
              <Activity className="size-3.5" aria-hidden="true" />
              {t('settings.notifications.transport.test')}
            </button>

            <button
              type="submit"
              disabled={disabled || updateTransport.isPending}
              className={`${BUTTON_CLASS} bg-primary text-primary-foreground hover:opacity-90`}
            >
              {updateTransport.isPending && (
                <Loader2
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              )}
              {t('identity.save')}
            </button>
          </div>
        </form>
      </details>

      {/* §3.6.2 & §3.6.3: Collapsible Secret Management Accordion (closed by default) */}
      <details
        open={isSecretOpen}
        className="border-border bg-card text-card-foreground rounded-2xl border shadow-xs"
      >
        <summary
          aria-expanded={isSecretOpen}
          onClick={toggleSecretAccordion}
          className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 select-none"
        >
          <span className="text-sm font-semibold">
            {t('settings.notifications.transport.password')}
          </span>
          <ChevronDown
            className={[
              'text-muted-foreground size-4 shrink-0 transition-transform motion-reduce:transition-none',
              isSecretOpen ? 'rotate-180' : '',
            ].join(' ')}
            aria-hidden="true"
          />
        </summary>

        <div className="border-border border-t px-4 py-4">
          <SecretManager
            hasPassword={snapshot.has_password}
            fingerprint={snapshot.fingerprint}
            updatedAt={snapshot.updated_at}
            secretsVersion={snapshot.secrets_version}
            transportSlug={snapshot.slug}
            disabled={disabled}
          />
        </div>
      </details>
    </div>
  );
}

export default TransportConfig;
