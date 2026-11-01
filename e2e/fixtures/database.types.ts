import type { Json } from '../../src/lib/database.types.ts';

type Table<Row, Insert, Update = Partial<Insert>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};

export interface E2EDatabase {
  public: {
    Tables: {
      profiles: Table<
        { id: string; approval_status: string; status: string },
        { id: string; approval_status?: string; status?: string }
      >;
      user_roles: Table<{ user_id: string; role_id: string }, { user_id: string; role_id: string }>;
      roles: Table<{ id: string; slug: string }, { id?: string; slug: string }>;
      /* `code` is deliberately absent from Insert: it is minted server-side by
         next_station_code()/next_warehouse_code(), so a client cannot send one. */
      stations: Table<
        {
          id: string;
          code: string;
          name: string;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        },
        { id?: string; name: string; is_active?: boolean }
      >;
      warehouses: Table<
        {
          id: string;
          station_id: string;
          code: string;
          name: string;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        },
        { id?: string; station_id: string; name: string; is_active?: boolean }
      >;
      /* `code`, `level` and `is_leaf` are absent from Insert on purpose: the code
         is minted by next_classification_code() and the other two are derived by
         the classifications triggers from parent_id. A client cannot send them. */
      classifications: Table<
        {
          id: string;
          parent_id: string | null;
          code: string;
          name: string;
          level: number;
          is_leaf: boolean;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        },
        { id?: string; parent_id?: string | null; name: string; is_active?: boolean }
      >;
      /* A party is identity only: branch, name, code, is_active. `code` is
         deliberately absent from Insert — `parties_before_write` mints IN-###
         for an inbound party and OUT-### for an outbound one and overwrites
         anything a client sends. `branch` stays writable in Update only so the
         immutability spec can prove the database refuses to change it (22023);
         the application client never sends it. The retired profile columns
         (tax number, commercial register, address, contact person, phone,
         email, credit limit, payment terms) are not modelled because they no
         longer exist — a payload naming one is rejected by PostgREST. */
      parties: Table<
        {
          id: string;
          branch: string;
          name: string;
          code: string;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          branch: string;
          name: string;
          is_active?: boolean;
        }
      >;
      fiscal_years: Table<
        {
          id: string;
          name: string;
          start_date: string;
          end_date: string;
          is_active: boolean;
          is_closed: boolean;
          supplements_open: boolean;
          /** Freeze flag for «أرصدة أول المدة» (20261112000000). */
          opening_balances_locked: boolean;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          start_date: string;
          end_date: string;
          name?: string;
          is_active?: boolean;
          is_closed?: boolean;
          supplements_open?: boolean;
          opening_balances_locked?: boolean;
        }
      >;
      fiscal_months: Table<
        {
          id: string;
          fiscal_year_id: string;
          month_number: number;
          name: string;
          start_date: string;
          end_date: string;
          current_period: number;
          is_active: boolean;
          is_closed: boolean;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          fiscal_year_id: string;
          month_number: number;
          name: string;
          start_date: string;
          end_date: string;
          current_period?: number;
          is_closed?: boolean;
        },
        {
          current_period?: number;
          is_closed?: boolean;
          /** Service-role cleanup and the direct-write privilege probe only. */
          is_active?: boolean;
        }
      >;
      opening_balances: Table<
        {
          id: string;
          fiscal_year_id: string;
          warehouse_id: string;
          classification_id: string;
          amount: number;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          fiscal_year_id: string;
          warehouse_id: string;
          classification_id: string;
          amount?: number;
        }
      >;
      /* `code` and `level` are absent from Insert: `sister_companies_before_write`
         mints SIS-001 for a parent and SIS-001-01 for a branch, and derives the
         level from parent_id. `parent_id` stays writable in Update only so the
         immutability spec can prove the database refuses to change it (22023). */
      sister_companies: Table<
        {
          id: string;
          parent_id: string | null;
          level: number;
          code: string;
          name: string;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          parent_id?: string | null;
          name: string;
          is_active?: boolean;
        },
        {
          id?: string;
          parent_id?: string | null;
          level?: number;
          code?: string;
          name?: string;
          is_active?: boolean;
        }
      >;
      app_identity_settings: Table<
        {
          id: boolean;
          name_ar: string;
          name_en: string;
          admin_email: string | null;
          phone: string | null;
          logo_path: string | null;
          logo_hash: string | null;
          favicon_path: string | null;
          favicon_hash: string | null;
          assets_revision: number;
          updated_at: string;
          updated_by: string | null;
        },
        {
          id?: boolean;
          name_ar: string;
          name_en: string;
          admin_email?: string | null;
          phone?: string | null;
          logo_path?: string | null;
          logo_hash?: string | null;
          favicon_path?: string | null;
          favicon_hash?: string | null;
          assets_revision?: number;
          updated_at?: string;
          updated_by?: string | null;
        }
      >;
      audit_logs: Table<
        {
          id: number;
          actor_id: string | null;
          action: string;
          entity: string;
          entity_id: string;
          metadata: Json;
          created_at: string;
        },
        {
          id?: number;
          actor_id?: string | null;
          action: string;
          entity: string;
          entity_id: string;
          metadata?: Json;
          created_at?: string;
        }
      >;
      permissions: Table<
        { id: string; slug: string; is_delegatable: boolean },
        { id?: string; slug: string; is_delegatable?: boolean }
      >;
      user_capabilities: Table<
        { id: string; user_id: string; permission_id: string; revoked_at: string | null },
        { id?: string; user_id: string; permission_id: string; revoked_at?: string | null }
      >;
      password_reset_requests: Table<
        { id: string; email: string; status: string; created_at: string },
        { id?: string; email: string; status?: string; created_at?: string }
      >;
      user_notifications: Table<
        {
          id: string;
          user_id: string;
          type: string;
          title_key: string;
          body_key: string;
          params: Json;
          metadata: Json;
          link: string | null;
          is_read: boolean;
          read_at: string | null;
          related_id: string | null;
          resolved_at: string | null;
          dedupe_key: string;
          created_at: string;
        },
        {
          user_id: string;
          type: string;
          title_key: string;
          body_key: string;
          params?: Json;
          metadata?: Json;
          link?: string | null;
          is_read?: boolean;
          read_at?: string | null;
          related_id?: string | null;
          resolved_at?: string | null;
          dedupe_key: string;
        }
      >;
    };
    Views: Record<string, never>;
    Functions: {
      aps_activate_fiscal_month: {
        Args: { p_fiscal_month_id: string; p_reason?: string | null };
        Returns: Json;
      };
      admin_update_project_settings: {
        Args: {
          p_name_ar: string;
          p_name_en: string;
          p_admin_email?: string | null;
          p_phone?: string | null;
          p_logo_path?: string | null;
          p_logo_hash?: string | null;
          p_favicon_path?: string | null;
          p_favicon_hash?: string | null;
          p_clear_logo?: boolean;
          p_clear_favicon?: boolean;
          p_expected_updated_at?: string | null;
        };
        Returns: Json;
      };
      can_manage_project_settings: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      admin_approve_user: {
        Args: {
          p_user_id: string;
          p_action: string;
          p_executor_id: string;
          p_target_role: string;
        };
        Returns: undefined;
      };
      admin_grant_capability: {
        Args: {
          p_user_id: string;
          p_permission_slug: string;
          p_expires_at: string | null;
          p_executor_id: string;
        };
        Returns: string;
      };
      admin_revoke_capability: {
        Args: {
          p_capability_id: string;
          p_executor_id: string;
        };
        Returns: undefined;
      };
      admin_set_permission_delegatable: {
        Args: {
          p_permission_slug: string;
          p_is_delegatable: boolean;
          p_executor_id: string;
        };
        Returns: Json;
      };
      generate_delegation_expiry_notifications: {
        Args: Record<PropertyKey, never>;
        Returns: number;
      };
      get_my_delegated_capabilities: {
        Args: Record<PropertyKey, never>;
        Returns: Array<{
          id: string;
          slug: string;
          granted_by: string | null;
          granted_by_email: string | null;
          granted_at: string;
          expires_at: string | null;
        }>;
      };
      get_my_roles: {
        Args: Record<PropertyKey, never>;
        Returns: Array<{
          slug: string;
          name_ar: string;
          name_en: string;
        }>;
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
