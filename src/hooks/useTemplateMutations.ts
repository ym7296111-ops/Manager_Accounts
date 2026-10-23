import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query';
import type { PostgrestError } from '@supabase/supabase-js';
import {
  NOTIFICATION_TEMPLATES_QUERY_KEY,
  TemplateError,
  toTemplateError,
  type TemplateChannel,
  type TemplateDirection,
  type TemplateLocale,
  type TemplateStatus,
  type TemplateVariableDefinition,
} from '@/hooks/useNotificationTemplates';
import type { Json } from '@/lib/database.types';
import { getSupabase } from '@/lib/supabase';

/**
 * Notification Template Write Mutations (Phase 3.2).
 *
 * Study references (`docs/consultations/2026-10-02-notifications-smtp-templates-design-study.md`):
 * - §2.1.2 & §2.2: Immutability of active templates (`draft → active → archived`). Editing creates/updates
 *   a draft row; publishing atomically promotes the draft to `active` (`is_current = true`) and archives
 *   the prior active version.
 * - §2.7: RPC contracts:
 *   - `admin_upsert_notification_template_draft` with `p_expected_hash` optimistic lock.
 *   - `admin_publish_notification_template` with `p_expected_updated_at` optimistic lock.
 * - §3.3 & §3.4: `SECURITY DEFINER` RPCs are the sole write path; errors are normalized and value-free.
 * - §3.6.4: Mutations invalidate `['notification-templates']` upon completion.
 */

export interface UpsertTemplateDraftInput {
  readonly key: string;
  readonly locale: TemplateLocale;
  readonly subject: string;
  readonly body_text: string | null;
  readonly body_html?: string | null;
  readonly variables?: readonly TemplateVariableDefinition[];
  readonly sample_variables?: Readonly<Record<string, string>>;
  readonly requires_tokens?: boolean;
  readonly channel?: TemplateChannel;
  readonly layout_key?: string | null;
  readonly direction?: TemplateDirection;
  readonly notes?: string | null;
  /** §2.7 & §3.3: Optimistic lock hash (`p_expected_hash`) when updating an existing draft. */
  readonly expected_hash?: string | null;
}

export interface UpsertTemplateDraftAck {
  readonly id: string;
  readonly key: string;
  readonly locale: TemplateLocale;
  readonly channel: TemplateChannel;
  readonly version: number;
  readonly status: TemplateStatus;
  readonly content_hash: string;
  readonly unchanged: boolean;
  readonly updated_at: string;
}

export interface PublishTemplateInput {
  readonly key: string;
  readonly locale: TemplateLocale;
  readonly version: number;
  /** §2.7 & §3.3: Optional optimistic lock timestamp (`p_expected_updated_at`). */
  readonly expected_updated_at?: string | null;
}

