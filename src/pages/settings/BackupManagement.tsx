import { ArrowUpRight, DatabaseBackup, Info } from 'lucide-react';
import { useI18n } from '@/i18n/I18nContext';

/**
 * Supabase-managed backups replace the retired GitHub Actions pg_dump queue.
 * This screen intentionally has no client-side backup API or misleading queue
 * controls; project owners manage snapshots and restores in Supabase.
 */
export default function BackupManagement() {
  const { t } = useI18n();

  return (
    <div className="@container">
      <section className="backup-native-info border-border bg-card space-y-5 rounded-2xl border p-5 shadow-sm sm:p-6">
        <div className="flex items-start gap-3">
          <span className="bg-primary/10 text-primary grid size-11 shrink-0 place-items-center rounded-xl">
            <DatabaseBackup className="size-5" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 className="font-bold">{t('backup.native.title')}</h2>
            <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
              {t('backup.native.description')}
            </p>
          </div>
        </div>

        <div className="border-border bg-muted/30 rounded-xl border p-4 sm:p-5">
          <h3 className="text-sm font-semibold">{t('backup.native.stepsTitle')}</h3>
          <ol className="text-muted-foreground mt-3 list-inside list-decimal space-y-2 text-sm leading-relaxed">
            <li>{t('backup.native.step1')}</li>
            <li>{t('backup.native.step2')}</li>
            <li>{t('backup.native.step3')}</li>
          </ol>
        </div>

        <p className="text-muted-foreground flex items-start gap-2 text-xs leading-relaxed">
          <Info className="text-primary mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t('backup.native.retiredNotice')}</span>
        </p>

        <a
          href="https://supabase.com/dashboard"
          target="_blank"
          rel="noreferrer"
          className="bg-primary text-primary-foreground inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition-opacity hover:opacity-90"
        >
          {t('backup.native.openDashboard')}
          <ArrowUpRight className="size-4" aria-hidden="true" />
        </a>
      </section>
    </div>
  );
}
