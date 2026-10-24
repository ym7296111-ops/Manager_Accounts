/**
 * Generated-style database types — PHASES 1+2 SLICE.
 *
 * Scope: the notification carrier/secrets tables
 * (`20261002120000_notification_transports_and_secrets.sql`) and the message
 * template tables (`20261002150000_notification_templates_schema.sql`), plus the
 * RPCs that are the only sanctioned access path, plus the app-identity
 * contracts used by Manager_Accounts, plus the project-settings
 * stations/warehouses tables
 * (`20261104030000_stations_and_warehouses.sql`). This file does NOT describe
 * the rest of the schema (profiles, RBAC, backups, support, workspaces,
 * localization); regenerate the complete file against the linked project when
 * those contracts are needed by the client.
 *
 * Regenerate the complete file against the linked project (this replaces the
 * slice wholesale, which is the intended end state):
 *
 *     npm run db:types
 *
 * Source of truth for every contract below:
 * docs/consultations/2026-10-02-notifications-smtp-templates-design-study.md
 *
 * Security notes mirrored in the types:
 * - `notification_transport_secrets` is never readable by an API role; the
 *   masked snapshot RPC exposes `has_password` + an 8-char fingerprint only.
 * - There is no `get_*password*` function anywhere, by design.
 * - All errors are value-free; SQLSTATEs are MAIL1..MAIL4 / SEC01 / 22023 / 42501.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      app_identity_settings: {
        Row: {
          admin_email: string | null;
          assets_revision: number;
          favicon_hash: string | null;
          favicon_path: string | null;
          id: boolean;
          logo_hash: string | null;
          logo_path: string | null;
          name_ar: string;
          name_en: string;
          phone: string | null;
          updated_at: string;
          updated_by: string | null;
        };
        Insert: {
          admin_email?: string | null;
          assets_revision?: number;
          favicon_hash?: string | null;
          favicon_path?: string | null;
          id?: boolean;
          logo_hash?: string | null;
          logo_path?: string | null;
          name_ar: string;
          name_en: string;
          phone?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Update: {
          admin_email?: string | null;
          assets_revision?: number;
          favicon_hash?: string | null;
          favicon_path?: string | null;
          id?: boolean;
          logo_hash?: string | null;
          logo_path?: string | null;
          name_ar?: string;
          name_en?: string;
          phone?: string | null;
          updated_at?: string;
          updated_by?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'app_identity_settings_updated_by_fkey';
            columns: ['updated_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      notification_encryption_keys: {
        Row: {
          created_at: string;
          created_by: string | null;
          id: string;
          is_current: boolean;
          key_source: string;
          key_version: number;
          kms_key_id: string | null;
          rotated_at: string | null;
          vault_secret_id: string | null;
        };
        Insert: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_current?: boolean;
          key_source: string;
          key_version: number;
          kms_key_id?: string | null;
          rotated_at?: string | null;
          vault_secret_id?: string | null;
        };
        Update: {
          created_at?: string;
          created_by?: string | null;
          id?: string;
          is_current?: boolean;
          key_source?: string;
          key_version?: number;
          kms_key_id?: string | null;
          rotated_at?: string | null;
          vault_secret_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'notification_encryption_keys_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      notification_transport_secrets: {
        Row: {
          cipher: string;
          content_fingerprint: string;
          created_at: string;
          created_by: string | null;
          encoding: string;
          key_id: string | null;
          kms_key_id: string | null;
          nonce: string;
          rotate_by: string | null;
          secret_ciphertext: string;
          secrets_version: number;
          tag: string | null;
          transport_id: string;
          updated_at: string;
          updated_by: string | null;
          wrapped_key: string | null;
        };
        Insert: {
          cipher: string;
          content_fingerprint: string;
          created_at?: string;
          created_by?: string | null;
          encoding?: string;
          key_id?: string | null;
          kms_key_id?: string | null;
          nonce: string;
          rotate_by?: string | null;
          secret_ciphertext: string;
          secrets_version: number;
          tag?: string | null;
          transport_id: string;
          updated_at?: string;
          updated_by?: string | null;
          wrapped_key?: string | null;
        };
        Update: {
          cipher?: string;
          content_fingerprint?: string;
          created_at?: string;
          created_by?: string | null;
          encoding?: string;
          key_id?: string | null;
          kms_key_id?: string | null;
          nonce?: string;
          rotate_by?: string | null;
          secret_ciphertext?: string;
          secrets_version?: number;
          tag?: string | null;
          transport_id?: string;
          updated_at?: string;
          updated_by?: string | null;
          wrapped_key?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'notification_transport_secrets_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notification_transport_secrets_key_id_fkey';
            columns: ['key_id'];
            isOneToOne: false;
            referencedRelation: 'notification_encryption_keys';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notification_transport_secrets_transport_id_fkey';
            columns: ['transport_id'];
            isOneToOne: true;
            referencedRelation: 'notification_transports';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notification_transport_secrets_updated_by_fkey';
            columns: ['updated_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      notification_templates: {
        Row: {
          body_html: string | null;
          body_text: string | null;
          channel: string;
          content_hash: string;
          created_at: string;
          created_by: string | null;
          direction: string;
          id: string;
          is_current: boolean;
          is_system: boolean;
          key: string;
          layout_key: string | null;
          locale: string;
          notes: string | null;
          requires_tokens: boolean;
          sample_variables: Json;
          status: string;
          subject: string;
          updated_at: string;
          updated_by: string | null;
          variables: Json;
          version: number;
        };
        Insert: {
          body_html?: string | null;
          body_text?: string | null;
          channel?: string;
          content_hash: string;
          created_at?: string;
          created_by?: string | null;
          direction?: string;
          id?: string;
          is_current?: boolean;
          is_system?: boolean;
          key: string;
          layout_key?: string | null;
          locale: string;
          notes?: string | null;
          requires_tokens?: boolean;
          sample_variables?: Json;
          status?: string;
          subject: string;
          updated_at?: string;
          updated_by?: string | null;
          variables?: Json;
          version: number;
        };
        Update: {
          body_html?: string | null;
          body_text?: string | null;
          channel?: string;
          content_hash?: string;
          created_at?: string;
          created_by?: string | null;
          direction?: string;
          id?: string;
          is_current?: boolean;
          is_system?: boolean;
          key?: string;
          layout_key?: string | null;
          locale?: string;
          notes?: string | null;
          requires_tokens?: boolean;
          sample_variables?: Json;
          status?: string;
          subject?: string;
          updated_at?: string;
          updated_by?: string | null;
          variables?: Json;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'notification_templates_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notification_templates_updated_by_fkey';
            columns: ['updated_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      notification_transports: {
        Row: {
          auth_mode: string;
          config: Json;
          created_at: string;
          created_by: string | null;
          daily_quota: number;
          host: string;
          id: string;
          is_default: boolean;
          is_enabled: boolean;
          last_test_at: string | null;
          last_test_detail: string | null;
          last_test_status: string | null;
          max_recipients_per_message: number;
          port: number;
          provider_type: string;
          reply_to_email: string | null;
          retry_backoff_ms: number;
          retry_max_attempts: number;
          secrets_version: number;
          sender_email: string;
          sender_name: string;
          slug: string;
          throttle_per_minute: number;
          timeout_ms: number;
          tls_mode: string;
          updated_at: string;
          updated_by: string | null;
          username: string | null;
        };
        Insert: {
          auth_mode?: string;
          config?: Json;
          created_at?: string;
          created_by?: string | null;
          daily_quota?: number;
          host: string;
          id?: string;
          is_default?: boolean;
          is_enabled?: boolean;
          last_test_at?: string | null;
          last_test_detail?: string | null;
          last_test_status?: string | null;
          max_recipients_per_message?: number;
          port?: number;
          provider_type?: string;
          reply_to_email?: string | null;
          retry_backoff_ms?: number;
          retry_max_attempts?: number;
          secrets_version?: number;
          sender_email: string;
          sender_name: string;
          slug: string;
          throttle_per_minute?: number;
          timeout_ms?: number;
          tls_mode?: string;
          updated_at?: string;
          updated_by?: string | null;
          username?: string | null;
        };
        Update: {
          auth_mode?: string;
          config?: Json;
          created_at?: string;
          created_by?: string | null;
          daily_quota?: number;
          host?: string;
          id?: string;
          is_default?: boolean;
          is_enabled?: boolean;
          last_test_at?: string | null;
          last_test_detail?: string | null;
          last_test_status?: string | null;
          max_recipients_per_message?: number;
          port?: number;
          provider_type?: string;
          reply_to_email?: string | null;
          retry_backoff_ms?: number;
          retry_max_attempts?: number;
          secrets_version?: number;
          sender_email?: string;
          sender_name?: string;
          slug?: string;
          throttle_per_minute?: number;
          timeout_ms?: number;
          tls_mode?: string;
          updated_at?: string;
          updated_by?: string | null;
          username?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'notification_transports_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notification_transports_updated_by_fkey';
            columns: ['updated_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      user_notifications: {
        Row: {
          body_key: string;
          created_at: string;
          dedupe_key: string;
          id: string;
          is_read: boolean;
          link: string | null;
          metadata: Json;
          params: Json;
          read_at: string | null;
          related_id: string | null;
          resolved_at: string | null;
          title_key: string;
          type: string;
          user_id: string;
        };
        Insert: {
          body_key: string;
          created_at?: string;
          dedupe_key: string;
          id?: string;
          is_read?: boolean;
          link?: string | null;
          metadata?: Json;
          params?: Json;
          read_at?: string | null;
          related_id?: string | null;
          resolved_at?: string | null;
          title_key: string;
          type: string;
          user_id: string;
        };
        Update: {
          body_key?: string;
          created_at?: string;
          dedupe_key?: string;
          id?: string;
          is_read?: boolean;
          link?: string | null;
          metadata?: Json;
          params?: Json;
          read_at?: string | null;
          related_id?: string | null;
          resolved_at?: string | null;
          title_key?: string;
          type?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      stations: {
        Row: {
          code: string;
          created_at: string;
          id: string;
          is_active: boolean;
          name: string;
          updated_at: string;
        };
        Insert: {
          /** Minted server-side from `station_code_seq` (ST-01); never send it. */
          code?: string;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          name: string;
          updated_at?: string;
        };
        Update: {
          code?: string;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          name?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      warehouses: {
        Row: {
          code: string;
          created_at: string;
          id: string;
          is_active: boolean;
          name: string;
          station_id: string;
          updated_at: string;
        };
        Insert: {
          /** Minted server-side from `warehouse_code_seq` (WH-001); never send it. */
          code?: string;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          name: string;
          station_id: string;
          updated_at?: string;
        };
        Update: {
          code?: string;
          created_at?: string;
          id?: string;
          is_active?: boolean;
          name?: string;
          station_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'warehouses_station_id_fkey';
            columns: ['station_id'];
            isOneToOne: false;
            referencedRelation: 'stations';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      admin_update_project_settings: {
        Args: {
          p_admin_email?: string | null;
          p_clear_favicon?: boolean;
          p_clear_logo?: boolean;
          p_expected_updated_at?: string | null;
          p_favicon_hash?: string | null;
          p_favicon_path?: string | null;
          p_logo_hash?: string | null;
          p_logo_path?: string | null;
          p_name_ar: string;
          p_name_en: string;
          p_phone?: string | null;
        };
        Returns: Json;
      };
      can_manage_project_settings: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      admin_clear_email_password: {
        Args: {
          p_expected_secrets_version?: number;
          p_expected_updated_at?: string;
          p_transport_slug?: string;
        };
        Returns: Json;
      };
      admin_get_email_transport: {
        Args: Record<PropertyKey, never>;
        Returns: Json;
      };
      admin_set_email_password: {
        Args: {
          p_expected_secrets_version?: number;
          p_expected_updated_at?: string;
          p_new_password: string;
          p_transport_slug?: string;
        };
        Returns: Json;
      };
      admin_store_email_secret: {
        Args: {
          p_cipher: string;
          p_ciphertext: string;
          p_content_fingerprint: string;
          p_expected_secrets_version?: number;
          p_key_version?: number;
          p_kms_key_id?: string;
          p_nonce: string;
          p_tag?: string;
          p_transport_slug: string;
          p_wrapped_key?: string;
        };
        Returns: Json;
      };
      admin_update_email_transport: {
        Args: {
          p_auth_mode?: string;
          p_config?: Json;
          p_daily_quota?: number;
          p_expected_updated_at?: string;
          p_host?: string;
          p_is_default?: boolean;
          p_is_enabled?: boolean;
          p_max_recipients_per_message?: number;
          p_port?: number;
          p_provider_type?: string;
          p_reply_to_email?: string;
          p_retry_backoff_ms?: number;
          p_retry_max_attempts?: number;
          p_sender_email?: string;
          p_sender_name?: string;
          p_slug?: string;
          p_throttle_per_minute?: number;
          p_timeout_ms?: number;
          p_tls_mode?: string;
          p_username?: string;
        };
        Returns: Json;
      };
      admin_delete_notification_template_draft: {
        Args: { p_id: string };
        Returns: boolean;
      };
      admin_list_notification_templates: {
        Args: { p_key?: string; p_locale?: string; p_status?: string };
        Returns: Database['public']['Tables']['notification_templates']['Row'][];
      };
      admin_preview_notification_template: {
        Args: { p_key: string; p_locale?: string; p_variables?: Json };
        Returns: Json;
      };
      admin_publish_notification_template: {
        Args: {
          p_expected_updated_at?: string;
          p_key: string;
          p_locale: string;
          p_version: number;
        };
        Returns: Json;
      };
      admin_render_notification: {
        Args: {
          p_key: string;
          p_locale?: string;
          p_mode?: string;
          p_variables?: Json;
        };
        Returns: Json;
      };
      admin_rollback_notification_template: {
        Args: { p_key: string; p_locale: string; p_to_version: number };
        Returns: Json;
      };
      admin_upsert_notification_template_draft: {
        Args: {
          p_body_html?: string;
          p_body_text?: string;
          p_channel?: string;
          p_direction?: string;
          p_expected_hash?: string;
          p_key: string;
          p_layout_key?: string;
          p_locale: string;
          p_notes?: string;
          p_requires_tokens?: boolean;
          p_sample_variables?: Json;
          p_subject: string;
          p_variables?: Json;
        };
        Returns: Json;
      };
      can_manage_email_transport: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      can_manage_notification_templates: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      generate_delegation_expiry_notifications: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      get_my_delegated_capabilities: {
        Args: Record<PropertyKey, never>;
        Returns: {
          expires_at: string | null;
          granted_at: string;
          granted_by: string | null;
          granted_by_email: string | null;
          id: string;
          slug: string;
        }[];
      };
      get_my_roles: {
        Args: Record<PropertyKey, never>;
        Returns: {
          name_ar: string;
          name_en: string;
          slug: string;
        }[];
      };
    };
    Enums: {
      audit_action:
        | 'auth.failed_sign_in'
        | 'auth.sign_in'
        | 'auth.sign_out'
        | 'backup.created'
        | 'backup.restored'
        | 'email.credentials_rotated'
        | 'email.transport_updated'
        | 'role.granted'
        | 'role.permissions_updated'
        | 'role.revoked'
        | 'settings.updated'
        | 'support.ticket_created'
        | 'support.ticket_replied'
        | 'support.ticket_status_updated'
        | 'user.created'
        | 'user.deleted'
        | 'user.suspended'
        | 'user.updated';
      user_status: 'active' | 'invited' | 'suspended';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DefaultSchema = Database['public'];

export type Tables<TableName extends keyof DefaultSchema['Tables']> =
  DefaultSchema['Tables'][TableName]['Row'];

export type TablesInsert<TableName extends keyof DefaultSchema['Tables']> =
  DefaultSchema['Tables'][TableName]['Insert'];

export type TablesUpdate<TableName extends keyof DefaultSchema['Tables']> =
  DefaultSchema['Tables'][TableName]['Update'];

export type Enums<EnumName extends keyof DefaultSchema['Enums']> = DefaultSchema['Enums'][EnumName];
