import { render, screen } from '@testing-library/react';
import { ArrowRight } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import {
  PageHeaderProvider,
  usePageHeader,
  usePageHeaderOverride,
} from '@/context/PageHeaderContext';
import { PAGE_HEADER_TONE_CLASSES, type PageHeaderOverride } from '@/lib/pageHeader';

function Probe() {
  const header = usePageHeader();
  return <p data-testid="probe">{header ? `${header.titleKey}:${header.tone}` : 'none'}</p>;
}

function Publisher({ header }: { readonly header: PageHeaderOverride }) {
  usePageHeaderOverride(header);
  return null;
}

const sky: PageHeaderOverride = {
  titleKey: 'aps.entry.newTitle.external_transfer',
  tone: 'sky',
  icon: ArrowRight,
};

describe('page header override', () => {
  it('is inert without a provider, so a screen never crashes on its own', () => {
    render(
      <>
        <Probe />
        <Publisher header={sky} />
      </>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('none');
  });

  it('publishes the screen title and clears it when the screen unmounts', () => {
    const view = render(
      <PageHeaderProvider>
        <Probe />
        <Publisher header={sky} />
      </PageHeaderProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe(
      'aps.entry.newTitle.external_transfer:sky',
    );
    view.rerender(
      <PageHeaderProvider>
        <Probe />
      </PageHeaderProvider>,
    );
    expect(screen.getByTestId('probe').textContent).toBe('none');
  });

  it('gives every tone a colour, a chip and a bar — never colour alone', () => {
    for (const tone of ['emerald', 'orange', 'violet', 'sky'] as const) {
      const classes = PAGE_HEADER_TONE_CLASSES[tone];
      expect(classes.text).toContain('dark:');
      expect(classes.chip).toContain('bg-');
      expect(classes.bar).toContain('bg-');
    }
  });
});
