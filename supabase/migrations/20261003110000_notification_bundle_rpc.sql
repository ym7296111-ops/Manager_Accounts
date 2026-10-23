-- Notification bundle portability (Task 4.4).
--
-- Study references: D12 and §2.10 — the reproducible template is one reviewed JSONB
-- document containing notification configuration and active/draft templates, never credentials.
--
-- Security invariants:
--   * export is allowed to active settings.manage OR notifications.manage users;
--   * import is allowed to active settings.manage users only;
--   * neither function reads from or writes to notification_transport_secrets;
--   * JSON keys are projected explicitly (never to_jsonb(table_row));
--   * importing always creates disabled, non-default transports and never updates templates.

-- ---------------------------------------------------------------------------
-- 1) Export a reviewed, non-secret bundle (study D12 / §2.10)
-- ---------------------------------------------------------------------------
create or replace function public.admin_export_notification_bundle()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_transports jsonb;
  v_templates jsonb;
begin
  if v_actor is null
     or not coalesce(public.is_active_user(), false)
     or not (
       coalesce(public.is_admin(), false)
       or coalesce(public.has_permission('settings.manage'), false)
       or coalesce(public.has_permission('notifications.manage'), false)
     ) then
    raise exception 'admin_export_notification_bundle: settings.manage or notifications.manage required'
      using errcode = '42501';
  end if;

  -- The field list is intentionally explicit. It contains only transport configuration;
  -- row ids, secret-version metadata, test diagnostics, and credential storage are omitted.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'slug', transport.slug,
               'provider_type', transport.provider_type,
               'host', transport.host,
               'port', transport.port,
               'username', transport.username,
               'sender_email', transport.sender_email,
               'sender_name', transport.sender_name,
               'reply_to_email', transport.reply_to_email,
               'tls_mode', transport.tls_mode,
               'auth_mode', transport.auth_mode,
               'is_enabled', transport.is_enabled,
               'is_default', transport.is_default,
               'max_recipients_per_message', transport.max_recipients_per_message,
               'daily_quota', transport.daily_quota,
               'throttle_per_minute', transport.throttle_per_minute,
               'timeout_ms', transport.timeout_ms,
               'retry_max_attempts', transport.retry_max_attempts,
               'retry_backoff_ms', transport.retry_backoff_ms,
               'config', case
                 when transport.config ? 'headers' then
                   jsonb_build_object(
                     'headers', coalesce(
                       (
                         select jsonb_object_agg(header.key, header.value order by header.key)
                           from jsonb_each(transport.config -> 'headers') as header(key, value)
                          where header.key !~* '(secret|password|passwd|ciphertext|token|api[_-]?key|authorization|cookie)'
                       ),
                       '{}'::jsonb
                     )
                   )
                 else '{}'::jsonb
               end
             )
             order by transport.slug
           ),
           '[]'::jsonb
         )
    into v_transports
    from public.notification_transports as transport;

  -- Only active and draft versions are portable (§2.10). Project template fields explicitly,
  -- omit database/audit ids, and retain is_system. The nested JSON projections also discard
  -- unknown or credential-shaped property names from historical/custom JSON values.
  with safe_templates as (
    select template.key,
           template.channel,
           template.locale,
           template.version,
           template.status,
           template.is_current,
           template.subject,
           template.body_text,
           template.body_html,
           template.layout_key,
           template.direction,
           template.sample_variables,
           template.requires_tokens,
           template.is_system,
           template.notes,
           (
             select coalesce(
                      jsonb_agg(
                        jsonb_strip_nulls(
                          jsonb_build_object(
                            'name', variable.value ->> 'name',
                            'type', case
                              when jsonb_typeof(variable.value -> 'type') = 'string'
                                then variable.value -> 'type'
                            end,
                            'required', case
                              when jsonb_typeof(variable.value -> 'required') = 'boolean'
                                then variable.value -> 'required'
                            end,
                            'max_length', case
                              when jsonb_typeof(variable.value -> 'max_length') in ('number', 'string')
                                then variable.value -> 'max_length'
                            end,
                            'requires_token', case
                              when jsonb_typeof(variable.value -> 'requires_token') = 'boolean'
                                then variable.value -> 'requires_token'
                            end,
                            'allowed_hosts', case
                              when jsonb_typeof(variable.value -> 'allowed_hosts') = 'array' then (
                                select coalesce(jsonb_agg(host.value order by host.ordinality), '[]'::jsonb)
                                  from jsonb_array_elements(variable.value -> 'allowed_hosts')
                                         with ordinality as host(value, ordinality)
                                 where jsonb_typeof(host.value) = 'string'
                              )
                            end,
                            'source', case
                              when jsonb_typeof(variable.value -> 'source') = 'string'
                                then variable.value -> 'source'
                            end
                          )
                        )
                        order by variable.ordinality
                      ),
                      '[]'::jsonb
                    )
               from jsonb_array_elements(template.variables)
                      with ordinality as variable(value, ordinality)
              where jsonb_typeof(variable.value) = 'object'
                and coalesce(variable.value ->> 'name', '')
                    !~* '(secret|password|passwd|ciphertext|token|api[_-]?key)'
           ) as safe_variables
      from public.notification_templates as template
     where template.status in ('active', 'draft')
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'key', template.key,
               'channel', template.channel,
               'locale', template.locale,
               'version', template.version,
               'status', template.status,
               'is_current', template.is_current,
               'subject', template.subject,
               'body_text', template.body_text,
               'body_html', template.body_html,
               'layout_key', template.layout_key,
               'direction', template.direction,
               'variables', template.safe_variables,
               'sample_variables', (
                 select coalesce(
                          jsonb_object_agg(sample.key, sample.value order by sample.key),
                          '{}'::jsonb
                        )
                   from jsonb_each(template.sample_variables) as sample(key, value)
                  where jsonb_typeof(sample.value) = 'string'
                    and sample.key !~* '(secret|password|passwd|ciphertext|token|api[_-]?key)'
                    and exists (
                      select 1
                        from jsonb_array_elements(template.safe_variables) as safe_variable(value)
                       where safe_variable.value ->> 'name' = sample.key
                    )
               ),
               'requires_tokens', template.requires_tokens,
               'content_hash', public.notification_template_content_hash(
                 template.subject,
                 template.body_text,
                 template.body_html,
                 template.safe_variables
               ),
               'is_system', template.is_system,
               'notes', template.notes
             )
             order by template.key, template.locale, template.version
           ),
           '[]'::jsonb
         )
    into v_templates
    from safe_templates as template;

  return jsonb_build_object(
    'version', '1.0',
    'transports', v_transports,
    'templates', v_templates
  );
