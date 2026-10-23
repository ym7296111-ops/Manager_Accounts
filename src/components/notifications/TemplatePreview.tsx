import { Eye, FileCode2, FileText, Monitor, Smartphone } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  escapeTemplateHtml,
  renderTemplatePreviewLocally,
  type TemplateDirection,
  type TemplateLocale,
  type TemplateVariableDefinition,
} from '@/hooks/useNotificationTemplates';
import { useI18n } from '@/i18n/I18nContext';

/**
 * Live Notification Template Preview (Phase 3.2 — Security-Critical).
 *
 * Study references (`docs/consultations/2026-10-02-notifications-smtp-templates-design-study.md`):
 * - §2.5(ج): Isolated `<iframe sandbox="allow-same-origin">` (strictly without `allow-scripts`)
 *   populated via `srcDoc` with an inline Content-Security-Policy (`default-src 'none'; img-src https:; style-src 'unsafe-inline'`).
 *   Raw HTML injection into the main DOM is strictly forbidden.
 * - §2.5(ج) & §3.6.2: Applies `dir="rtl"` or `dir="ltr"` and `lang` on the root `<html>` and `<body>`
 *   of the iframe document to match the template's direction.
 * - §3.6.2: Desktop (640px) / Mobile (360px) viewport width toggle and `@container` layout.
 * - §3.6.3: Uses `useDeferredValue` + 250ms debounce to prevent preview flicker while typing.
 */

export interface TemplatePreviewProps {
  readonly subject?: string;
  readonly bodyText?: string | null;
  readonly bodyHtml?: string | null;
  readonly direction?: TemplateDirection;
  readonly locale?: TemplateLocale;
  readonly variables?: readonly TemplateVariableDefinition[];
  readonly sampleVariables?: Readonly<Record<string, string>>;
  readonly contentHash?: string | null;
  /** §3.6.3: Preview update delay in milliseconds (defaults to 250ms). */
  readonly debounceMs?: number;
}

type PreviewViewport = 'desktop' | 'mobile';
type PreviewFormat = 'html' | 'text';

interface PreviewContentSnapshot {
  readonly subject: string;
  readonly bodyText: string;
  readonly bodyHtml: string;
}

/**
 * §2.5(ج): Build a complete, self-contained HTML document for the sandboxed `iframe` `srcdoc`.
 * Enforces a strict Content-Security-Policy with zero script execution and zero network connections,
 * and sets `dir="rtl"` or `dir="ltr"` on the root `<html>` and `<body>` elements.
 */
function buildSandboxedSrcDoc(params: {
  readonly subject: string;
  readonly bodyHtml: string;
  readonly bodyText: string;
  readonly format: PreviewFormat;
  readonly direction: TemplateDirection;
  readonly locale: TemplateLocale;
}): string {
  const { subject, bodyHtml, bodyText, format, direction, locale } = params;
  const safeDirection: TemplateDirection = direction === 'ltr' ? 'ltr' : 'rtl';
  const safeLocale: TemplateLocale = locale === 'en' ? 'en' : 'ar';
  const escapedSubject = escapeTemplateHtml(subject);

  const renderedBody =
    format === 'text' || bodyHtml.trim() === ''
      ? `<pre class="plain-body" dir="${safeDirection}">${escapeTemplateHtml(bodyText)}</pre>`
      : `<div class="html-body" dir="${safeDirection}">${bodyHtml}</div>`;

  return [
    '<!doctype html>',
    `<html lang="${safeLocale}" dir="${safeDirection}">`,
    '<head>',
    '<meta charset="utf-8" />',
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src https:; style-src \'unsafe-inline\';" />',
    '<style>',
    ':root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }',
    'body { margin: 0; padding: 16px; background: #ffffff; color: #0f172a; font-size: 14px; line-height: 1.6; word-wrap: break-word; }',
    '.subject-banner { margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid #e2e8f0; font-weight: 600; font-size: 15px; }',
    '.plain-body { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; }',
    '.html-body a { color: #2563eb; text-decoration: underline; pointer-events: none; }',
    'table { max-width: 100%; border-collapse: collapse; }',
    'img { max-width: 100%; height: auto; }',
    '</style>',
    '</head>',
    `<body dir="${safeDirection}">`,
    escapedSubject
      ? `<header class="subject-banner" dir="${safeDirection}">${escapedSubject}</header>`
      : '',
    renderedBody,
    '</body>',
    '</html>',
  ].join('');
}

