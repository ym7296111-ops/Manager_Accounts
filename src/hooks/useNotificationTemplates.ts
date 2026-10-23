import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { PostgrestError } from '@supabase/supabase-js';
import { getSupabase } from '@/lib/supabase';

/**
 * Notification Templates Query & Single-Pass Tokenizer/Validator Helpers (Phase 3.2).
 *
 * Study references (`docs/consultations/2026-10-02-notifications-smtp-templates-design-study.md`):
 * - §2.1: `public.notification_templates` — one row per `(key, locale, version)`, bilingual by rows,
 *   immutable once active (`draft → active → archived`), whitelisted `variables`, masked `sample_variables`.
 * - §2.3: Variable whitelist schema (`text`, `url`, `email`, `int`, `money`, `datetime`, `bool`) and
 *   reserved variable names (`smtp_password`, `token`, `jwt`, `session`, `cookie`, `api_key`, etc.).
 * - §2.4: Single-pass tokenizer (`{{snake_case}}`), fail-closed on nested/expression blocks, contextual
 *   HTML auto-escaping.
 * - §2.5: HTML tag/attribute/CSS allowlist; explicit refusal (`TPL04`) with element/attribute names only.
 * - §2.7: `admin_list_notification_templates` read contract.
 * - §3.4: Value-free normalized error codes (`TPL01..TPL05`, `42501`, `22023`).
 * - §3.6.4: TanStack Query key `['notification-templates', ...]` with non-zero `staleTime`.
 */

export const NOTIFICATION_TEMPLATES_QUERY_KEY = ['notification-templates'] as const;

export type TemplateLocale = 'ar' | 'en';
export type TemplateDirection = 'rtl' | 'ltr';
export type TemplateStatus = 'draft' | 'active' | 'archived';
export type TemplateChannel = 'email' | 'in_app' | 'sms' | 'webhook';
export type TemplateVariableType = 'text' | 'url' | 'email' | 'int' | 'money' | 'datetime' | 'bool';

export type TemplateErrorCode =
  | 'UNAVAILABLE'
  | 'FORBIDDEN'
  | 'VALIDATION'
  | 'TPL01'
  | 'TPL02'
  | 'TPL03'
  | 'TPL04'
  | 'TPL05'
  | 'HASH_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'NETWORK'
  | 'UNKNOWN';

export class TemplateError extends Error {
  readonly code: TemplateErrorCode;
  readonly field: string | null;
  readonly names: readonly string[];

  constructor(code: TemplateErrorCode, field: string | null = null, names: readonly string[] = []) {
    // §3.4: Error messages never carry raw user values; only normalized codes and element/field names.
    super(code);
    this.code = code;
    this.field = field;
    this.names = names;
    this.name = 'TemplateError';
  }
}

export interface TemplateVariableDefinition {
  readonly name: string;
  readonly type: TemplateVariableType;
  readonly required: boolean;
  readonly max_length?: number;
  readonly source?: 'identity';
  readonly requires_token?: boolean;
  readonly allowed_hosts?: readonly string[];
}

