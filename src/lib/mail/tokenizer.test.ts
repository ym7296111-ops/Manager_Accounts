// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  renderTemplateSinglePass,
  sha256Hex,
  substituteTemplateSinglePass,
  type TemplateVariableDefinition,
} from '@/lib/mail/tokenizer';

describe('mail template tokenizer (§2.4 / §2.5)', () => {
  it('escapes HTML supplied as a text variable and hashes the rendered output', async () => {
    const variables: readonly TemplateVariableDefinition[] = [
      { name: 'user_name', type: 'text', required: true },
    ];
    const rendered = await renderTemplateSinglePass({
      templateText: '<p>Hello, {{user_name}}</p>',
      variables,
      values: { user_name: '<script>alert(1)</script>' },
      context: 'html',
    });

    expect(rendered.text).toBe('<p>Hello, &lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(rendered.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rendered.content_hash).toBe(await sha256Hex(rendered.text));
  });

  it('substitutes once only and never rescans a variable value as template syntax', () => {
    const rendered = substituteTemplateSinglePass(
      'User: {{user_name}}',
      { user_name: '{{app_name}}' },
      { user_name: 'text' },
      false,
    );

    expect(rendered).toBe('User: {{app_name}}');
  });

  it('keeps the Phase 3 HTML link behavior for URL and email variables', async () => {
    const rendered = await renderTemplateSinglePass({
      templateText: '{{action_url}} — {{support_email}}',
      variables: [
        {
          name: 'action_url',
          type: 'url',
          required: true,
          allowed_hosts: ['app.example.com'],
        },
        { name: 'support_email', type: 'email', required: true },
      ],
      values: {
        action_url: 'https://app.example.com/reset?code=abc',
        support_email: 'support@example.com',
      },
      context: 'html',
    });

    expect(rendered.text).toBe(
      '<a href="https://app.example.com/reset?code=abc">https://app.example.com/reset?code=abc</a> — <a href="mailto:support@example.com">support@example.com</a>',
    );
  });
});
