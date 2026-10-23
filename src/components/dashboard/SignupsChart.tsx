import { useId } from 'react';
import type { SignupPoint } from '@/hooks/useExecutiveDashboard';
import { useI18n } from '@/i18n/I18nContext';
import { formatDashboardDay, formatDashboardNumber } from '@/lib/dashboardFormat';

/**
 * Daily signups for the configured window, drawn as a dependency-free SVG bar
 * chart (the project ships no charting library, and one series does not
 * justify adding ~7 MB to the bundle).
 *
 * Why bars: daily counts are discrete and frequently zero. A line would imply
 * continuity between days; bars read the gaps honestly. Zero days are kept and
 * rendered as an empty slot, so the time axis never compresses.
 *
 * Accessibility: the figure carries a caption, every bar exposes a `<title>`,
 * and a visually hidden table repeats the series for screen readers. Colour is
 * never the only signal (axis labels + table + tooltip text).
 */

const WIDTH = 640;
const HEIGHT = 220;
const PAD_LEFT = 40;
const PAD_RIGHT = 8;
const PAD_TOP = 12;
const PAD_BOTTOM = 30;
const PLOT_WIDTH = WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = HEIGHT - PAD_TOP - PAD_BOTTOM;

export interface SignupsChartProps {
  readonly points: readonly SignupPoint[];
  readonly days: number;
  readonly testId?: string;
}

export function SignupsChart({ points, days, testId }: SignupsChartProps) {
  const { t, locale } = useI18n();
  const tableId = useId();

  const total = points.reduce((sum, point) => sum + point.count, 0);
  const max = Math.max(1, ...points.map((point) => point.count));
  const isEmpty = points.length === 0 || total === 0;

  const slot = points.length === 0 ? PLOT_WIDTH : PLOT_WIDTH / points.length;
  const barWidth = Math.max(2, slot * 0.62);
  const yFor = (value: number) => PAD_TOP + PLOT_HEIGHT - (value / max) * PLOT_HEIGHT;

  const gridValues = Array.from(new Set([0, Math.ceil(max / 2), max])).filter(
    (value) => value >= 0,
  );

  const labelStep = Math.max(1, Math.ceil(points.length / 6));
  const labelIndices = new Set<number>();
  points.forEach((_, index) => {
    if (index % labelStep === 0 || index === points.length - 1) {
      labelIndices.add(index);
    }
  });

  return (
    <section
      aria-labelledby={`${tableId}-heading`}
      className="bg-card text-card-foreground flex flex-col gap-4 rounded-2xl border p-5 shadow-sm"
      data-testid={testId}
    >
      <div className="space-y-1">
        <h3 id={`${tableId}-heading`} className="text-sm font-semibold">
          {t('dashboard.chart.signups.title', { days })}
        </h3>
        <p className="text-muted-foreground text-xs">
          {t('dashboard.chart.signups.subtitle', {
            total: formatDashboardNumber(total, locale),
          })}
        </p>
      </div>

      {isEmpty ? (
        <p className="text-muted-foreground grid min-h-40 place-items-center rounded-xl border border-dashed px-4 text-center text-sm">
          {t('dashboard.chart.signups.empty')}
        </p>
      ) : (
        <figure className="m-0 space-y-2">
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            className="h-auto w-full"
            role="img"
            aria-label={t('dashboard.chart.signups.title', { days })}
          >
            {gridValues.map((value) => {
              const y = yFor(value);
              return (
                <g key={`grid-${value}`}>
                  <line
                    x1={PAD_LEFT}
                    x2={WIDTH - PAD_RIGHT}
                    y1={y}
                    y2={y}
                    stroke="var(--border)"
                    strokeWidth={1}
                    strokeDasharray={value === 0 ? undefined : '3 3'}
                  />
                  <text
                    x={PAD_LEFT - 6}
                    y={y + 3}
                    textAnchor="end"
                    className="fill-muted-foreground"
                    fontSize={9}
                  >
                    {formatDashboardNumber(value, locale)}
                  </text>
                </g>
              );
            })}

            {points.map((point, index) => {
              const height = (point.count / max) * PLOT_HEIGHT;
              const x = PAD_LEFT + index * slot + (slot - barWidth) / 2;
              const y = PAD_TOP + PLOT_HEIGHT - height;
              return (
                <rect
                  key={point.day}
                  x={x}
                  y={point.count === 0 ? PAD_TOP + PLOT_HEIGHT - 1 : y}
                  width={barWidth}
                  height={point.count === 0 ? 1 : Math.max(2, height)}
                  rx={Math.min(2, barWidth / 2)}
                  fill={point.count === 0 ? 'var(--border)' : 'var(--chart-1)'}
                >
                  <title>
                    {t('dashboard.chart.signups.bar', {
                      day: formatDashboardDay(point.day, locale),
                      count: formatDashboardNumber(point.count, locale),
                    })}
                  </title>
                </rect>
              );
            })}

            {points.map((point, index) =>
              labelIndices.has(index) ? (
                <text
                  key={`label-${point.day}`}
                  x={PAD_LEFT + index * slot + slot / 2}
                  y={HEIGHT - 10}
                  textAnchor="middle"
                  className="fill-muted-foreground"
                  fontSize={9}
                >
                  {formatDashboardDay(point.day, locale)}
                </text>
              ) : null,
            )}
          </svg>
          <figcaption className="text-muted-foreground flex flex-wrap justify-between gap-2 text-[11px]">
            <span>{t('dashboard.chart.signups.axis')}</span>
            <span>{t('dashboard.chart.signups.value')}</span>
          </figcaption>

          <table className="sr-only">
            <caption>{t('dashboard.chart.signups.title', { days })}</caption>
            <thead>
              <tr>
                <th scope="col">{t('dashboard.chart.signups.axis')}</th>
                <th scope="col">{t('dashboard.chart.signups.value')}</th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={`row-${point.day}`}>
                  <th scope="row">{formatDashboardDay(point.day, locale)}</th>
                  <td>{formatDashboardNumber(point.count, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </figure>
      )}
    </section>
  );
}
