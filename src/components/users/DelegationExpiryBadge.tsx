import { Clock, Infinity as InfinityIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  getSoonestExpiry,
  hasAnyExpiry,
  type DelegatedCapability,
} from '@/hooks/useDelegatedUsers';
import { useI18n, type Locale } from '@/i18n/I18nContext';

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export type ExpiryBadgeTone = 'gray' | 'green' | 'yellow' | 'red';

const TONE_CLASS: Record<ExpiryBadgeTone, string> = {
  gray: 'border-border bg-muted text-muted-foreground',
  green: 'border-success/30 bg-success/10 text-success',
  yellow: 'border-warning/30 bg-warning/10 text-warning',
  red: 'border-destructive/30 bg-destructive/10 text-destructive',
};

export interface DelegationExpiryBadgeProps {
  readonly delegations: readonly DelegatedCapability[];
  /** Optional timestamp override for deterministic time assertions. */
  readonly now?: number;
}

function resolveExpiryTone(soonest: Date | null, nowMs: number): ExpiryBadgeTone {
  if (soonest === null) {
    return 'gray';
  }
  const remainingMs = soonest.getTime() - nowMs;
  if (remainingMs > 7 * MS_PER_DAY) {
    return 'green';
  }
  if (remainingMs >= MS_PER_DAY) {
    return 'yellow';
  }
  return 'red';
}

function formatRemainingDuration(
  remainingMs: number,
  locale: Locale,
  expiredLabel: string,
): string {
  if (remainingMs <= 0) {
    return expiredLabel;
  }
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  let raw: string;
  if (remainingMs >= MS_PER_DAY) {
    raw = rtf.format(Math.round(remainingMs / MS_PER_DAY), 'day');
  } else if (remainingMs >= MS_PER_HOUR) {
    raw = rtf.format(Math.round(remainingMs / MS_PER_HOUR), 'hour');
  } else {
    raw = rtf.format(Math.max(1, Math.round(remainingMs / MS_PER_MINUTE)), 'minute');
  }
  return raw.replace(/^(?:خلال\s+|in\s+)/i, '');
}

export function DelegationExpiryBadge({ delegations, now }: DelegationExpiryBadgeProps) {
  const { t, locale, dir } = useI18n();
  const tooltipId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [liveNow, setLiveNow] = useState<number>(() => Date.now());
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    if (now !== undefined) return;
    const intervalId = window.setInterval(() => {
      setLiveNow(Date.now());
    }, MS_PER_MINUTE);
    return () => window.clearInterval(intervalId);
  }, [now]);

  const open = hovered || pinned;

  const updatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el || typeof window === 'undefined') return;
    const rect = el.getBoundingClientRect();
    const estimatedWidth = 280;
    const clampedLeft = Math.max(
      8,
      Math.min(rect.left, Math.max(8, window.innerWidth - estimatedWidth - 8)),
    );
    setCoords({ top: rect.bottom + 8, left: clampedLeft });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (
        target &&
        !triggerRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        setPinned(false);
        setHovered(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPinned(false);
        setHovered(false);
      }
    };

    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, updatePosition]);

  const fullDateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
        dateStyle: 'full',
        timeStyle: 'short',
      }),
    [locale],
  );

  const itemDateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-GB', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
    [locale],
  );

  if (delegations.length === 0) {
    return null;
  }

  const currentNow = now ?? liveNow;
  const hasExpiry = hasAnyExpiry(delegations);
  const soonest = hasExpiry ? getSoonestExpiry(delegations) : null;
  const tone = resolveExpiryTone(soonest, currentNow);

  const summaryText =
    soonest === null
      ? t('users.delegation.expiry.permanent')
      : `${t('users.delegation.expiry.label')} ${formatRemainingDuration(
          soonest.getTime() - currentNow,
          locale,
          t('users.delegation.expiry.expired'),
        )}`;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="delegation-expiry-badge"
        data-expiry-tone={tone}
        title={summaryText}
        aria-label={summaryText}
        aria-expanded={open}
        aria-describedby={open ? tooltipId : undefined}
        onMouseEnter={() => {
          updatePosition();
          setHovered(true);
        }}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => {
          updatePosition();
          setHovered(true);
        }}
        onBlur={() => setHovered(false)}
        onClick={() => {
          updatePosition();
          setPinned((prev) => !prev);
        }}
        className={`inline-flex shrink-0 items-center justify-center rounded-full border p-1 transition-opacity hover:opacity-90 ${TONE_CLASS[tone]}`}
      >
        {soonest === null ? (
          <InfinityIcon className="size-3.5" aria-hidden="true" data-icon="infinity" />
        ) : (
          <Clock className="size-3.5" aria-hidden="true" data-icon="clock" />
        )}
      </button>

      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={popoverRef}
            id={tooltipId}
            role="tooltip"
            dir={dir}
            style={{ top: `${coords.top}px`, left: `${coords.left}px` }}
            className="border-border bg-card text-card-foreground fixed z-50 w-72 max-w-[calc(100vw-1rem)] rounded-xl border p-3 text-xs shadow-lg"
          >
            <p className="text-foreground font-semibold">{summaryText}</p>
            {soonest !== null && (
              <p className="text-muted-foreground mt-1">
                {t('users.delegation.expiry.soonest')} {fullDateFormatter.format(soonest)}
              </p>
            )}
            <p className="border-border text-muted-foreground mt-2 border-t pt-1.5 font-medium">
              {t('users.delegation.expiry.capabilities')}
            </p>
            <ul className="mt-1 space-y-1">
              {delegations.map((entry) => (
                <li key={entry.slug} className="flex items-center justify-between gap-2">
                  <code className="text-foreground truncate font-mono text-[11px]" dir="ltr">
                    {entry.slug}
                  </code>
                  <span className="text-muted-foreground shrink-0">
                    {entry.expires_at === null
                      ? t('users.delegation.expiry.permanent')
                      : itemDateFormatter.format(new Date(entry.expires_at))}
                  </span>
                </li>
              ))}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}

export default DelegationExpiryBadge;
