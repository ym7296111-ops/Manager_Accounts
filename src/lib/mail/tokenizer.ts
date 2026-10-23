/**
 * Server-side copy of Phase 3's `substituteTemplateSinglePass` contract.
 *
 * Study references (`docs/consultations/2026-10-02-notifications-smtp-templates-design-study.md`):
 * - §2.3: declared variable whitelist, reserved names, typed values and strict missing-value errors.
 * - §2.4: strict `{{snake_case}}` tokens, single-pass replacement, SHA-256 output hash.
 * - §2.5(ب): HTML-escape values in `body_html`; URL/email values use the same generated anchors
 *   as `src/hooks/useNotificationTemplates.ts` (Phase 3).
 *
 * Keep `substituteTemplateSinglePass` byte-for-byte equivalent in behavior to Phase 3. The higher-
 * level render helpers add delivery-time validation before calling that low-level substitution.
 */

export type TemplateVariableType = 'text' | 'url' | 'email' | 'int' | 'money' | 'datetime' | 'bool';

export interface TemplateVariableDefinition {
  readonly name: string;
  readonly type: TemplateVariableType;
  readonly required?: boolean;
  readonly max_length?: number;
  readonly allowed_hosts?: readonly string[];
}

export type TemplateRenderErrorCode = 'TPL01' | 'TPL02' | 'TPL04' | 'TPL05' | 'HASH_UNAVAILABLE';

export class TemplateRenderError extends Error {
  readonly code: TemplateRenderErrorCode;

  constructor(code: TemplateRenderErrorCode) {
    // §3.4: Never include variable values or raw template text in an error message.
    super(code);
    this.code = code;
    this.name = 'TemplateRenderError';
  }
}

const TOKEN_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const ALLOWED_VARIABLE_TYPES = new Set<TemplateVariableType>([
  'text',
  'url',
  'email',
  'int',
  'money',
  'datetime',
  'bool',
]);
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

function isReservedVariableName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return RESERVED_VARIABLE_NAMES.has(normalized) || normalized.startsWith('secret');
}

