import { Bell, Eye, Loader2, PencilLine, Radio } from 'lucide-react';
import { useState } from 'react';
import {
  TemplateEditor,
  type TemplateEditorValues,
} from '@/components/notifications/TemplateEditor';
import { TemplatePreview } from '@/components/notifications/TemplatePreview';
import { TransportConfig } from '@/components/notifications/TransportConfig';
import {
  fallbackNotificationTemplate,
  useNotificationTemplates,
  type TemplateLocale,
} from '@/hooks/useNotificationTemplates';
import { useNotificationRealtime } from '@/hooks/useNotificationRealtime';
import { useI18n } from '@/i18n/I18nContext';
import type { TranslationKey } from '@/i18n/locales/ar';

/**
 * Notifications & Message Templates — the seventh (composite) settings screen (Phase 3.3).
 *
 * Study references (`docs/consultations/2026-10-02-notifications-smtp-templates-design-study.md`):
 * - §3.6.1: ONE `@container` root; every breakpoint below is a container query, so the layout
 *   follows the (collapsible) sidebar space instead of the window width — the A18 criterion.
 * - §3.6.2: `<@3xl` collapses to a single column (horizontal scroll-snap event rail + an
 *   editor/preview segmented switch); `@3xl` becomes the three-column grid
 *   `grid-cols-[9.5rem_minmax(0,1fr)_minmax(20rem,26rem)]` — event rail (sticky), editor pane,
 *   preview pane (sticky). Editor columns keep `minmax(0,1fr)` / `min-w-0` so long
 *   `body_html` code cannot blow the track out.
 * - §3.6.2: the inactive pane is hidden with `hidden` **while staying mounted**, so `textarea`
 *   state (subject / body draft) survives editor ⇄ preview switching.
 * - §3.6.2 & §3.6.3: the screens' blocks are composed here — `TransportConfig` (collapsed by
 *   default: SMTP credentials stay folded away) + `TemplateEditor` (subject / body / variable
 *   chips / TPL04-TPL01 panel / draft & publish) + `TemplatePreview` (sandboxed `iframe`, 640px /
 *   360px viewports, `dir` from the template locale).
 * - §3.6.4: a single `useNotificationTemplates({ key, locale })` query feeds both panes, and the
 *   realtime channel only invalidates that query prefix — changing the event (or the content
 *   language) re-fetches and re-renders editor + preview together, with no parallel state.
 * - §2.9: the event rail lists the current seeded events, and `NotificationSettings` keeps the
 *   event registry data-driven (new `key`s need a label + a seed, not a new screen).
 */

/** One event exposed by the rail: the canonical template `key` plus its display label. */
export interface NotificationEventDefinition {
  readonly key: string;
  readonly labelKey: TranslationKey;
}

/** Current seeded events (`email` channel; bilingual by rows, not by columns). */
const SEEDED_NOTIFICATION_EVENTS: readonly NotificationEventDefinition[] = [
  { key: 'auth.welcome_invitation', labelKey: 'settings.notifications.events.welcome' },
  { key: 'security.suspension_alert', labelKey: 'settings.notifications.events.suspension' },
];

/** §3.6.2: below `@3xl` exactly one pane is visible; at `@3xl` both are side by side. */
type CompositePane = 'editor' | 'preview';

export interface NotificationSettingsProps {
  /** §3.2 & §3.6.4: locks the write affordances when the caller lacks `notifications.manage`. */
  readonly disabled?: boolean;
  /** Optional override of the event rail (defaults to the three §2.9 seeds). */
  readonly events?: readonly NotificationEventDefinition[];
  /** Initial content language of the template + preview (defaults to the active UI locale). */
  readonly defaultLocale?: TemplateLocale;
  /**
   * Smart Hiding per card. `canManageTransport === false` hides the SMTP card
   * entirely (server: `settings.manage` / `*`). `canManageTemplates === false`
   * keeps the editor visible but read-only (server: `notifications.manage` / `*`).
   * Both default to `true` so the screen behaves as before when unspecified.
   */
  readonly canManageTemplates?: boolean;
  readonly canManageTransport?: boolean;
}