export interface PublishTemplateAck {
  readonly id: string;
  readonly key: string;
  readonly locale: TemplateLocale;
  readonly version: number;
  readonly status: TemplateStatus;
  readonly is_current: boolean;
  readonly content_hash: string;
  readonly previous_version: number | null;
  readonly updated_at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeExpectedTimestamp(value: string | null | undefined): string | undefined {
  if (!value || value.startsWith('1970-')) {
    return undefined;
  }
  return value;
}

function normalizeExpectedHash(value: string | null | undefined): string | undefined {
  if (!value || value.trim().length !== 64 || /^0+$/.test(value.trim())) {
    return undefined;
  }
  return value.trim();
}

function parseUpsertDraftAck(
  raw: unknown,
  fallback: UpsertTemplateDraftInput,
): UpsertTemplateDraftAck {
  const record = isRecord(raw) ? raw : {};
  const locale: TemplateLocale = record.locale === 'en' ? 'en' : fallback.locale;
  const channel: TemplateChannel =
    record.channel === 'in_app' || record.channel === 'sms' || record.channel === 'webhook'
      ? record.channel
      : (fallback.channel ?? 'email');
  const status: TemplateStatus =
    record.status === 'active' || record.status === 'archived' ? record.status : 'draft';

  return {
    id: typeof record.id === 'string' ? record.id : `${fallback.key}-${locale}-draft`,
    key: typeof record.key === 'string' ? record.key : fallback.key,
    locale,
    channel,
    version: typeof record.version === 'number' ? record.version : 1,
    status,
    content_hash:
      typeof record.content_hash === 'string' && record.content_hash.length === 64
        ? record.content_hash
        : '0'.repeat(64),
    unchanged: record.unchanged === true,
    updated_at:
      typeof record.updated_at === 'string' ? record.updated_at : new Date().toISOString(),
  };
}

function parsePublishAck(raw: unknown, fallback: PublishTemplateInput): PublishTemplateAck {
  const record = isRecord(raw) ? raw : {};
  const locale: TemplateLocale = record.locale === 'en' ? 'en' : fallback.locale;
  const status: TemplateStatus =
    record.status === 'draft' || record.status === 'archived' ? record.status : 'active';

  return {
    id:
      typeof record.id === 'string' ? record.id : `${fallback.key}-${locale}-v${fallback.version}`,
    key: typeof record.key === 'string' ? record.key : fallback.key,
    locale,
    version: typeof record.version === 'number' ? record.version : fallback.version,
    status,
    is_current: record.is_current !== false,
    content_hash:
      typeof record.content_hash === 'string' && record.content_hash.length === 64
        ? record.content_hash
        : '0'.repeat(64),
    previous_version: typeof record.previous_version === 'number' ? record.previous_version : null,
    updated_at:
      typeof record.updated_at === 'string' ? record.updated_at : new Date().toISOString(),
  };
}

/**
 * §2.7 & §3.6.4: `useMutation` calling `admin_upsert_notification_template_draft`
 * with `p_expected_hash` for optimistic locking.
 */
export function useUpsertTemplateDraft(): UseMutationResult<
  UpsertTemplateDraftAck,
  TemplateError,
  UpsertTemplateDraftInput
> {
  const queryClient = useQueryClient();

  return useMutation<UpsertTemplateDraftAck, TemplateError, UpsertTemplateDraftInput>({
    mutationFn: async (input: UpsertTemplateDraftInput): Promise<UpsertTemplateDraftAck> => {
      const client = getSupabase();
      if (client === null) {
        throw new TemplateError('UNAVAILABLE');
      }

      const response: { data: unknown; error: PostgrestError | null } = await client.rpc(
        'admin_upsert_notification_template_draft',
        {
          p_key: input.key.trim(),
          p_locale: input.locale,
          p_subject: input.subject.trim(),
          p_body_text: input.body_text ?? undefined,
          p_body_html:
            input.body_html !== undefined &&
            input.body_html !== null &&
            input.body_html.trim() !== ''
              ? input.body_html
              : undefined,
          p_variables: (input.variables ?? []) as unknown as Json,
          p_sample_variables: (input.sample_variables ?? {}) as unknown as Json,
          p_requires_tokens: input.requires_tokens,
          p_channel: input.channel ?? 'email',
          p_layout_key: input.layout_key ?? undefined,
          p_direction: input.direction ?? (input.locale === 'ar' ? 'rtl' : 'ltr'),
          p_notes: input.notes ?? undefined,
          // §2.7 & §3.3: Optimistic lock hash on existing draft versions.
          p_expected_hash: normalizeExpectedHash(input.expected_hash),
        },
      );

      if (response.error !== null) {
        throw toTemplateError(response.error);
      }

      return parseUpsertDraftAck(response.data, input);
    },
    onSuccess: () => {
      // §3.6.4: Invalidate ['notification-templates'] cache after saving a draft.
      void queryClient.invalidateQueries({ queryKey: NOTIFICATION_TEMPLATES_QUERY_KEY });
    },
  });
}

/**
 * §2.7 & §3.6.4: `useMutation` calling `admin_publish_notification_template`
 * to atomically promote a draft to `active` (`is_current = true`) and archive the previous version.
 */
export function usePublishTemplate(): UseMutationResult<
  PublishTemplateAck,
  TemplateError,
  PublishTemplateInput
> {
  const queryClient = useQueryClient();

  return useMutation<PublishTemplateAck, TemplateError, PublishTemplateInput>({
    mutationFn: async (input: PublishTemplateInput): Promise<PublishTemplateAck> => {
      const client = getSupabase();
      if (client === null) {
        throw new TemplateError('UNAVAILABLE');
      }

      const response: { data: unknown; error: PostgrestError | null } = await client.rpc(
        'admin_publish_notification_template',
        {
          p_key: input.key.trim(),
          p_locale: input.locale,
          p_version: input.version,
          p_expected_updated_at: normalizeExpectedTimestamp(input.expected_updated_at),
        },
      );

      if (response.error !== null) {
        throw toTemplateError(response.error);
      }

      return parsePublishAck(response.data, input);
    },
    onSuccess: () => {
      // §3.6.4: Invalidate ['notification-templates'] cache after publishing a template version.
      void queryClient.invalidateQueries({ queryKey: NOTIFICATION_TEMPLATES_QUERY_KEY });
    },
  });
}
