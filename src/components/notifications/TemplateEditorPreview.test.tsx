import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TemplateEditor } from '@/components/notifications/TemplateEditor';
import { TemplatePreview } from '@/components/notifications/TemplatePreview';
import { fallbackNotificationTemplate } from '@/hooks/useNotificationTemplates';
import { I18nProvider, LOCALE_STORAGE_KEY } from '@/i18n/I18nContext';

const { rpc, client } = vi.hoisted(() => {
  const rpc = vi.fn();
  const client = { rpc };
  return { rpc, client };
});

vi.mock('@/lib/supabase', () => ({
  getSupabase: () => client,
}));

describe('TemplatePreview & TemplateEditor (Phase 3.2)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(LOCALE_STORAGE_KEY, 'ar');
    rpc.mockReset().mockResolvedValue({ data: [], error: null });
  });

  it('renders TemplatePreview inside an <iframe sandbox="allow-same-origin"> without allow-scripts or dangerouslySetInnerHTML', () => {
    vi.useFakeTimers();
    try {
      const template = fallbackNotificationTemplate('auth.welcome_invitation', 'ar');

      const { rerender } = render(
        <I18nProvider>
          <TemplatePreview
            subject={template.subject}
            bodyText={template.body_text}
            bodyHtml={template.body_html}
            direction="rtl"
            locale="ar"
            variables={template.variables}
            sampleVariables={template.sample_variables}
            contentHash={template.content_hash}
          />
        </I18nProvider>,
      );

      const iframe = screen.getByTestId<HTMLIFrameElement>('template-preview-iframe');
      expect(iframe.tagName).toBe('IFRAME');

      // §2.5(ج): Must enforce sandbox="allow-same-origin" and never allow-scripts.
      const sandboxAttr = iframe.getAttribute('sandbox') ?? '';
      expect(sandboxAttr).toBe('allow-same-origin');
      expect(sandboxAttr).not.toContain('allow-scripts');

      // §2.5(ج): Root document of iframe matches template direction (dir="rtl").
      const initialSrcDoc = iframe.getAttribute('srcdoc') ?? '';
      expect(initialSrcDoc).toContain('<html lang="ar" dir="rtl">');
      expect(initialSrcDoc).toContain('<body dir="rtl">');
      expect(initialSrcDoc).toContain('مرحباً لينا');

      // §3.6.3: Rapid edits are debounced by 250ms before updating the iframe srcdoc.
      rerender(
        <I18nProvider>
          <TemplatePreview
            subject="Updated {{user_name}}"
            bodyText="Updated body"
            bodyHtml="<p>Updated HTML for {{user_name}}</p>"
            direction="ltr"
            locale="en"
            variables={template.variables}
            sampleVariables={{ ...template.sample_variables, user_name: 'Lina' }}
            contentHash={template.content_hash}
          />
        </I18nProvider>,
      );

      // Before 250ms elapses, the previous body text remains in srcdoc while dir updates to ltr.
      expect(iframe.getAttribute('srcdoc') ?? '').toContain('<html lang="en" dir="ltr">');
      expect(iframe.getAttribute('srcdoc') ?? '').not.toContain('Updated HTML for Lina');

      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(iframe.getAttribute('srcdoc') ?? '').toContain('Updated HTML for Lina');

      // §2.5(ج): Static source verification that dangerouslySetInnerHTML is never used in TemplatePreview.tsx.
      const previewSource = readFileSync(
        resolve(process.cwd(), 'src/components/notifications/TemplatePreview.tsx'),
        'utf8',
      );
      expect(previewSource).not.toContain('dangerously' + 'SetInnerHTML');
    } finally {
      vi.useRealTimers();
    }
  });

  it('inserts the clicked Variable Chip token at the exact cursor position in the active editor field and surfaces TPL04 / TPL01 errors', () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const template = fallbackNotificationTemplate('auth.welcome_invitation', 'ar');

    render(
      <I18nProvider>
        <QueryClientProvider client={queryClient}>
          <TemplateEditor template={template} />
        </QueryClientProvider>
      </I18nProvider>,
    );

    const bodyTextArea = screen.getByLabelText<HTMLTextAreaElement>('النص المجرد (Plain Text)');
    fireEvent.focus(bodyTextArea);
    fireEvent.change(bodyTextArea, { target: { value: 'أهلاً بك هنا' } });

    // Place the cursor right after "أهلاً " (index 6) and click the {{user_name}} Variable Chip.
    bodyTextArea.setSelectionRange(6, 6);
    fireEvent.select(bodyTextArea);

    const userNameChip = screen.getByTestId('variable-chip-user_name');
    fireEvent.click(userNameChip);

    expect(bodyTextArea.value).toBe('أهلاً {{user_name}}بك هنا');

    // Verify TPL01 (unknown variable) and TPL04 (disallowed HTML) appear below fields.
    const bodyHtmlArea = screen.getByLabelText<HTMLTextAreaElement>(/محتوى HTML/);
    expect(bodyHtmlArea.getAttribute('dir')).toBe('ltr');

    fireEvent.change(bodyHtmlArea, {
      target: { value: '<p>Hello {{unknown_token}}</p><script>alert(1)</script>' },
    });

    const tpl04Alert = screen.getByTestId('template-error-tpl04');
    expect(tpl04Alert.textContent).toContain('TPL04');
    expect(tpl04Alert.textContent).toContain('tag:script');

    const tpl01Alert = screen.getByTestId('template-error-tpl01');
    expect(tpl01Alert.textContent).toContain('TPL01');
    expect(tpl01Alert.textContent).toContain('unknown_token');
  });
});