export function NotificationSettings({
  disabled = false,
  events = SEEDED_NOTIFICATION_EVENTS,
  defaultLocale,
  canManageTemplates = true,
  canManageTransport = true,
}: NotificationSettingsProps) {
  const { t, locale: uiLocale } = useI18n();

  const [templateKey, setTemplateKey] = useState<string>(
    events[0]?.key ?? 'auth.welcome_invitation',
  );
  const [locale, setLocale] = useState<TemplateLocale>(defaultLocale ?? uiLocale);
  const [activePane, setActivePane] = useState<CompositePane>('editor');

  // §3.6.3 & §3.6.4: Realtime is an invalidation signal only (and only for `notification_templates`).
  const { state: realtimeState } = useNotificationRealtime({ enabled: !disabled });

  // §3.6.4: ONE query per (key, locale) shared by the editor pane and the preview pane.
  const {
    currentTemplate,
    error: templateError,
    isLoading,
  } = useNotificationTemplates({ key: templateKey, locale });

  // The canonical §2.9 seed stays available as the offline/unavailable fallback (same contract as
  // the 3.2 components), but it is never used to *pre-fill* a pending fetch: the seed ignores the
  // event key, so rendering it mid-flight would flash another event's copy and re-seed (and thus
  // wipe) anything typed in that window.
  const isAwaitingFirstRecord = isLoading && currentTemplate === null;
  const resolvedTemplate = currentTemplate ?? fallbackNotificationTemplate(templateKey, locale);

  // §3.6.4: live editor values are lifted here so the preview mirrors the editor keystroke-for-keystroke.
  const [editorValues, setEditorValues] = useState<TemplateEditorValues | null>(null);
  const liveIdentity = `${templateKey}|${locale}|${resolvedTemplate.content_hash}`;
  const [boundIdentity, setBoundIdentity] = useState<string>(liveIdentity);
  if (liveIdentity !== boundIdentity) {
    // Event / content language / published record changed → drop the stale draft; the editor and
    // the preview both re-seed from the freshly fetched record.
    setBoundIdentity(liveIdentity);
    setEditorValues(null);
  }

  const previewSubject = editorValues?.subject ?? resolvedTemplate.subject;
  const previewBodyText = editorValues?.body_text ?? resolvedTemplate.body_text ?? '';
  const previewBodyHtml = editorValues?.body_html ?? resolvedTemplate.body_html ?? '';

  return (
    // §3.6.1 & §3.6.2: the container — not the viewport — is the layout reference.
    <div className="@container space-y-4" data-testid="notification-settings">
      {/* §3.6.2: single compact header row in every size: content language + Realtime health. */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          data-testid="notification-locale-switch"
          className="border-border bg-muted/40 inline-flex items-center rounded-xl border p-0.5"
        >
          {(['ar', 'en'] as const).map((code) => (
            <button
              key={code}
              type="button"
              aria-pressed={locale === code}
              data-testid={`notification-locale-${code}`}
              onClick={() => setLocale(code)}
              className={[
                'rounded-lg px-3 py-1 text-xs font-medium transition-colors',
                locale === code
                  ? 'bg-background text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {t(code === 'ar' ? 'language.ar' : 'language.en')}
            </button>
          ))}
        </div>

        <span
          data-testid="notification-realtime-state"
          data-state={realtimeState}
          className={[
            'inline-flex items-center gap-1.5 font-mono text-[11px]',
            realtimeState === 'live'
              ? 'text-success'
              : realtimeState === 'connecting'
                ? 'text-muted-foreground'
                : 'text-destructive',
          ].join(' ')}
        >
          <Radio className="size-3.5" aria-hidden="true" />
          {t(
            realtimeState === 'live'
              ? 'users.realtime.live'
              : realtimeState === 'connecting'
                ? 'users.realtime.connecting'
                : 'users.realtime.offline',
          )}
        </span>
      </div>

      {/* §3.6.2: 1 column below `@3xl`, then the fixed 3-track grid (9.5rem rail · fluid editor · 20-26rem preview). */}
      <div
        data-testid="notification-settings-grid"
        className="grid grid-cols-1 gap-4 @3xl:grid-cols-[9.5rem_minmax(0,1fr)_minmax(20rem,26rem)]"
      >
        {/* Event rail: horizontal scroll-snap below `@3xl`, sticky column at `@3xl`. */}
        <nav
          aria-label={t('settings.notifications.title')}
          data-testid="notification-event-rail"
          className="flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1 @3xl:sticky @3xl:top-0 @3xl:flex-col @3xl:self-start @3xl:overflow-visible @3xl:pb-0"
        >
          {events.map((event) => {
            const isSelected = event.key === templateKey;
            return (
              <button
                key={event.key}
                type="button"
                aria-pressed={isSelected}
                data-testid={`notification-event-${event.key}`}
                onClick={() => setTemplateKey(event.key)}
                className={[
                  'flex shrink-0 snap-start items-center gap-2 rounded-xl border px-3 py-2 text-start transition-colors @3xl:w-full @3xl:flex-col @3xl:items-start',
                  isSelected
                    ? 'border-primary/50 bg-primary/10 text-foreground'
                    : 'border-border bg-card text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                ].join(' ')}
              >
                <Bell className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0">
                  <span className="block text-xs font-semibold">{t(event.labelKey)}</span>
                  <span className="block truncate font-mono text-[10px]" dir="ltr">
                    {event.key}
                  </span>
                </span>
              </button>
            );
          })}
        </nav>

        {/* §3.6.2: `<@3xl` segmented switch — hidden once both panes fit next to each other. */}
        <div
          role="group"
          data-testid="notification-pane-switch"
          className="border-border bg-muted/40 inline-flex w-fit items-center rounded-xl border p-0.5 @3xl:hidden"
        >
          {(['editor', 'preview'] as const).map((pane) => (
            <button
              key={pane}
              type="button"
              aria-pressed={activePane === pane}
              data-testid={`notification-pane-${pane}`}
              onClick={() => setActivePane(pane)}
              className={[
                'inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 font-mono text-xs font-medium transition-colors',
                activePane === pane
                  ? 'bg-background text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              {pane === 'editor' ? (
                <PencilLine className="size-3.5" aria-hidden="true" />
              ) : (
                <Eye className="size-3.5" aria-hidden="true" />
              )}
              {pane}
            </button>
          ))}
        </div>

        {/* Editor pane: carrier configuration (collapsed) + template editor. */}
        <div
          data-testid="notification-editor-pane"
          aria-busy={isLoading}
          className={[
            'max-h-[70vh] min-w-0 space-y-4 overflow-y-auto overscroll-contain pb-1 @3xl:max-h-[calc(100vh-13rem)]',
            activePane === 'editor' ? 'block' : 'hidden',
            '@3xl:block',
          ].join(' ')}
        >
          {templateError !== null && (
            <p
              role="alert"
              data-testid="notification-templates-error"
              className="border-destructive/30 bg-destructive/10 text-destructive rounded-xl border px-3 py-2 font-mono text-xs"
            >
              {templateError.code}
            </p>
          )}

          {/* §3.6.2: SMTP credentials stay folded away until the operator opens the card. */}
          {canManageTransport && <TransportConfig disabled={disabled} defaultOpen={false} />}

          {isAwaitingFirstRecord ? (
            // The carrier card above has its own read contract; the template panes wait for the
            // real `(key, locale)` record so neither pane ever shows a different event's seed.
            <p
              role="status"
              data-testid="notification-editor-loading"
              className="text-muted-foreground inline-flex items-center gap-2 px-1 py-2 font-mono text-xs"
            >
              <Loader2
                className="size-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {t('common.loading')}
            </p>
          ) : (
            /* §3.6.3: the parent owns the record, so editor + preview can never drift apart. */
            <TemplateEditor
              template={resolvedTemplate}
              disabled={disabled || !canManageTemplates}
              onChange={(values) => setEditorValues(values)}
            />
          )}
        </div>

        {/* Preview pane: sandboxed `iframe` preview, sticky while the editor column scrolls. */}
        <div
          data-testid="notification-preview-pane"
          className={[
            'min-w-0 @3xl:sticky @3xl:top-0 @3xl:self-start',
            activePane === 'preview' ? 'block' : 'hidden',
            '@3xl:block',
          ].join(' ')}
        >
          {isAwaitingFirstRecord ? (
            <p
              role="status"
              data-testid="notification-preview-loading"
              className="text-muted-foreground inline-flex items-center gap-2 px-1 py-2 font-mono text-xs"
            >
              <Loader2
                className="size-3.5 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
              {t('common.loading')}
            </p>
          ) : (
            <TemplatePreview
              subject={previewSubject}
              bodyText={previewBodyText}
              bodyHtml={previewBodyHtml}
              direction={resolvedTemplate.direction}
              locale={locale}
              variables={resolvedTemplate.variables}
              sampleVariables={resolvedTemplate.sample_variables}
              contentHash={resolvedTemplate.content_hash}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default NotificationSettings;
