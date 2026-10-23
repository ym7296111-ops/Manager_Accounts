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
