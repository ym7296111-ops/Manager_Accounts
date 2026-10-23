import { ArrowRight, SearchX } from 'lucide-react';
import { Link } from 'react-router';
import { useI18n } from '@/i18n/I18nContext';

/**
 * Standalone 404 screen (rendered outside the dashboard shell).
 */
export default function NotFoundPage() {
  const { t } = useI18n();

  return (
    <div className="bg-background grid min-h-dvh place-items-center px-6 text-center">
      <div className="flex max-w-md flex-col items-center gap-5">
        <span className="bg-muted text-muted-foreground grid size-16 place-items-center rounded-2xl">
          <SearchX className="size-7" aria-hidden="true" />
        </span>

        <div className="space-y-2">
          <p className="text-primary text-sm font-semibold">404</p>
          <h1 className="text-foreground text-xl font-bold">{t('notFound.title')}</h1>
          <p className="text-muted-foreground text-sm">{t('notFound.body')}</p>
        </div>

        <Link
          to="/"
          className="bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold transition-opacity hover:opacity-90"
        >
          {t('notFound.back')}
          <ArrowRight className="size-4 rtl:rotate-180" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}