export interface NotificationTemplateRecord {
  readonly id: string;
  readonly key: string;
  readonly channel: TemplateChannel;
  readonly locale: TemplateLocale;
  readonly version: number;
  readonly status: TemplateStatus;
  readonly is_current: boolean;
  readonly subject: string;
  readonly body_text: string | null;
  readonly body_html: string | null;
  readonly layout_key: string | null;
  readonly direction: TemplateDirection;
  readonly variables: readonly TemplateVariableDefinition[];
  readonly sample_variables: Readonly<Record<string, string>>;
  readonly requires_tokens: boolean;
  readonly content_hash: string;
  readonly is_system: boolean;
  readonly notes: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface TemplateValidationResult {
  readonly ok: boolean;
  /** §2.5 & §3.4: Disallowed HTML tags/attributes/schemes (`TPL04`), reported as names only. */
  readonly htmlViolations: readonly string[];
  /** §2.3 & §2.4: Unknown/reserved tokens or syntax violations (`TPL01`/`TPL05`), reported as names only. */
  readonly variableViolations: readonly string[];
  /** §2.5(أ) & §3.6.2: 1-based line number of the first HTML violation in `body_html`. */
  readonly firstHtmlViolationLine: number | null;
}

// §2.3.2: Reserved variable names that can never appear in any template (`TPL05`).
const RESERVED_VARIABLE_NAMES = new Set<string>([
  'password',
  'passwd',
  'smtp_password',
  'smtp_pass',
  'mail_password',
  'token',
  'jwt',
  'session',
  'cookie',
  'api_key',
  'apikey',
  'service_role',
  'service_role_key',
  'anon_key',
  'database_url',
  'master_key',
  'private_key',
  'encryption_key',
]);

// §2.5(أ): Tag allowlist for email HTML templates.
const ALLOWED_HTML_TAGS = new Set<string>([
  'p',
  'br',
  'strong',
  'em',
  'b',
  'i',
  'a',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'h1',
  'h2',
  'h3',
  'h4',
  'blockquote',
  'span',
  'hr',
  'div',
  'img',
]);

// §2.5(أ): Attribute allowlist for email HTML templates.
const ALLOWED_HTML_ATTRS = new Set<string>([
  'href',
  'src',
  'alt',
  'width',
  'height',
  'align',
  'colspan',
  'rowspan',
  'dir',
  'style',
  'title',
]);

// §2.5(أ): Safe inline CSS property allowlist.
const ALLOWED_CSS_PROPS = new Set<string>([
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'font-family',
  'text-align',
  'direction',
  'line-height',
  'letter-spacing',
  'vertical-align',
  'text-decoration',
  'border-radius',
  'width',
  'height',
  'max-width',
  'padding',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'margin',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'border',
  'border-top',
  'border-right',
  'border-bottom',
  'border-left',
  'border-color',
  'border-width',
  'border-style',
]);

const VARIABLE_TYPES = new Set<TemplateVariableType>([
  'text',
  'url',
  'email',
  'int',
  'money',
  'datetime',
  'bool',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isReservedVariableName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return RESERVED_VARIABLE_NAMES.has(normalized) || normalized.startsWith('secret');
}

/**
 * §2.4: Contextually escape HTML text values (`&`, `<`, `>`, `"`, `'`).
 */
export function escapeTemplateHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * §2.4: Extract strict `{{snake_case}}` tokens in a single pass.
 */
export function extractTemplateTokens(text: string | null | undefined): string[] {
  if (!text) {
    return [];
  }
  const tokens: string[] = [];
  const regex = /\{\{[ ]*([a-z][a-z0-9_]{0,63})[ ]*\}\}/g;
  let match: RegExpExecArray | null = regex.exec(text);
  while (match !== null) {
    if (match[1] !== undefined) {
      tokens.push(match[1]);
    }
    match = regex.exec(text);
  }
  return tokens;
}

/**
 * §2.4 step 2: Fail-closed scan for forbidden template syntax (`{{{`, `{%`, `#{`, `{!`,
 * unbalanced braces, or malformed tokens).
 */
export function detectTemplateSyntaxProblems(text: string | null | undefined): string[] {
  if (!text) {
    return [];
  }
  const problems: string[] = [];
  if (/\{\{\{/.test(text)) {
    problems.push('triple_brace');
  }
  if (/\{%|#\{|\{!/.test(text)) {
    problems.push('statement_block');
  }
  const openCount = (text.length - text.replace(/\{\{/g, '').length) / 2;
  const closeCount = (text.length - text.replace(/\}\}/g, '').length) / 2;
  const strictMatches = text.match(/\{\{[ ]*[a-z][a-z0-9_]{0,63}[ ]*\}\}/g) ?? [];

  if (openCount !== closeCount) {
    problems.push('unbalanced_braces');
  }
  if (openCount !== strictMatches.length || closeCount !== strictMatches.length) {
    problems.push('invalid_token');
  }
  return problems;
}

/**
 * §2.5(أ): Scan `body_html` (and `subject`) against the strict email HTML allowlist.
 * Returns violation element/attribute names only (never raw user values).
 */
export function detectHtmlViolations(
  bodyHtml: string | null | undefined,
  subject?: string,
): { violations: string[]; firstLine: number | null } {
  const violations = new Set<string>();
  let firstLine: number | null = null;

  const recordViolation = (label: string, indexInHtml: number | null) => {
    violations.add(label);
    if (firstLine === null && indexInHtml !== null && typeof bodyHtml === 'string') {
      const prefix = bodyHtml.slice(0, Math.max(0, indexInHtml));
      firstLine = prefix.split('\n').length;
    }
  };

  // §2.1: No HTML tags inside subject (`subject !~ '<'`).
  if (typeof subject === 'string' && subject.includes('<')) {
    violations.add('subject:html_tag');
  }

  if (!bodyHtml || bodyHtml.trim() === '') {
    return { violations: Array.from(violations), firstLine };
  }

  const importMatch = /@import/i.exec(bodyHtml);
  if (importMatch !== null) {
    recordViolation('raw:import', importMatch.index);
  }
  const exprMatch = /expression\s*\(|-moz-binding/i.exec(bodyHtml);
  if (exprMatch !== null) {
    recordViolation('raw:css_expression', exprMatch.index);
  }

  const tagRegex = /<[^>]*>/g;
  let tagMatch: RegExpExecArray | null = tagRegex.exec(bodyHtml);
  while (tagMatch !== null) {
    const block = tagMatch[0];
    const tagIndex = tagMatch.index;

    const nameMatch = /^<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(block);
    const tagName = nameMatch?.[1]?.toLowerCase();
    if (tagName && !ALLOWED_HTML_TAGS.has(tagName)) {
      recordViolation(`tag:${tagName}`, tagIndex);
    }

    // §2.5: Placeholders inside HTML attributes are strictly forbidden.
    if (block.includes('{{') || block.includes('}}')) {
      recordViolation('placeholder_in_attribute', tagIndex);
    }

    const attrRegex = /\s([a-zA-Z][a-zA-Z0-9-]*)\s*=/g;
    let attrMatch: RegExpExecArray | null = attrRegex.exec(block);
    while (attrMatch !== null) {
      const attrName = attrMatch[1]?.toLowerCase();
      if (attrName) {
        if (attrName.startsWith('on') || !ALLOWED_HTML_ATTRS.has(attrName)) {
          recordViolation(`attr:${attrName}`, tagIndex);
        }
      }
      attrMatch = attrRegex.exec(block);
    }

    if (/(href|src)\s*=\s*['"]\s*(javascript|vbscript|data|file|blob):/i.test(block)) {
      recordViolation('scheme:unsafe', tagIndex);
    }

    const styleDouble = /\sstyle\s*=\s*"([^"]*)"/i.exec(block);
    const styleSingle = /\sstyle\s*=\s*'([^']*)'/i.exec(block);
    const styleContent = styleDouble?.[1] ?? styleSingle?.[1] ?? null;
    if (styleContent !== null) {
      if (/url\s*\(|expression|@import/i.test(styleContent)) {
        recordViolation('css:unsafe', tagIndex);
      }
      const cssPropRegex = /([a-zA-Z-]+)\s*:/g;
      let cssMatch: RegExpExecArray | null = cssPropRegex.exec(styleContent);
      while (cssMatch !== null) {
        const cssProp = cssMatch[1]?.toLowerCase();
        if (cssProp && !ALLOWED_CSS_PROPS.has(cssProp)) {
          recordViolation(`css:${cssProp}`, tagIndex);
        }
        cssMatch = cssPropRegex.exec(styleContent);
      }
    }

    tagMatch = tagRegex.exec(bodyHtml);
  }

  return {
    violations: Array.from(violations),
    firstLine,
  };
}

/**
 * §2.3, §2.4 & §2.5: Validate template fields against the variable whitelist and HTML allowlist.
 */
export function validateTemplateContent(input: {
  readonly subject: string;
  readonly body_text: string;
  readonly body_html: string;
  readonly variables: readonly TemplateVariableDefinition[];
}): TemplateValidationResult {
  const declaredNames = new Set(input.variables.map((v) => v.name));
  const variableProblems = new Set<string>();

  for (const v of input.variables) {
    if (isReservedVariableName(v.name)) {
      variableProblems.add(`reserved:${v.name}`);
    }
  }

  const syntaxProblems = [
    ...detectTemplateSyntaxProblems(input.subject),
    ...detectTemplateSyntaxProblems(input.body_text),
    ...detectTemplateSyntaxProblems(input.body_html),
  ];
  for (const problem of syntaxProblems) {
    variableProblems.add(problem);
  }

  const allTokens = [
    ...extractTemplateTokens(input.subject),
    ...extractTemplateTokens(input.body_text),
    ...extractTemplateTokens(input.body_html),
  ];

  for (const token of allTokens) {
    if (isReservedVariableName(token)) {
      variableProblems.add(`reserved:${token}`);
    } else if (!declaredNames.has(token)) {
      variableProblems.add(token);
    }
  }

  const htmlCheck = detectHtmlViolations(input.body_html, input.subject);

  return {
    ok: variableProblems.size === 0 && htmlCheck.violations.length === 0,
    htmlViolations: htmlCheck.violations,
    variableViolations: Array.from(variableProblems),
    firstHtmlViolationLine: htmlCheck.firstLine,
  };
}

/**
 * §2.4 step 5 & §2.5(ب): Single-pass substitution over a copy of the template text.
 * Substituted values are never rescanned, and HTML output applies contextual escaping.
 */
export function substituteTemplateSinglePass(
  text: string | null | undefined,
  values: Readonly<Record<string, string>>,
  variableTypes: Readonly<Record<string, TemplateVariableType>>,
  isHtml: boolean,
): string {
  if (!text) {
    return '';
  }

  const tokenRegex = /\{\{[ ]*([a-z][a-z0-9_]{0,63})[ ]*\}\}/g;
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null = tokenRegex.exec(text);

  while (match !== null) {
    result += text.slice(lastIndex, match.index);
    const tokenName = match[1] ?? '';
    const rawValue = values[tokenName] ?? `{{${tokenName}}}`;
    const varType = variableTypes[tokenName] ?? 'text';

    if (!isHtml) {
      result += rawValue;
    } else if (varType === 'url' && values[tokenName] !== undefined) {
      const escaped = escapeTemplateHtml(rawValue);
      result += `<a href="${escaped}">${escaped}</a>`;
    } else if (varType === 'email' && values[tokenName] !== undefined) {
      const escaped = escapeTemplateHtml(rawValue);
      result += `<a href="mailto:${escaped}">${escaped}</a>`;
    } else {
      result += escapeTemplateHtml(rawValue);
    }

    lastIndex = match.index + match[0].length;
    match = tokenRegex.exec(text);
  }

  result += text.slice(lastIndex);
  return result;
}

/**
 * §2.4 & §3.6.3: Render a template locally for live preview using `sample_variables`
 * without making network calls on every keystroke.
 */
export function renderTemplatePreviewLocally(input: {
  readonly subject: string;
  readonly body_text: string;
  readonly body_html: string;
  readonly variables: readonly TemplateVariableDefinition[];
  readonly sample_variables?: Readonly<Record<string, string>>;
}): {
  readonly subject: string;
  readonly body_text: string;
  readonly body_html: string;
} {
  const sampleValues: Record<string, string> = {};
  const variableTypes: Record<string, TemplateVariableType> = {};

  for (const variable of input.variables) {
    variableTypes[variable.name] = variable.type;
    const sample = input.sample_variables?.[variable.name];
    if (typeof sample === 'string' && sample.length > 0) {
      sampleValues[variable.name] = sample;
    } else if (variable.type === 'url') {
      sampleValues[variable.name] = 'https://app.example.invalid/action';
    } else if (variable.type === 'email') {
      sampleValues[variable.name] = 'support@example.invalid';
    } else if (variable.type === 'datetime') {
      sampleValues[variable.name] = '2026-10-02T12:00:00Z';
    } else if (variable.type === 'int' || variable.type === 'money') {
      sampleValues[variable.name] = '100';
    } else {
      sampleValues[variable.name] = `[${variable.name}]`;
    }
  }

  if (input.sample_variables) {
    for (const [k, v] of Object.entries(input.sample_variables)) {
      if (typeof v === 'string' && sampleValues[k] === undefined) {
        sampleValues[k] = v;
      }
    }
  }

  return {
    subject: substituteTemplateSinglePass(input.subject, sampleValues, variableTypes, false),
    body_text: substituteTemplateSinglePass(input.body_text, sampleValues, variableTypes, false),
    body_html: substituteTemplateSinglePass(input.body_html, sampleValues, variableTypes, true),
  };
}

function parseVariableDefinitions(raw: unknown): TemplateVariableDefinition[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const list: TemplateVariableDefinition[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== 'string') {
      continue;
    }
    const rawType = typeof item.type === 'string' ? (item.type as TemplateVariableType) : 'text';
    const type: TemplateVariableType = VARIABLE_TYPES.has(rawType) ? rawType : 'text';
    list.push({
      name: item.name,
      type,
      required: item.required === true,
      max_length: typeof item.max_length === 'number' ? item.max_length : undefined,
      source: item.source === 'identity' ? 'identity' : undefined,
      requires_token: item.requires_token === true ? true : undefined,
      allowed_hosts: Array.isArray(item.allowed_hosts)
        ? item.allowed_hosts.filter((h): h is string => typeof h === 'string')
        : undefined,
    });
  }
  return list;
}

function parseSampleVariables(raw: unknown): Record<string, string> {
  if (!isRecord(raw)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      out[key] = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = String(value);
    }
  }
  return out;
}

export function parseNotificationTemplate(raw: unknown): NotificationTemplateRecord | null {
  if (!isRecord(raw)) {
    return null;
  }
  const key = typeof raw.key === 'string' ? raw.key : null;
  const subject = typeof raw.subject === 'string' ? raw.subject : null;
  if (key === null || subject === null) {
    return null;
  }

  const locale: TemplateLocale = raw.locale === 'en' ? 'en' : 'ar';
  const direction: TemplateDirection =
    raw.direction === 'ltr' || raw.direction === 'rtl'
      ? raw.direction
      : locale === 'ar'
        ? 'rtl'
        : 'ltr';
  const status: TemplateStatus =
    raw.status === 'active' || raw.status === 'archived' || raw.status === 'draft'
      ? raw.status
      : 'draft';
  const channel: TemplateChannel =
    raw.channel === 'in_app' || raw.channel === 'sms' || raw.channel === 'webhook'
      ? raw.channel
      : 'email';

  return {
    id: typeof raw.id === 'string' ? raw.id : `${key}-${locale}-v1`,
    key,
    channel,
    locale,
    version: typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 1,
    status,
    is_current: raw.is_current === true,
    subject,
    body_text: typeof raw.body_text === 'string' ? raw.body_text : null,
    body_html: typeof raw.body_html === 'string' ? raw.body_html : null,
    layout_key: typeof raw.layout_key === 'string' ? raw.layout_key : null,
    direction,
    variables: parseVariableDefinitions(raw.variables),
    sample_variables: parseSampleVariables(raw.sample_variables),
    requires_tokens: raw.requires_tokens === true,
    content_hash:
      typeof raw.content_hash === 'string' && raw.content_hash.length === 64
        ? raw.content_hash
        : '0'.repeat(64),
    is_system: raw.is_system === true,
    notes: typeof raw.notes === 'string' ? raw.notes : null,
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '1970-01-01T00:00:00Z',
    updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : '1970-01-01T00:00:00Z',
  };
}

/**
 * §2.9: Canonical fallback seed (`auth.welcome_invitation`) matching Phase 2 migration.
 */
export function fallbackNotificationTemplate(
  key = 'auth.welcome_invitation',
  locale: TemplateLocale = 'ar',
): NotificationTemplateRecord {
  const isArabic = locale === 'ar';
  return {
    id: `${key}-${locale}-v1`,
    key,
    channel: 'email',
    locale,
    version: 1,
    status: 'active',
    is_current: true,
    subject: isArabic
      ? 'مرحباً {{user_name}} — تفعيل حسابك في {{app_name}}'
      : 'Welcome {{user_name}} — activate your {{app_name}} account',
    body_text: isArabic
      ? 'مرحباً {{user_name}},\n\nتم إنشاء حسابك في {{app_name}}.\nلتفعيل الحساب افتح الرابط التالي:\n{{action_url}}\n\nينتهي الرابط في {{expires_at}}.\nللدعم راسلنا على {{support_email}}.'
      : 'Hi {{user_name}},\n\nYour {{app_name}} account has been created.\nOpen the link below to activate it:\n{{action_url}}\n\nThe link expires at {{expires_at}}.\nFor help, contact {{support_email}}.',
    body_html: isArabic
      ? '<div dir="rtl"><h2>مرحباً {{user_name}}</h2><p>تم إنشاء حسابك في {{app_name}}.</p><p>لتفعيل الحساب اضغط على الرابط التالي:</p><p>{{action_url}}</p><p>ينتهي الرابط في {{expires_at}}.</p><hr><p>للدعم راسلنا على {{support_email}}.</p></div>'
      : '<div dir="ltr"><h2>Welcome {{user_name}}</h2><p>Your {{app_name}} account has been created.</p><p>Open the link below to activate it:</p><p>{{action_url}}</p><p>The link expires at {{expires_at}}.</p><hr><p>For help, contact {{support_email}}.</p></div>',
    layout_key: null,
    direction: isArabic ? 'rtl' : 'ltr',
    variables: [
      { name: 'user_name', type: 'text', required: true, max_length: 120 },
      { name: 'app_name', type: 'text', required: true, max_length: 80, source: 'identity' },
      { name: 'action_url', type: 'url', required: true, requires_token: true },
      { name: 'expires_at', type: 'datetime', required: false },
      { name: 'support_email', type: 'email', required: false },
    ],
    sample_variables: {
      user_name: isArabic ? 'لينا' : 'Lina',
      app_name: isArabic ? 'نظام الإدارة' : 'Admin System',
      action_url: 'https://app.example.invalid/invitations/confirm',
      expires_at: '2026-10-09T12:00:00Z',
      support_email: 'support@example.invalid',
    },
    requires_tokens: true,
    content_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    is_system: true,
    notes: null,
    created_at: '1970-01-01T00:00:00Z',
    updated_at: '1970-01-01T00:00:00Z',
  };
}

function parseDetailNames(detail: string): string[] {
  const match = /names:\s*(.+)$/i.exec(detail.trim());
  if (!match || !match[1]) {
    return [];
  }
  const rawNames = match[1].trim();
  if (rawNames.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(rawNames);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === 'string');
      }
    } catch {
      // Fall through to comma-split parsing.
    }
  }
  return rawNames
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * §3.4: Map PostgREST / PostgreSQL error codes into value-free `TemplateError` instances.
 */
export function toTemplateError(error: unknown): TemplateError {
  if (error instanceof TemplateError) {
    return error;
  }
  const pg = error as Partial<PostgrestError> & { status?: number; message?: string };
  const code = pg.code ?? '';
  const message = pg.message ?? '';
  const detail = pg.details ?? '';
  const fieldMatch = /field:\s*([a-z0-9_]+)/i.exec(detail);
  const field = fieldMatch?.[1] ?? null;
  const names = parseDetailNames(detail);

  if (code === '42501') {
    return new TemplateError('FORBIDDEN', field, names);
  }
  if (code === 'TPL01' || message.includes('TPL01')) {
    return new TemplateError('TPL01', field, names);
  }
  if (code === 'TPL02' || message.includes('TPL02')) {
    return new TemplateError('TPL02', field, names);
  }
  if (code === 'TPL03' || message.includes('TPL03')) {
    return new TemplateError('TPL03', field, names);
  }
  if (code === 'TPL04' || message.includes('TPL04')) {
    return new TemplateError('TPL04', field, names);
  }
  if (code === 'TPL05' || message.includes('TPL05')) {
    return new TemplateError('TPL05', field, names);
  }
  if (code === '22023') {
    if (field === 'expected_hash') {
      return new TemplateError('HASH_CONFLICT', field, names);
    }
    if (field === 'expected_updated_at') {
      return new TemplateError('VERSION_CONFLICT', field, names);
    }
    return new TemplateError('VALIDATION', field, names);
  }
  if (
    error instanceof TypeError ||
    message.toLowerCase().includes('fetch') ||
    message.toLowerCase().includes('network')
  ) {
    return new TemplateError('NETWORK', field, names);
  }
  return new TemplateError('UNKNOWN', field, names);
}

export interface UseNotificationTemplatesOptions {
  readonly key?: string;
  readonly locale?: TemplateLocale;
  readonly status?: TemplateStatus;
  readonly enabled?: boolean;
}

export interface UseNotificationTemplatesResult {
  readonly templates: readonly NotificationTemplateRecord[];
  readonly currentTemplate: NotificationTemplateRecord | null;
  readonly draftTemplate: NotificationTemplateRecord | null;
  readonly activeTemplate: NotificationTemplateRecord | null;
  readonly error: TemplateError | null;
  readonly isLoading: boolean;
  readonly isFetching: boolean;
  readonly refetch: UseQueryResult<readonly NotificationTemplateRecord[], TemplateError>['refetch'];
}

/**
 * §2.7 & §3.6.4: `useQuery` hook calling `admin_list_notification_templates`
 * with query key `['notification-templates', key, locale, status]` and non-zero `staleTime`.
 */
export function useNotificationTemplates(
  options?: UseNotificationTemplatesOptions,
): UseNotificationTemplatesResult {
  const key = options?.key;
  const locale = options?.locale;
  const status = options?.status;
  const enabled = options?.enabled ?? true;

  const query = useQuery<readonly NotificationTemplateRecord[], TemplateError>({
    queryKey: [...NOTIFICATION_TEMPLATES_QUERY_KEY, key ?? 'all', locale ?? 'all', status ?? 'all'],
    enabled,
    // §3.6.4: Non-zero staleTime prevents settings screen flicker.
    staleTime: 30_000,
    retry: false,
    queryFn: async (): Promise<readonly NotificationTemplateRecord[]> => {
      const client = getSupabase();
      if (client === null) {
        throw new TemplateError('UNAVAILABLE');
      }

      const response: { data: unknown; error: PostgrestError | null } = await client.rpc(
        'admin_list_notification_templates',
        {
          p_key: key,
          p_locale: locale,
          p_status: status,
        },
      );

      if (response.error !== null) {
        throw toTemplateError(response.error);
      }

      if (!Array.isArray(response.data)) {
        return [];
      }

      const parsed: NotificationTemplateRecord[] = [];
      for (const row of response.data) {
        const record = parseNotificationTemplate(row);
        if (record !== null) {
          parsed.push(record);
        }
      }
      return parsed;
    },
  });

  const templates = query.data ?? [];
  const draftTemplate =
    templates.find(
      (tpl) =>
        tpl.status === 'draft' &&
        (key === undefined || tpl.key === key) &&
        (locale === undefined || tpl.locale === locale),
    ) ?? null;
  const activeTemplate =
    templates.find(
      (tpl) =>
        tpl.status === 'active' &&
        tpl.is_current &&
        (key === undefined || tpl.key === key) &&
        (locale === undefined || tpl.locale === locale),
    ) ?? null;

  return {
    templates,
    currentTemplate: draftTemplate ?? activeTemplate ?? templates[0] ?? null,
    draftTemplate,
    activeTemplate,
    error: query.error ?? null,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    refetch: query.refetch,
  };
}
