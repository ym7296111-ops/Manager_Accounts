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
      /* `code` is deliberately absent from Insert: `parties_before_write` mints
         it from a per-type sequence (LOC-001 / FRN-001 / CUS-001) and
         overwrites anything a client sends. `type` stays writable in Update
         only so the immutability spec can prove the database refuses to
         change it (22023); the application client never sends it. The retired
         `supplier` / `sister_company` / `internal` types are not modelled. */
      parties: Table<
        {
          id: string;
          type: string;
          name: string;
          code: string;
          tax_number: string | null;
          commercial_register: string | null;
          address: string | null;
          contact_person: string | null;
          phone: string | null;
          email: string | null;
          credit_limit: number | null;
          payment_terms: number | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        },
        {
          id?: string;
          type: string;
          name: string;
          tax_number?: string | null;
          commercial_register?: string | null;
          address?: string | null;
          contact_person?: string | null;
          phone?: string | null;
          email?: string | null;
          credit_limit?: number | null;
          payment_terms?: number | null;
          is_active?: boolean;
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