end;
$$;

revoke all on function public.admin_export_notification_bundle()
  from public, anon, service_role;
grant execute on function public.admin_export_notification_bundle()
  to authenticated;

comment on function public.admin_export_notification_bundle() is
  'Exports a non-secret notification bundle per study D12 / §2.10; explicit fields only, no original ids or credential storage.';

-- ---------------------------------------------------------------------------
-- 2) Import without overwriting local templates or enabling unconfigured carriers
--    (study D12 / §2.10; seed-conflict contract from §2.9)
-- ---------------------------------------------------------------------------
create or replace function public.admin_import_notification_bundle(p_bundle jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_transport_payload jsonb;
  v_template_payload jsonb;
  v_transport jsonb;
  v_template jsonb;
  v_transport_config jsonb;
  v_template_variables_input jsonb;
  v_template_variables jsonb;
  v_sample_variables_input jsonb;
  v_sample_variables jsonb;
  v_slug_base text;
  v_slug text;
  v_slug_suffix text;
  v_slug_attempt integer;
  v_transport_id uuid;
  v_provider_type text;
  v_host text;
  v_sender_email text;
  v_sender_name text;
  v_port integer;
  v_max_recipients integer;
  v_daily_quota integer;
  v_throttle_per_minute integer;
  v_timeout_ms integer;
  v_retry_max_attempts integer;
  v_retry_backoff_ms integer;
  v_port_text text;
  v_max_recipients_text text;
  v_daily_quota_text text;
  v_throttle_text text;
  v_timeout_text text;
  v_retry_max_attempts_text text;
  v_retry_backoff_text text;
  v_template_key text;
  v_template_locale text;
  v_template_channel text;
  v_template_status text;
  v_template_version integer;
  v_template_version_text text;
  v_template_subject text;
  v_template_body_text text;
  v_template_body_html text;
  v_template_layout_key text;
  v_template_direction text;
  v_template_notes text;
  v_requires_tokens boolean;
  v_is_current boolean;
  v_is_system boolean;
  v_validation jsonb;
  v_imported_transports integer := 0;
  v_imported_templates integer := 0;
  v_skipped_templates integer := 0;
  v_inserted_rows integer;
begin
  if v_actor is null
     or not coalesce(public.is_active_user(), false)
     or not (
       coalesce(public.is_admin(), false)
       or coalesce(public.has_permission('settings.manage'), false)
     ) then
    raise exception 'admin_import_notification_bundle: settings.manage required'
      using errcode = '42501';
  end if;

  if p_bundle is null
     or jsonb_typeof(p_bundle) <> 'object'
     or (p_bundle ->> 'version') is distinct from '1.0' then
    raise exception 'admin_import_notification_bundle: invalid bundle'
      using errcode = '22023';
  end if;
  if (p_bundle ? 'transports' and jsonb_typeof(p_bundle -> 'transports') <> 'array')
     or (p_bundle ? 'templates' and jsonb_typeof(p_bundle -> 'templates') <> 'array') then
    raise exception 'admin_import_notification_bundle: invalid bundle'
      using errcode = '22023';
  end if;

  v_transport_payload := coalesce(p_bundle -> 'transports', '[]'::jsonb);
  v_template_payload := coalesce(p_bundle -> 'templates', '[]'::jsonb);

  -- Transport rows are rebuilt from a field whitelist. Unrecognized root properties (including
  -- attempts to smuggle credential fields) are never read. The database config whitelist remains
  -- authoritative for the one supported, non-secret provider extension slot.
  for v_transport in
    select item.value
      from jsonb_array_elements(v_transport_payload)
             with ordinality as item(value, ordinality)
     order by item.ordinality
  loop
    if jsonb_typeof(v_transport) <> 'object' then
      raise exception 'admin_import_notification_bundle: invalid bundle'
        using errcode = '22023';
    end if;

    v_slug_base := v_transport ->> 'slug';
    v_host := v_transport ->> 'host';
    v_sender_email := v_transport ->> 'sender_email';
    v_sender_name := v_transport ->> 'sender_name';
    if v_slug_base is null
       or char_length(v_slug_base) not between 2 and 41
       or v_slug_base !~ '^[a-z][a-z0-9_-]{1,40}$'
       or nullif(v_host, '') is null
       or nullif(v_sender_email, '') is null
       or nullif(v_sender_name, '') is null then
      raise exception 'admin_import_notification_bundle: invalid bundle'
        using errcode = '22023';
    end if;

    v_port_text := coalesce(v_transport ->> 'port', '587');
    v_max_recipients_text := coalesce(v_transport ->> 'max_recipients_per_message', '50');
    v_daily_quota_text := coalesce(v_transport ->> 'daily_quota', '200');
    v_throttle_text := coalesce(v_transport ->> 'throttle_per_minute', '30');
    v_timeout_text := coalesce(v_transport ->> 'timeout_ms', '10000');
    v_retry_max_attempts_text := coalesce(v_transport ->> 'retry_max_attempts', '3');
    v_retry_backoff_text := coalesce(v_transport ->> 'retry_backoff_ms', '5000');
    if v_port_text !~ '^[0-9]{1,5}$'
       or v_max_recipients_text !~ '^[0-9]{1,4}$'
       or v_daily_quota_text !~ '^[0-9]{1,6}$'
       or v_throttle_text !~ '^[0-9]{1,5}$'
       or v_timeout_text !~ '^[0-9]{1,6}$'
       or v_retry_max_attempts_text !~ '^[0-9]{1,2}$'
       or v_retry_backoff_text !~ '^[0-9]{1,7}$' then
      raise exception 'admin_import_notification_bundle: invalid bundle'
        using errcode = '22023';
    end if;
    v_port := v_port_text::integer;
    v_max_recipients := v_max_recipients_text::integer;
    v_daily_quota := v_daily_quota_text::integer;
    v_throttle_per_minute := v_throttle_text::integer;
    v_timeout_ms := v_timeout_text::integer;
    v_retry_max_attempts := v_retry_max_attempts_text::integer;
    v_retry_backoff_ms := v_retry_backoff_text::integer;

    if v_transport ? 'config'
       and jsonb_typeof(v_transport -> 'config') <> 'object' then
      raise exception 'admin_import_notification_bundle: invalid bundle'
        using errcode = '22023';
    end if;

    -- Keep only permitted, non-credential-looking header names. Unknown config fields and
    -- credential-shaped header labels are ignored rather than copied into the new transport.
    v_transport_config := '{}'::jsonb;
    if jsonb_typeof(v_transport -> 'config' -> 'headers') = 'object' then
      select jsonb_build_object(
               'headers',
               coalesce(
                 jsonb_object_agg(header.key, header.value order by header.key),
                 '{}'::jsonb
               )
             )
        into v_transport_config
        from jsonb_each(v_transport -> 'config' -> 'headers') as header(key, value)
       where header.key !~* '(secret|password|passwd|ciphertext|token|api[_-]?key|authorization|cookie)';
    end if;
    if not public.notification_transport_config_is_valid(v_transport_config) then
      raise exception 'admin_import_notification_bundle: invalid bundle'
        using errcode = '22023';
    end if;

    v_provider_type := coalesce(nullif(v_transport ->> 'provider_type', ''), 'smtp_generic');
    v_slug := v_slug_base;
    v_slug_attempt := 0;
    loop
      v_transport_id := null;
      insert into public.notification_transports (
        slug,
        provider_type,
        host,
        port,
        username,
        sender_email,
        sender_name,
        reply_to_email,
        tls_mode,
        auth_mode,
        is_enabled,
        is_default,
        max_recipients_per_message,
        daily_quota,
        throttle_per_minute,
        timeout_ms,
        retry_max_attempts,
        retry_backoff_ms,
        config,
        created_by,
        updated_by
      )
      values (
        v_slug,
        v_provider_type,
        v_host,
        v_port,
        v_transport ->> 'username',
        v_sender_email,
        v_sender_name,
        v_transport ->> 'reply_to_email',
        coalesce(nullif(v_transport ->> 'tls_mode', ''), 'starttls'),
        coalesce(nullif(v_transport ->> 'auth_mode', ''), 'login'),
        false,
        false,
        v_max_recipients,
        v_daily_quota,
        v_throttle_per_minute,
        v_timeout_ms,
        v_retry_max_attempts,
        v_retry_backoff_ms,
        v_transport_config,
        v_actor,
        v_actor
      )
      on conflict (slug) do nothing
      returning id into v_transport_id;

      exit when v_transport_id is not null;
      v_slug_attempt := v_slug_attempt + 1;
      v_slug_suffix := '-import-' || v_slug_attempt::text;
      v_slug := left(v_slug_base, 41 - char_length(v_slug_suffix)) || v_slug_suffix;
    end loop;
    v_imported_transports := v_imported_transports + 1;
  end loop;

  -- Templates are insert-only. Exact key/locale/version collisions (including a locally edited
  -- active version) are intentionally no-ops. A different local draft for the same key/locale
  -- also wins over the imported draft, and an existing current active row stays current.
  for v_template in
    select item.value
      from jsonb_array_elements(v_template_payload)
             with ordinality as item(value, ordinality)
     order by item.ordinality
  loop
    if jsonb_typeof(v_template) <> 'object' then
      raise exception 'admin_import_notification_bundle: invalid bundle'
        using errcode = '22023';
    end if;

    v_template_key := v_template ->> 'key';
    v_template_locale := v_template ->> 'locale';
    v_template_channel := v_template ->> 'channel';
    v_template_status := v_template ->> 'status';
    v_template_version_text := v_template ->> 'version';
    v_template_subject := v_template ->> 'subject';
    v_template_body_text := v_template ->> 'body_text';
    v_template_body_html := v_template ->> 'body_html';
    v_template_layout_key := v_template ->> 'layout_key';
    v_template_direction := v_template ->> 'direction';
    v_template_notes := v_template ->> 'notes';
    if v_template_key is null
       or v_template_key !~ '^[a-z][a-z0-9_]*([.][a-z][a-z0-9_]*){1,3}$'
       or v_template_locale is null
       or v_template_locale not in ('ar', 'en')
       or v_template_channel is null
       or v_template_channel not in ('email', 'in_app', 'sms', 'webhook')
       or v_template_status is null
       or v_template_status not in ('active', 'draft')
       or v_template_version_text is null
       or v_template_version_text !~ '^[1-9][0-9]{0,8}$'
       or nullif(btrim(v_template_subject), '') is null
       or v_template_direction is null
       or v_template_direction not in ('rtl', 'ltr')
       or (v_template_channel = 'email' and nullif(btrim(v_template_body_text), '') is null) then
      raise exception 'admin_import_notification_bundle: invalid bundle'
        using errcode = '22023';
    end if;
    v_template_version := v_template_version_text::integer;

    if jsonb_typeof(coalesce(v_template -> 'variables', '[]'::jsonb)) <> 'array'
       or jsonb_typeof(coalesce(v_template -> 'sample_variables', '{}'::jsonb)) <> 'object'
       or (v_template ? 'requires_tokens'
           and jsonb_typeof(v_template -> 'requires_tokens') <> 'boolean')
       or (v_template ? 'is_system'
           and jsonb_typeof(v_template -> 'is_system') <> 'boolean')
       or (v_template ? 'is_current'
           and jsonb_typeof(v_template -> 'is_current') <> 'boolean') then
      raise exception 'admin_import_notification_bundle: invalid bundle'
        using errcode = '22023';
    end if;

    v_template_variables_input := coalesce(v_template -> 'variables', '[]'::jsonb);
    v_sample_variables_input := coalesce(v_template -> 'sample_variables', '{}'::jsonb);
    if exists (
      select 1
        from jsonb_array_elements(v_template_variables_input) as candidate(value)
       where jsonb_typeof(candidate.value) <> 'object'
    ) then
      raise exception 'admin_import_notification_bundle: invalid bundle'
        using errcode = '22023';
    end if;

    -- Import only documented variable properties. Extra user-supplied keys are never copied,
    -- and sensitive variable names are omitted along with their preview values.
    select coalesce(
             jsonb_agg(
               jsonb_strip_nulls(
                 jsonb_build_object(
                   'name', candidate.value ->> 'name',
                   'type', case
                     when jsonb_typeof(candidate.value -> 'type') = 'string'
                       then candidate.value -> 'type'
                   end,
                   'required', case
                     when jsonb_typeof(candidate.value -> 'required') = 'boolean'
                       then candidate.value -> 'required'
                   end,
                   'max_length', case
                     when jsonb_typeof(candidate.value -> 'max_length') in ('number', 'string')
                       then candidate.value -> 'max_length'
                   end,
                   'requires_token', case
                     when jsonb_typeof(candidate.value -> 'requires_token') = 'boolean'
                       then candidate.value -> 'requires_token'
                   end,
                   'allowed_hosts', case
                     when jsonb_typeof(candidate.value -> 'allowed_hosts') = 'array' then (
                       select coalesce(jsonb_agg(host.value order by host.ordinality), '[]'::jsonb)
                         from jsonb_array_elements(candidate.value -> 'allowed_hosts')
                                with ordinality as host(value, ordinality)
                        where jsonb_typeof(host.value) = 'string'
                     )
                   end,
                   'source', case
                     when jsonb_typeof(candidate.value -> 'source') = 'string'
                       then candidate.value -> 'source'
                   end
                 )
               )
               order by candidate.ordinality
             ),
             '[]'::jsonb
           )
      into v_template_variables
      from jsonb_array_elements(v_template_variables_input)
             with ordinality as candidate(value, ordinality)
     where coalesce(candidate.value ->> 'name', '')
           !~* '(secret|password|passwd|ciphertext|token|api[_-]?key)';

    select coalesce(
             jsonb_object_agg(sample.key, sample.value order by sample.key),
             '{}'::jsonb
           )
      into v_sample_variables
      from jsonb_each(v_sample_variables_input) as sample(key, value)
     where jsonb_typeof(sample.value) = 'string'
       and sample.key !~* '(secret|password|passwd|ciphertext|token|api[_-]?key)'
       and exists (
         select 1
           from jsonb_array_elements(v_template_variables) as safe_variable(value)
          where safe_variable.value ->> 'name' = sample.key
       );

    v_requires_tokens := coalesce((v_template ->> 'requires_tokens')::boolean, false);
    v_is_system := coalesce((v_template ->> 'is_system')::boolean, false);
    v_validation := public.notification_template_validate(
      v_template_subject,
      v_template_body_text,
      v_template_body_html,
      v_template_variables,
      v_requires_tokens
    );
    if not coalesce((v_validation ->> 'ok')::boolean, false) then
      raise exception 'admin_import_notification_bundle: invalid bundle'
        using errcode = '22023';
    end if;
    v_validation := public.notification_template_prepare_values(
      v_template_variables,
      v_sample_variables
    );
    if not coalesce((v_validation ->> 'ok')::boolean, false) then
      raise exception 'admin_import_notification_bundle: invalid bundle'
        using errcode = '22023';
    end if;

    -- Prefer existing customer content on an exact version collision. For a different incoming
    -- current version, preserve the local current row and import the upstream row as non-current.
    if exists (
      select 1
        from public.notification_templates as existing
       where existing.key = v_template_key
         and existing.locale = v_template_locale
         and existing.version = v_template_version
    ) then
      v_skipped_templates := v_skipped_templates + 1;
      continue;
    end if;
    if v_template_status = 'draft' and exists (
      select 1
        from public.notification_templates as existing_draft
       where existing_draft.key = v_template_key
         and existing_draft.locale = v_template_locale
         and existing_draft.status = 'draft'
    ) then
      v_skipped_templates := v_skipped_templates + 1;
      continue;
    end if;

    v_is_current := v_template_status = 'active'
                    and coalesce((v_template ->> 'is_current')::boolean, false)
                    and not exists (
                      select 1
                        from public.notification_templates as current_template
                       where current_template.key = v_template_key
                         and current_template.locale = v_template_locale
                         and current_template.status = 'active'
                         and current_template.is_current
                    );

    begin
      insert into public.notification_templates (
        key,
        channel,
        locale,
        version,
        status,
        is_current,
        subject,
        body_text,
        body_html,
        layout_key,
        direction,
        variables,
        sample_variables,
        requires_tokens,
        content_hash,
        is_system,
        notes,
        created_by,
        updated_by
      )
      values (
        v_template_key,
        v_template_channel,
        v_template_locale,
        v_template_version,
        v_template_status,
        v_is_current,
        v_template_subject,
        v_template_body_text,
        v_template_body_html,
        v_template_layout_key,
        v_template_direction,
        v_template_variables,
        v_sample_variables,
        v_requires_tokens,
        public.notification_template_content_hash(
          v_template_subject,
          v_template_body_text,
          v_template_body_html,
          v_template_variables
        ),
        v_is_system,
        v_template_notes,
        v_actor,
        v_actor
      )
      on conflict (key, locale, version) do nothing;
      get diagnostics v_inserted_rows = row_count;
    exception
      -- Also treat races against the one-draft/current partial unique indexes as a safe no-op.
      when unique_violation then
        v_inserted_rows := 0;
    end;

    if v_inserted_rows = 1 then
      v_imported_templates := v_imported_templates + 1;
    else
      v_skipped_templates := v_skipped_templates + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'version', '1.0',
    'imported_transports', v_imported_transports,
    'imported_templates', v_imported_templates,
    'skipped_templates', v_skipped_templates
  );
end;
$$;

revoke all on function public.admin_import_notification_bundle(jsonb)
  from public, anon, service_role;
grant execute on function public.admin_import_notification_bundle(jsonb)
  to authenticated;

comment on function public.admin_import_notification_bundle(jsonb) is
  'Imports a notification bundle per study D12 / §2.10. Secret-shaped keys are not projected; transports stay disabled; templates are insert-only with conflict no-op.';