function containsControlCharacters(text: string): boolean {
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/** §2.4 / Phase 3: Escape all HTML text characters used by the editor contract. */
export function escapeTemplateHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** §2.4: Extract strict `{{snake_case}}` token names in source order. */
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
 * §2.4 step 2: The same fail-closed syntax scan used by the Phase 3 editor.
 * It reports stable classes only; callers must not add the source text to errors or logs.
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
 * §2.4 step 5 & §2.5(ب): Phase 3's literal single-pass substitution contract.
 *
 * Substituted values are never rescanned. Missing values intentionally retain the original token
 * here, matching the Phase 3 helper; delivery-facing render functions validate strictly first.
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

/** SHA-256 as lowercase hex, shared by the tokenizer and request idempotency check. */
export async function sha256Hex(text: string): Promise<string> {
  const webCrypto = globalThis.crypto;
  if (webCrypto?.subtle === undefined) {
    throw new TemplateRenderError('HASH_UNAVAILABLE');
  }

  const bytes = new TextEncoder().encode(text);
  try {
    const digest = new Uint8Array(await webCrypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    throw new TemplateRenderError('HASH_UNAVAILABLE');
  } finally {
    bytes.fill(0);
  }
}

export interface RenderTemplateSinglePassInput {
  readonly templateText: string;
  readonly variables: readonly TemplateVariableDefinition[];
  readonly values: Readonly<Record<string, string>>;
  /** `html` selects the Phase 3 body_html escaping/link behavior; defaults to plain text. */
  readonly context?: 'text' | 'html';
}

export interface RenderTemplateSinglePassResult {
  readonly text: string;
  readonly content_hash: string;
}

export interface NotificationTemplateForRendering {
  readonly subject: string;
  readonly body_text: string | null;
  readonly body_html: string | null;
  readonly variables: readonly TemplateVariableDefinition[];
}

export interface RenderedNotificationTemplate {
  readonly subject: string;
  readonly body_text: string | null;
  readonly body_html: string | null;
  readonly content_hash: string;
}

function validateVariableDefinitions(
  definitions: readonly TemplateVariableDefinition[],
): Map<string, TemplateVariableDefinition> {
  const byName = new Map<string, TemplateVariableDefinition>();
  for (const definition of definitions) {
    if (
      !TOKEN_NAME_PATTERN.test(definition.name) ||
      !ALLOWED_VARIABLE_TYPES.has(definition.type) ||
      byName.has(definition.name)
    ) {
      throw new TemplateRenderError('TPL02');
    }
    if (isReservedVariableName(definition.name)) {
      throw new TemplateRenderError('TPL05');
    }
    byName.set(definition.name, definition);
  }
  return byName;
}

function validateTemplateSyntax(texts: readonly (string | null)[]): void {
  for (const text of texts) {
    if (detectTemplateSyntaxProblems(text).length > 0) {
      throw new TemplateRenderError('TPL01');
    }
  }
}

function validateValues(
  definitions: ReadonlyMap<string, TemplateVariableDefinition>,
  values: Readonly<Record<string, string>>,
  texts: readonly (string | null)[],
): {
  readonly values: Record<string, string>;
  readonly types: Record<string, TemplateVariableType>;
} {
  const safeValues = Object.create(null) as Record<string, string>;
  const types = Object.create(null) as Record<string, TemplateVariableType>;

  for (const [name, value] of Object.entries(values)) {
    if (!definitions.has(name)) {
      throw new TemplateRenderError('TPL01');
    }
    if (typeof value !== 'string') {
      throw new TemplateRenderError('TPL02');
    }
    safeValues[name] = value;
  }

  for (const [name, definition] of definitions) {
    types[name] = definition.type;
    const value = safeValues[name];
    if (value === undefined) {
      if (definition.required === true) {
        throw new TemplateRenderError('TPL01');
      }
      continue;
    }

    const maxLength =
      typeof definition.max_length === 'number' &&
      Number.isInteger(definition.max_length) &&
      definition.max_length > 0
        ? Math.min(definition.max_length, 40960)
        : 4096;
    if (
      Array.from(value).length > maxLength ||
      containsControlCharacters(value) ||
      value.includes('{{') ||
      value.includes('}}')
    ) {
      throw new TemplateRenderError('TPL02');
    }

    if (definition.type === 'url') {
      const urlMatch = /^https:\/\/([A-Za-z0-9][A-Za-z0-9._-]*)(?::[0-9]{1,5})?(?:\/[^\s]*)?$/.exec(
        value,
      );
      const hostname = urlMatch?.[1]?.toLowerCase();
      if (hostname === undefined) {
        throw new TemplateRenderError('TPL02');
      }
      if (
        (definition.allowed_hosts?.length ?? 0) > 0 &&
        !definition.allowed_hosts?.some((allowedHost) => {
          const allowed = allowedHost.toLowerCase();
          return hostname === allowed || hostname.endsWith(`.${allowed}`);
        })
      ) {
        throw new TemplateRenderError('TPL02');
      }
    } else if (
      definition.type === 'email' &&
      !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value)
    ) {
      throw new TemplateRenderError('TPL02');
    } else if (
      (definition.type === 'int' || definition.type === 'money') &&
      !/^-?[0-9]{1,18}(?:\.[0-9]{1,6})?$/.test(value)
    ) {
      throw new TemplateRenderError('TPL02');
    } else if (definition.type === 'datetime' && !Number.isFinite(Date.parse(value))) {
      throw new TemplateRenderError('TPL02');
    } else if (definition.type === 'bool' && !['true', 'false'].includes(value.toLowerCase())) {
      throw new TemplateRenderError('TPL02');
    }
  }

  for (const text of texts) {
    for (const name of extractTemplateTokens(text)) {
      const definition = definitions.get(name);
      if (definition === undefined) {
        throw new TemplateRenderError(isReservedVariableName(name) ? 'TPL05' : 'TPL01');
      }
      if (safeValues[name] === undefined) {
        // §2.4 strict delivery mode: an optional variable still cannot be left unresolved when used.
        throw new TemplateRenderError('TPL01');
      }
    }
  }

  return { values: safeValues, types };
}

/**
 * Render one text surface and return its SHA-256 content hash.
 * The low-level substitution remains identical to the editor; this wrapper validates values first.
 */
export async function renderTemplateSinglePass(
  input: RenderTemplateSinglePassInput,
): Promise<RenderTemplateSinglePassResult> {
  validateTemplateSyntax([input.templateText]);
  const definitions = validateVariableDefinitions(input.variables);
  const prepared = validateValues(definitions, input.values, [input.templateText]);
  const text = substituteTemplateSinglePass(
    input.templateText,
    prepared.values,
    prepared.types,
    input.context === 'html',
  );
  return { text, content_hash: await sha256Hex(text) };
}

/**
 * Render the email surfaces using the Phase 3 substitution contract. The aggregate hash uses the
 * same `subject + newline + body_text + newline + body_html` bytes as the SQL renderer (§2.4/§2.7).
 */
export async function renderNotificationTemplate(input: {
  readonly template: NotificationTemplateForRendering;
  readonly values: Readonly<Record<string, string>>;
}): Promise<RenderedNotificationTemplate> {
  const { template, values } = input;
  const texts = [template.subject, template.body_text, template.body_html] as const;
  validateTemplateSyntax(texts);
  const definitions = validateVariableDefinitions(template.variables);
  const prepared = validateValues(definitions, values, texts);

  const subject = substituteTemplateSinglePass(
    template.subject,
    prepared.values,
    prepared.types,
    false,
  );
  const body_text = substituteTemplateSinglePass(
    template.body_text,
    prepared.values,
    prepared.types,
    false,
  );
  const body_html = substituteTemplateSinglePass(
    template.body_html,
    prepared.values,
    prepared.types,
    true,
  );
  const content_hash = await sha256Hex(`${subject}\n${body_text ?? ''}\n${body_html ?? ''}`);

  return { subject, body_text, body_html, content_hash };
}