export function TemplatePreview({
  subject = '',
  bodyText = '',
  bodyHtml = '',
  direction,
  locale = 'ar',
  variables = [],
  sampleVariables,
  contentHash = null,
  debounceMs = 250,
}: TemplatePreviewProps) {
  const { t } = useI18n();
  const [viewport, setViewport] = useState<PreviewViewport>('desktop');
  const [format, setFormat] = useState<PreviewFormat>('html');

  // §2.5(ج): Derive template direction ('rtl' or 'ltr') for the iframe document root.
  const resolvedDirection: TemplateDirection =
    direction === 'ltr' || direction === 'rtl' ? direction : locale === 'en' ? 'ltr' : 'rtl';

  const rawSnapshot = useMemo<PreviewContentSnapshot>(
    () => ({
      subject,
      bodyText: bodyText ?? '',
      bodyHtml: bodyHtml ?? '',
    }),
    [subject, bodyText, bodyHtml],
  );

  // §3.6.3: Defer incoming editor text and debounce by 250ms to prevent iframe flicker while typing.
  const deferredSnapshot = useDeferredValue(rawSnapshot);
  const [debouncedSnapshot, setDebouncedSnapshot] =
    useState<PreviewContentSnapshot>(deferredSnapshot);

  useEffect(() => {
    const timer = window.setTimeout(
      () => {
        setDebouncedSnapshot(deferredSnapshot);
      },
      Math.max(0, debounceMs),
    );
    return () => {
      window.clearTimeout(timer);
    };
  }, [deferredSnapshot, debounceMs]);

  // §2.4 & §3.6.3: Single-pass local rendering with masked sample variables.
  const rendered = useMemo(
    () =>
      renderTemplatePreviewLocally({
        subject: debouncedSnapshot.subject,
        body_text: debouncedSnapshot.bodyText,
        body_html: debouncedSnapshot.bodyHtml,
        variables,
        sample_variables: sampleVariables,
      }),
    [debouncedSnapshot, variables, sampleVariables],
  );

  // §2.5(ج): Generate srcDoc HTML string with root `dir="rtl"|"ltr"` and strict CSP.
  const srcDoc = useMemo(
    () =>
      buildSandboxedSrcDoc({
        subject: rendered.subject,
        bodyHtml: rendered.body_html,
        bodyText: rendered.body_text,
        format,
        direction: resolvedDirection,
        locale,
      }),
    [rendered, format, resolvedDirection, locale],
  );

  const hashPrefix =
    typeof contentHash === 'string' && contentHash.trim().length >= 8
      ? contentHash.trim().slice(0, 8)
      : null;

  return (
    <section
      aria-label={t('settings.notifications.templates.preview')}
      className="border-border bg-card text-card-foreground @container flex flex-col gap-3 rounded-2xl border p-4 shadow-xs"
    >
      {/* Header bar with preview title, viewport switcher (640px / 360px), and format toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="bg-primary/10 text-primary inline-flex size-8 shrink-0 items-center justify-center rounded-xl">
            <Eye className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">
              {t('settings.notifications.templates.preview')}
            </h3>
            <div className="text-muted-foreground flex items-center gap-2 font-mono text-[11px]">
              <span data-testid="preview-direction">dir={resolvedDirection}</span>
              <span>•</span>
              <span data-testid="preview-locale">lang={locale}</span>
              {hashPrefix !== null && (
                <>
                  <span>•</span>
                  <span data-testid="preview-content-hash">{hashPrefix}</span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* §3.6.2 & §3.6.3: Viewport (640px / 360px) and HTML/Plain-Text toggles */}
        <div className="flex flex-wrap items-center gap-1.5">
          <div
            role="group"
            aria-label="Preview format"
            className="border-border bg-muted/40 inline-flex items-center rounded-lg border p-0.5"
          >
            <button
              type="button"
              aria-pressed={format === 'html'}
              onClick={() => setFormat('html')}
              className={[
                'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                format === 'html'
                  ? 'bg-background text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              <FileCode2 className="size-3.5" aria-hidden="true" />
              HTML
            </button>
            <button
              type="button"
              aria-pressed={format === 'text'}
              onClick={() => setFormat('text')}
              className={[
                'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                format === 'text'
                  ? 'bg-background text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              <FileText className="size-3.5" aria-hidden="true" />
              TXT
            </button>
          </div>

          <div
            role="group"
            aria-label="Preview viewport"
            className="border-border bg-muted/40 inline-flex items-center rounded-lg border p-0.5"
          >
            <button
              type="button"
              aria-pressed={viewport === 'desktop'}
              onClick={() => setViewport('desktop')}
              className={[
                'inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-xs font-medium tabular-nums transition-colors',
                viewport === 'desktop'
                  ? 'bg-background text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              <Monitor className="size-3.5" aria-hidden="true" />
              640px
            </button>
            <button
              type="button"
              aria-pressed={viewport === 'mobile'}
              onClick={() => setViewport('mobile')}
              className={[
                'inline-flex items-center gap-1 rounded-md px-2 py-1 font-mono text-xs font-medium tabular-nums transition-colors',
                viewport === 'mobile'
                  ? 'bg-background text-foreground shadow-2xs'
                  : 'text-muted-foreground hover:text-foreground',
              ].join(' ')}
            >
              <Smartphone className="size-3.5" aria-hidden="true" />
              360px
            </button>
          </div>
        </div>
      </div>

      {/* §2.5(ج) & §3.6.2: Fixed-width preview frame (640px desktop / 360px mobile) with sandboxed iframe */}
      <div
        dir={resolvedDirection}
        className="border-border bg-muted/20 flex justify-center overflow-x-auto rounded-xl border p-3"
      >
        <div
          style={{
            width: viewport === 'desktop' ? '640px' : '360px',
            maxWidth: '100%',
            transform: 'scale(var(--preview-scale, 1))',
          }}
          className="border-border bg-background overflow-hidden rounded-lg border shadow-2xs transition-colors"
        >
          {/* §2.5: iframe sandbox for preview — allow-same-origin only, NEVER allow-scripts */}
          <iframe
            title={t('settings.notifications.templates.preview')}
            data-testid="template-preview-iframe"
            sandbox="allow-same-origin"
            dir={resolvedDirection}
            srcDoc={srcDoc}
            className="block h-72 w-full border-0 bg-white"
          />
        </div>
      </div>
    </section>
  );
}

export default TemplatePreview;
