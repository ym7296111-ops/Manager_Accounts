-- Notification templates (Phase 2 of the Notifications / SMTP screen).
--
-- Source of truth: docs/consultations/2026-10-02-notifications-smtp-templates-design-study.md
--   * §2.1    public.notification_templates — one row per (key · locale · version);
--             bilingual by ROWS, immutable once active, draft → active → archived.
--   * §2.1.2  Immutability guard: an active row can never be edited in place; the
--             only way forward is a new draft version (or a rollback flip).
--   * §2.3    Whitelisted variables + reserved names (TPL05) + typed values (TPL02).
--   * §2.4    Single-pass tokenizer: strict {{snake_case}} only, no nesting, no
--             expressions, fail-closed on anything else, contextual escaping.
--   * §2.5    HTML allowlist, refusal (not silent cleaning) with names only (TPL04).
--   * §2.7    RPC contracts: upsert draft / publish / rollback / delete draft / render.
--   * §3.4    Value-free errors. Labels map to SQLSTATE: TPL01..TPL05 are already
--             five characters, so they are raised verbatim.
--   * §3.5    Audit values appended at the tail of public.audit_action.
--
-- Two deliberate, documented decisions:
--
--   1. `admin_render_notification` is STABLE and writes nothing (§2.4 idempotency:
--      "render is a read function; calling it 1000 times yields one fingerprint").
--      The preview audit row required by §3.5 therefore lives in the volatile
--      wrapper `admin_preview_notification_template`, which the editor calls.
--      The worker calls render directly with p_mode='delivery'.
--
--   2. Placeholders are NEVER substituted inside HTML attributes (§2.5: "no
--      substitution inside attributes"). A url-typed variable written in a text
--      position is rendered by the engine as an anchor with escaped attributes,
--      which is exactly how §2.3 prescribes url output.
--
-- pgcrypto schema (CI finding): Supabase installs pgcrypto into the dedicated
-- `extensions` schema, which is deliberately NOT on the migration search_path,
-- so an unqualified `digest()` fails at CREATE time with
-- `42883 function digest(text, unknown) does not exist`. Every pgcrypto call in
-- this migration is schema-qualified as `extensions.digest(...)`.

-- ---------------------------------------------------------------------------
-- 1) Audit enum values (tail only)
-- ---------------------------------------------------------------------------
alter type public.audit_action add value if not exists 'notification.template_updated';
alter type public.audit_action add value if not exists 'notification.template_previewed';

-- ---------------------------------------------------------------------------
-- 2) Tokenizer / validator helpers (pure, internal)
-- ---------------------------------------------------------------------------
-- Every helper below is IMMUTABLE or STABLE, has no permission gate of its own,
-- and is therefore revoked from every API role: they are only reachable from the
-- SECURITY DEFINER RPCs above them.

-- Canonical content fingerprint of a template version: study §2.1 says
-- sha256(subject ‖ body_text ‖ body_html ‖ variables). jsonb::text is canonical
-- in PostgreSQL, so the same logical variables always hash identically.
create or replace function public.notification_template_content_hash(
  p_subject text,
  p_body_text text,
  p_body_html text,
  p_variables jsonb
)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select encode(
           extensions.digest(
             coalesce(p_subject, '') || E'\n' ||
             coalesce(p_body_text, '') || E'\n' ||
             coalesce(p_body_html, '') || E'\n' ||
             coalesce(p_variables, '[]'::jsonb)::text,
             'sha256'
           ),
           'hex'
         );
$$;

create or replace function public.notification_template_escape_html(p_text text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select replace(
           replace(
             replace(
               replace(replace(coalesce(p_text, ''), '&', '&amp;'), '<', '&lt;'),
               '>', '&gt;'
             ),
             '"', '&quot;'
           ),
           '''', '&#39;'
         );
$$;

-- Reserved variable names (study §2.3.2). A template asking for these is
-- refused with TPL05, because "mail me the SMTP password" must be impossible.
create or replace function public.notification_template_variable_is_reserved(p_name text)
returns boolean
language sql
immutable
set search_path = pg_catalog, public
as $$
  select lower(coalesce(p_name, '')) = any (array[
           'password', 'passwd', 'smtp_password', 'smtp_pass', 'mail_password',
           'token', 'jwt', 'session', 'cookie', 'api_key', 'apikey',
           'service_role', 'service_role_key', 'anon_key', 'database_url',
           'master_key', 'private_key', 'encryption_key'
         ])
      or lower(coalesce(p_name, '')) like 'secret%';
$$;

-- Variables whitelist schema. Returns violation NAMES only — never a value and
-- never a fragment of one, so the caller can raise them verbatim (study §3.4).
create or replace function public.notification_template_variables_violations(p_variables jsonb)
returns text[]
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_allowed_types constant text[] :=
    array['text', 'url', 'email', 'int', 'money', 'datetime', 'bool'];
  v_violations text[] := array[]::text[];
  v_item jsonb;
  v_name text;
  v_type text;
  v_index integer := 0;
  v_seen text[] := array[]::text[];
begin
  if p_variables is null or jsonb_typeof(p_variables) <> 'array' then
    return array['schema:not_array'];
  end if;
  if jsonb_array_length(p_variables) > 40 then
    v_violations := array_append(v_violations, 'schema:too_many');
  end if;

  for v_item in select element from jsonb_array_elements(p_variables) as element loop
    v_index := v_index + 1;
    if jsonb_typeof(v_item) <> 'object' then
      v_violations := v_violations || ('schema:item_' || v_index::text);
      continue;
    end if;

    v_name := v_item ->> 'name';
    if v_name is null or v_name !~ '^[a-z][a-z0-9_]{0,63}$' then
      v_violations := v_violations || ('name:' || coalesce(v_name, v_index::text));
      continue;
    end if;
    if v_name = any (v_seen) then
      v_violations := v_violations || ('duplicate:' || v_name);
    end if;
    v_seen := v_seen || v_name;

    if public.notification_template_variable_is_reserved(v_name) then
      v_violations := v_violations || ('reserved:' || v_name);
    end if;

    v_type := coalesce(v_item ->> 'type', 'text');
    if v_type <> all (v_allowed_types) then
      v_violations := v_violations || ('type:' || v_name);
    end if;
    if v_item ? 'required' and jsonb_typeof(v_item -> 'required') <> 'boolean' then
      v_violations := v_violations || ('required:' || v_name);
    end if;
    if v_item ? 'max_length' and (v_item ->> 'max_length') !~ '^[1-9][0-9]{0,4}$' then
      v_violations := v_violations || ('max_length:' || v_name);
    end if;
    if v_item ? 'requires_token' and jsonb_typeof(v_item -> 'requires_token') <> 'boolean' then
      v_violations := v_violations || ('requires_token:' || v_name);
    end if;
    if v_item ? 'allowed_hosts' and jsonb_typeof(v_item -> 'allowed_hosts') <> 'array' then
      v_violations := v_violations || ('allowed_hosts:' || v_name);
    end if;
  end loop;

  return v_violations;
end;
$$;

-- Fail-closed syntax scan for every construct the tokenizer must never accept
-- (study §2.4 step 2): triple braces, Jinja/Twig/Freemarker blocks, unbalanced
-- or malformed braces. It reports CLASSES, never the offending text.
create or replace function public.notification_template_syntax_problems(p_text text)
returns text[]
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_problems text[] := array[]::text[];
  v_open integer;
  v_close integer;
  v_strict integer;
begin
  if p_text is null or p_text = '' then
    return array[]::text[];
  end if;

  if p_text ~ '\{\{\{' then
    v_problems := array_append(v_problems, 'triple_brace');
  end if;
  if p_text ~ '\{%' or p_text ~ '#\{' or p_text ~ '\{!' then
    v_problems := array_append(v_problems, 'statement_block');
  end if;

  v_open := (char_length(p_text) - char_length(replace(p_text, '{{', ''))) / 2;
  v_close := (char_length(p_text) - char_length(replace(p_text, '}}', ''))) / 2;
  select count(*) into v_strict
    from regexp_matches(p_text, '\{\{[ ]*[a-z][a-z0-9_]{0,63}[ ]*\}\}', 'g');

  if v_open <> v_close then
    v_problems := array_append(v_problems, 'unbalanced_braces');
  end if;
  if v_open <> v_strict or v_close <> v_strict then
    v_problems := array_append(v_problems, 'invalid_token');
  end if;

  return v_problems;
end;
$$;

create or replace function public.notification_template_tokens(p_text text)
returns text[]
language sql
immutable
set search_path = pg_catalog, public
as $$
  select coalesce(array_agg(match[1]), array[]::text[])
    from regexp_matches(coalesce(p_text, ''), '\{\{[ ]*([a-z][a-z0-9_]{0,63})[ ]*\}\}', 'g')
           as match;
$$;

-- Token classification against the declared whitelist: reserved names beat
-- "unknown" so the editor gets TPL05 (reserved) instead of a vague TPL01.
create or replace function public.notification_template_token_problems(
  p_tokens text[],
  p_variables jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_reserved text[] := array[]::text[];
  v_unknown text[] := array[]::text[];
  v_token text;
  v_declared text[];
begin
  select coalesce(array_agg(element ->> 'name'), array[]::text[])
    into v_declared
    from jsonb_array_elements(coalesce(p_variables, '[]'::jsonb)) as element
   where element ? 'name';

  foreach v_token in array coalesce(p_tokens, array[]::text[]) loop
    if public.notification_template_variable_is_reserved(v_token) then
      if not (v_token = any (v_reserved)) then
        v_reserved := v_reserved || v_token;
      end if;
    elsif not (v_token = any (v_declared)) then
      if not (v_token = any (v_unknown)) then
        v_unknown := v_unknown || v_token;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'reserved', to_jsonb(v_reserved),
    'unknown', to_jsonb(v_unknown)
  );
end;
$$;

-- HTML allowlist (study §2.5): refusal, not silent cleaning, and the report
-- carries element names only.
create or replace function public.notification_template_html_violations(p_html text)
returns text[]
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_allowed_tags constant text[] := array[
    'p', 'br', 'strong', 'em', 'b', 'i', 'a', 'ul', 'ol', 'li',
    'table', 'thead', 'tbody', 'tr', 'td', 'th',
    'h1', 'h2', 'h3', 'h4', 'blockquote', 'span', 'hr', 'div', 'img'
  ];
  v_allowed_attrs constant text[] := array[
    'href', 'src', 'alt', 'width', 'height', 'align', 'colspan', 'rowspan',
    'dir', 'style', 'title'
  ];
  v_allowed_css constant text[] := array[
    'color', 'background-color', 'font-size', 'font-weight', 'font-family',
    'text-align', 'direction', 'line-height', 'letter-spacing', 'vertical-align',
    'text-decoration', 'border-radius', 'width', 'height', 'max-width',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
    'border-color', 'border-width', 'border-style'
  ];
  v_violations text[] := array[]::text[];
  v_block text;
  v_tag text;
  v_attr text;
  v_style text;
  v_css text;
begin
  if p_html is null or btrim(p_html) = '' then
    return array[]::text[];
  end if;

  -- Whole-document constructs that are refused regardless of position.
  if p_html ~* '@import' then
    v_violations := array_append(v_violations, 'raw:import');
  end if;
  if p_html ~* 'expression[[:space:]]*\(' or p_html ~* '-moz-binding' then
    v_violations := array_append(v_violations, 'raw:css_expression');
  end if;

  -- Tag-by-tag scan: element names, attributes, and (critically) placeholders
  -- inside attributes, which §2.5 forbids outright.
  for v_block in
    select match[1]
      from regexp_matches(p_html, '(<[^>]*>)', 'g') as match
  loop
    v_tag := lower((regexp_match(v_block, '^<[[:space:]]*/?[[:space:]]*([a-zA-Z][a-zA-Z0-9-]*)'))[1]);
    if v_tag is not null and v_tag <> all (v_allowed_tags) then
      v_violations := v_violations || ('tag:' || v_tag);
    end if;

    if position('{{' in v_block) > 0 or position('}}' in v_block) > 0 then
      v_violations := array_append(v_violations, 'placeholder_in_attribute');
    end if;

    for v_attr in
      select distinct lower(match[1])
        from regexp_matches(v_block, '[[:space:]]([a-zA-Z][a-zA-Z0-9-]*)[[:space:]]*=', 'g') as match
    loop
      if v_attr ~ '^on' then
        v_violations := v_violations || ('attr:' || v_attr);
      elsif v_attr <> all (v_allowed_attrs) then
        v_violations := v_violations || ('attr:' || v_attr);
      end if;
    end loop;

    if v_block ~* '(href|src)[[:space:]]*=[[:space:]]*[''"][[:space:]]*(javascript|vbscript|data|file|blob):' then
      v_violations := array_append(v_violations, 'scheme:unsafe');
    end if;

    v_style := coalesce(
      (regexp_match(v_block, '[[:space:]]style[[:space:]]*=[[:space:]]*"([^"]*)"'))[1],
      (regexp_match(v_block, '[[:space:]]style[[:space:]]*=[[:space:]]*''([^'']*)'''))[1]
    );
    if v_style is not null then
      if v_style ~* 'url[[:space:]]*\(' or v_style ~* 'expression' or v_style ~* '@import' then
        v_violations := array_append(v_violations, 'css:unsafe');
      end if;
      for v_css in
        select distinct lower(match[1])
          from regexp_matches(v_style, '([a-zA-Z-]+)[[:space:]]*:', 'g') as match
      loop
        if v_css <> all (v_allowed_css) then
          v_violations := v_violations || ('css:' || v_css);
        end if;
      end loop;
    end if;
  end loop;

  -- De-duplicate while keeping the report short and stable.
  return coalesce(
    (select array_agg(distinct element order by element) from unnest(v_violations) as element),
    array[]::text[]
  );
end;
$$;

-- Value validation for a declared variable whitelist (study §2.3 table plus the
-- §2.3 hard rules: unknown names, missing required, per-type checks, brace
-- injection, length caps, https-only urls).
create or replace function public.notification_template_prepare_values(
  p_variables jsonb,
  p_values jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_values jsonb := coalesce(p_values, '{}'::jsonb);
  v_ok jsonb := '{}'::jsonb;
  v_missing text[] := array[]::text[];
  v_invalid text[] := array[]::text[];
  v_unknown text[] := array[]::text[];
  v_item jsonb;
  v_name text;
  v_type text;
  v_required boolean;
  v_max integer;
  v_raw jsonb;
  v_text text;
  v_host text;
begin
  if p_variables is null or jsonb_typeof(p_variables) <> 'array' then
    return jsonb_build_object('ok', false, 'shape', 'variables');
  end if;
  if jsonb_typeof(v_values) <> 'object' then
    return jsonb_build_object('ok', false, 'shape', 'values');
  end if;

  select coalesce(array_agg(key), array[]::text[])
    into v_unknown
    from jsonb_object_keys(v_values) as key
   where not exists (
     select 1 from jsonb_array_elements(p_variables) as element
      where element ->> 'name' = key
   );

  for v_item in select element from jsonb_array_elements(p_variables) as element loop
    v_name := v_item ->> 'name';
    v_type := coalesce(v_item ->> 'type', 'text');
    v_required := case when jsonb_typeof(v_item -> 'required') = 'boolean'
                       then (v_item ->> 'required')::boolean else false end;
    v_max := case when (v_item ->> 'max_length') ~ '^[1-9][0-9]{0,4}$'
                  then (v_item ->> 'max_length')::integer else 4096 end;
    v_raw := v_values -> v_name;

    if v_raw is null or v_raw = 'null'::jsonb then
      if v_required then
        v_missing := v_missing || v_name;
      end if;
      continue;
    end if;

    if jsonb_typeof(v_raw) <> 'string' then
      v_invalid := v_invalid || v_name;
      continue;
    end if;
    v_text := v_raw #>> '{}';

    if char_length(v_text) > least(v_max, 40960)
       or v_text ~ '[[:cntrl:]]'
       or position('{{' in v_text) > 0
       or position('}}' in v_text) > 0 then
      v_invalid := v_invalid || v_name;
      continue;
    end if;

    if v_type = 'url' then
      if v_text !~* '^https://[A-Za-z0-9][A-Za-z0-9._-]*(:[0-9]{1,5})?(/[^[:space:]]*)?$' then
        v_invalid := v_invalid || v_name;
        continue;
      end if;
      v_host := lower((regexp_match(v_text, '^https://([^/:]+)'))[1]);
      if v_item ? 'allowed_hosts'
         and jsonb_array_length(coalesce(v_item -> 'allowed_hosts', '[]'::jsonb)) > 0
         and not exists (
           select 1
             from jsonb_array_elements_text(v_item -> 'allowed_hosts') as allowed(host_name)
            where v_host = lower(allowed.host_name)
               or v_host like '%.' || lower(allowed.host_name)
         ) then
        v_invalid := v_invalid || v_name;
        continue;
      end if;
    elsif v_type = 'email' then
      if v_text !~* '^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$' then
        v_invalid := v_invalid || v_name;
        continue;
      end if;
    elsif v_type in ('int', 'money') then
      if v_text !~ '^-?[0-9]{1,18}([.][0-9]{1,6})?$' then
        v_invalid := v_invalid || v_name;
        continue;
      end if;
    elsif v_type = 'datetime' then
      begin
        perform v_text::timestamptz;
      exception
        when others then
          v_invalid := v_invalid || v_name;
          continue;
      end;
    elsif v_type = 'bool' then
      if lower(v_text) not in ('true', 'false') then
        v_invalid := v_invalid || v_name;
        continue;
      end if;
    end if;

    v_ok := v_ok || jsonb_build_object(v_name, v_text);
  end loop;

  return jsonb_build_object(
    'ok', cardinality(v_missing) = 0
          and cardinality(v_invalid) = 0
          and cardinality(v_unknown) = 0
          and jsonb_typeof(v_values) = 'object',
    'missing', to_jsonb(v_missing),
    'invalid', to_jsonb(v_invalid),
    'unknown', to_jsonb(v_unknown),
    'values', v_ok
  );
end;
$$;

-- Single-pass substitution (study §2.4 step 5): the source is split on the
-- strict token pattern and reassembled once. A substituted VALUE is never
-- rescanned, so a value containing "{{other}}" stays inert text forever.
create or replace function public.notification_template_substitute(
  p_text text,
  p_values jsonb,
  p_types jsonb,
  p_html boolean
)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_parts text[];
  v_names text[];
  v_out text := '';
  v_name text;
  v_value text;
  v_type text;
  v_index integer;
begin
  if p_text is null then
    return null;
  end if;

  v_parts := regexp_split_to_array(p_text, '\{\{[ ]*[a-z][a-z0-9_]{0,63}[ ]*\}\}');
  v_names := public.notification_template_tokens(p_text);

  for v_index in 1..coalesce(array_length(v_parts, 1), 1) loop
    v_out := v_out || coalesce(v_parts[v_index], '');
    if v_index <= coalesce(array_length(v_names, 1), 0) then
      v_name := v_names[v_index];
      v_value := coalesce(p_values ->> v_name, '');
      v_type := coalesce(p_types ->> v_name, 'text');

      if not p_html then
        v_out := v_out || v_value;
      elsif v_type = 'url' then
        -- §2.3: url output is an anchor with escaped attributes plus the host
        -- path as visible text. Because the author wrote the placeholder in a
        -- text position, the attribute is generated — never user-authored.
        v_out := v_out || '<a href="' || public.notification_template_escape_html(v_value)
                 || '">' || public.notification_template_escape_html(v_value) || '</a>';
      elsif v_type = 'email' then
        v_out := v_out || '<a href="mailto:'
                 || public.notification_template_escape_html(v_value)
                 || '">' || public.notification_template_escape_html(v_value) || '</a>';
      else
        v_out := v_out || public.notification_template_escape_html(v_value);
      end if;
    end if;
  end loop;

  return v_out;
end;
$$;

-- Shared validation used by both "save a draft" and "publish", so a template
-- that was valid at save time is re-proved at publish time (defense in depth).
create or replace function public.notification_template_validate(
  p_subject text,
  p_body_text text,
  p_body_html text,
  p_variables jsonb,
  p_requires_tokens boolean
)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_problems text[] := array[]::text[];
  v_token_problems jsonb;
  v_reserved text;
  v_unknown text;
  v_variable_violations text[];
  v_html_violations text[];
  v_variables_allow_tokens boolean := false;
begin
  -- variables schema (reserved names surface as TPL05, everything else 22023)
  v_variable_violations := public.notification_template_variables_violations(p_variables);
  if cardinality(v_variable_violations) > 0 then
    select string_agg(element, ',' order by element) into v_reserved
      from unnest(v_variable_violations) as element
     where element like 'reserved:%';
    if v_reserved is not null then
      return jsonb_build_object('ok', false, 'code', 'TPL05', 'names', to_jsonb(v_reserved));
    end if;
    return jsonb_build_object('ok', false, 'code', '22023', 'field', 'variables',
                              'names', to_jsonb(v_variable_violations));
  end if;

  -- fail-closed syntax scan on all three surfaces
  v_problems := public.notification_template_syntax_problems(p_subject)
                || public.notification_template_syntax_problems(p_body_text)
                || public.notification_template_syntax_problems(p_body_html);
  if cardinality(v_problems) > 0 then
    return jsonb_build_object('ok', false, 'code', 'TPL01', 'names', to_jsonb(v_problems));
  end if;

  -- tokens must exist in the declared whitelist; reserved names are TPL05
  v_token_problems := public.notification_template_token_problems(
    public.notification_template_tokens(p_subject)
      || public.notification_template_tokens(p_body_text)
      || public.notification_template_tokens(p_body_html),
    p_variables
  );
  if jsonb_array_length(v_token_problems -> 'reserved') > 0 then
    return jsonb_build_object('ok', false, 'code', 'TPL05',
                              'names', v_token_problems -> 'reserved');
  end if;
  if jsonb_array_length(v_token_problems -> 'unknown') > 0 then
    return jsonb_build_object('ok', false, 'code', 'TPL01',
                              'names', v_token_problems -> 'unknown');
  end if;

  -- HTML allowlist
  v_html_violations := public.notification_template_html_violations(p_body_html);
  if cardinality(v_html_violations) > 0 then
    return jsonb_build_object('ok', false, 'code', 'TPL04', 'names', to_jsonb(v_html_violations));
  end if;

  -- requires_tokens must be true whenever a declared variable carries a token
  select exists (
    select 1 from jsonb_array_elements(p_variables) as element
     where jsonb_typeof(element -> 'requires_token') = 'boolean'
       and (element ->> 'requires_token')::boolean
  ) into v_variables_allow_tokens;
  if v_variables_allow_tokens and not coalesce(p_requires_tokens, false) then
    return jsonb_build_object('ok', false, 'code', '22023', 'field', 'requires_tokens',
                              'names', to_jsonb(array['requires_tokens'::text]));
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- Every helper is internal: no API role may call it directly.
do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.notification_template_content_hash(text,text,text,jsonb)',
    'public.notification_template_escape_html(text)',
    'public.notification_template_variable_is_reserved(text)',
    'public.notification_template_variables_violations(jsonb)',
    'public.notification_template_syntax_problems(text)',
    'public.notification_template_tokens(text)',
    'public.notification_template_token_problems(text[],jsonb)',
    'public.notification_template_html_violations(text)',
    'public.notification_template_prepare_values(jsonb,jsonb)',
    'public.notification_template_substitute(text,jsonb,jsonb,boolean)',
    'public.notification_template_validate(text,text,text,jsonb,boolean)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role',
                   v_signature);
  end loop;
end;
$$;

comment on function public.notification_template_validate(text, text, text, jsonb, boolean) is
  'Fail-closed template validation shared by save-draft and publish. Returns {ok, code, names} where names are element names only — never content (study §3.4).';

-- ---------------------------------------------------------------------------
-- 3) Templates table
-- ---------------------------------------------------------------------------
create table if not exists public.notification_templates (
  id uuid primary key default gen_random_uuid(),
  -- System event identifier (study §2.1): scope.event, extensible without a
  -- migration per new event.
  key text not null
    check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$'),
  channel text not null default 'email'
    check (channel in ('email', 'in_app', 'sms', 'webhook')),
  locale text not null
    check (locale in ('ar', 'en')),
  version integer not null check (version >= 1),
  status text not null default 'draft'
    check (status in ('draft', 'active', 'archived')),
  is_current boolean not null default false,
  subject text not null
    check (
      char_length(btrim(subject)) between 1 and 200
      and subject !~ '[[:cntrl:]]'
      and subject !~ '<'
    ),
  -- Plain-text alternative is mandatory for email and is the last line of
  -- defense when a client refuses HTML.
  body_text text
    check (
      body_text is null
      or (
        char_length(body_text) between 1 and 40960
        and replace(replace(replace(body_text, chr(9), ''), chr(10), ''), chr(13), '')
            !~ '[[:cntrl:]]'
      )
    ),
  body_html text
    check (
      -- PostgreSQL text cannot store a NUL byte at all, so only the size cap
      -- matters here.
      body_html is null
      or octet_length(body_html) <= 65536
    ),
  layout_key text
    check (layout_key is null or layout_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  direction text not null default 'rtl'
    check (direction in ('rtl', 'ltr')),
  -- Whitelist of allowed variables: [{name,type,required,max_length,...}].
  variables jsonb not null default '[]'::jsonb
    check (jsonb_typeof(variables) = 'array'),
  -- Masked demo data for the live preview: keeps real PII out of the editor.
  sample_variables jsonb not null default '{}'::jsonb
    check (jsonb_typeof(sample_variables) = 'object'),
  requires_tokens boolean not null default false,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  -- System seeds can be forked by a client without losing upstream updates.
  is_system boolean not null default false,
  notes text
    check (
      notes is null
      or (
        char_length(notes) <= 500
        and replace(replace(replace(notes, chr(9), ''), chr(10), ''), chr(13), '')
            !~ '[[:cntrl:]]'
      )
    ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.profiles (id) on delete set null,
  updated_by uuid references public.profiles (id) on delete set null,
  constraint notification_templates_version_unique unique (key, locale, version),
  constraint notification_templates_email_body_required
    check (channel <> 'email' or body_text is not null),
  -- is_current is a property of exactly one ACTIVE row per (key, locale).
  constraint notification_templates_current_is_active
    check (not is_current or status = 'active')
);

create unique index if not exists notification_templates_active_current_idx
  on public.notification_templates (key, locale)
  where status = 'active' and is_current;

-- Exactly one open draft per (key, locale): "edit" is unambiguous.
create unique index if not exists notification_templates_single_draft_idx
  on public.notification_templates (key, locale)
  where status = 'draft';

create index if not exists notification_templates_lookup_idx
  on public.notification_templates (key, locale, version desc);

drop trigger if exists notification_templates_set_updated_at on public.notification_templates;
create trigger notification_templates_set_updated_at
  before update on public.notification_templates
  for each row execute function public.set_updated_at();

comment on table public.notification_templates is
  'Message templates (Phase 2). One row per (key · locale · version), bilingual by rows. Active rows are immutable: editing means creating a new draft version, publishing is atomic, and rollback flips is_current (study §2.1.2).';
comment on column public.notification_templates.key is
  'System event identifier (scope.event). Never a free-form label: routing keys are addressed by value.';
comment on column public.notification_templates.is_current is
  'Exactly one active version per (key, locale) carries this flag; a partial unique index enforces it.';
comment on column public.notification_templates.content_hash is
  'sha256(subject ‖ body_text ‖ body_html ‖ variables). The preview hash is the delivery hash — the two-path contract is proven by the audit mirror.';
comment on column public.notification_templates.sample_variables is
  'Masked demo values used by the live preview only. Real recipient data never enters the editor.';
comment on column public.notification_templates.requires_tokens is
  'True when a variable carries a signed, short-lived token (action_url). Enforced against the variables schema at save and publish time.';

-- ---------------------------------------------------------------------------
-- 4) Immutability guard (study §2.1.2)
-- ---------------------------------------------------------------------------
-- The migration seeds active rows directly, so a bootstrap flag is honored —
-- and only the migration sets it. Every other writer, including service_role,
-- faces the same rules as the RPCs.
create or replace function public.guard_notification_template_writes()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_bootstrap boolean :=
    coalesce(current_setting('app.notification_template_bootstrap', true), '') = 'on';
begin
  if v_bootstrap then
    return coalesce(new, old);
  end if;

  if tg_op = 'INSERT' then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    -- Published content is frozen: subject/body/variables/hash/version/key/
    -- locale/channel may never change on an active row. Status flips
    -- (active → archived) and is_current flips (rollback) remain legal.
    if old.status = 'active' and (
         new.subject is distinct from old.subject
      or new.body_text is distinct from old.body_text
      or new.body_html is distinct from old.body_html
      or new.variables is distinct from old.variables
      or new.sample_variables is distinct from old.sample_variables
      or new.content_hash is distinct from old.content_hash
      or new.version is distinct from old.version
      or new.key is distinct from old.key
      or new.locale is distinct from old.locale
      or new.channel is distinct from old.channel
    ) then
      raise exception 'immutable_template'
        using errcode = '22023', detail = 'field: status',
              hint = 'active templates are immutable; create a new draft version';
    end if;

    -- Archived versions are frozen history too (rollback reads them).
    if old.status = 'archived' and (
         new.subject is distinct from old.subject
      or new.body_text is distinct from old.body_text
      or new.body_html is distinct from old.body_html
      or new.variables is distinct from old.variables
      or new.content_hash is distinct from old.content_hash
      or new.version is distinct from old.version
    ) then
      raise exception 'immutable_template'
        using errcode = '22023', detail = 'field: status',
              hint = 'archived templates are read-only';
    end if;

    return new;
  end if;

  -- DELETE
  if old.status <> 'draft' then
    raise exception 'draft_only_delete'
      using errcode = '22023', detail = 'field: status',
            hint = 'published template versions are never deleted';
  end if;
  return old;
end;
$$;

revoke all on function public.guard_notification_template_writes()
  from public, anon, authenticated, service_role;

drop trigger if exists notification_templates_guard_writes on public.notification_templates;
create trigger notification_templates_guard_writes
  before insert or update or delete on public.notification_templates
  for each row execute function public.guard_notification_template_writes();

-- ---------------------------------------------------------------------------
-- 5) RLS + grants (study §3.2, policies P1..P10)
-- ---------------------------------------------------------------------------
create or replace function public.can_manage_notification_templates()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select coalesce(public.is_active_user(), false)
     and (
       coalesce(public.is_admin(), false)
       or coalesce(public.has_permission('notifications.manage'), false)
     );
$$;

revoke all on function public.can_manage_notification_templates() from public, anon;
grant execute on function public.can_manage_notification_templates()
  to authenticated, service_role;

alter table public.notification_templates enable row level security;
alter table public.notification_templates force row level security;

revoke all on table public.notification_templates from public, anon, authenticated, service_role;
-- SELECT is granted to authenticated, but the policy below is the actual fence:
-- no permission ⇒ zero rows; a draft is visible to its author and to admins.
grant select on table public.notification_templates to authenticated, service_role;
grant insert, update, delete on table public.notification_templates to service_role;

drop policy if exists notification_templates_manage_read on public.notification_templates;
create policy notification_templates_manage_read
  on public.notification_templates
  for select
  to authenticated
  using (
    public.can_manage_notification_templates()
    and (
      status <> 'draft'
      or created_by = auth.uid()
      or public.is_admin()
    )
  );

-- Deliberately no INSERT / UPDATE / DELETE policies: the RPCs are the only
-- sanctioned write path (study §3.2 and P3/P9).

-- ---------------------------------------------------------------------------
-- 6) Read RPCs
-- ---------------------------------------------------------------------------
create or replace function public.admin_list_notification_templates(
  p_key text default null,
  p_status text default null,
  p_locale text default null
)
returns setof public.notification_templates
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if auth.uid() is null or not public.can_manage_notification_templates() then
    raise exception 'administrator privileges required' using errcode = '42501';
  end if;

  return query
    select template.*
      from public.notification_templates as template
     where (p_key is null or template.key = p_key)
       and (p_status is null or template.status = p_status)
       and (p_locale is null or template.locale = p_locale)
       and (
         template.status <> 'draft'
         or template.created_by = auth.uid()
         or public.is_admin()
       )
     order by template.key, template.locale, template.version desc;
end;
$$;

revoke all on function public.admin_list_notification_templates(text, text, text)
  from public, anon, service_role;
grant execute on function public.admin_list_notification_templates(text, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 7) Draft write path
-- ---------------------------------------------------------------------------
-- One row per (key, locale) may be a draft (partial unique index). The draft
-- carries version = max(version)+1 of its lineage; editing an existing draft
-- rewrites it in place and is a no-op when the content hash is unchanged.
create or replace function public.admin_upsert_notification_template_draft(
  p_key text,
  p_locale text,
  p_subject text,
  p_body_text text default null,
  p_body_html text default null,
  p_variables jsonb default '[]'::jsonb,
  p_sample_variables jsonb default '{}'::jsonb,
  p_requires_tokens boolean default false,
  p_channel text default 'email',
  p_layout_key text default null,
  p_direction text default null,
  p_notes text default null,
  p_expected_hash text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_validation jsonb;
  v_hash text;
  v_draft public.notification_templates%rowtype;
  v_had_draft boolean := false;
  v_subject text;
  v_body_text text;
  v_body_html text;
  v_direction text;
  v_channel text;
  v_locale text;
  v_key text;
  v_previous_hash text;
  v_prepared jsonb;
begin
  if v_actor is null or not public.can_manage_notification_templates() then
    raise exception 'administrator privileges required' using errcode = '42501';
  end if;

  v_key := nullif(btrim(coalesce(p_key, '')), '');
  if v_key is null or v_key !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,3}$' then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: key';
  end if;

  v_locale := nullif(btrim(coalesce(p_locale, '')), '');
  if v_locale is null or v_locale not in ('ar', 'en') then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: locale';
  end if;

  v_channel := nullif(btrim(coalesce(p_channel, '')), '');
  if v_channel is null or v_channel not in ('email', 'in_app', 'sms', 'webhook') then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: channel';
  end if;

  v_subject := btrim(coalesce(p_subject, ''));
  if char_length(v_subject) not between 1 and 200
     or v_subject ~ '[[:cntrl:]]'
     or position('<' in v_subject) > 0 then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: subject';
  end if;

  v_body_text := p_body_text;
  if v_channel = 'email' and (v_body_text is null or btrim(v_body_text) = '') then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: body_text',
      hint = 'email templates require a plain-text alternative';
  end if;
  if v_body_text is not null and char_length(v_body_text) > 40960 then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: body_text';
  end if;

  v_body_html := nullif(p_body_html, '');
  if v_body_html is not null and octet_length(v_body_html) > 65536 then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: body_html';
  end if;

  if p_layout_key is not null
     and btrim(p_layout_key) <> ''
     and btrim(p_layout_key) !~ '^[a-z][a-z0-9_]{1,63}$' then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: layout_key';
  end if;

  if p_notes is not null and char_length(p_notes) > 500 then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: notes';
  end if;

  v_direction := nullif(btrim(coalesce(p_direction, '')), '');
  if v_direction is null then
    v_direction := case when v_locale = 'ar' then 'rtl' else 'ltr' end;
  elsif v_direction not in ('rtl', 'ltr') then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: direction';
  end if;

  -- Full fail-closed validation of the content before anything is written.
  v_validation := public.notification_template_validate(
    v_subject, v_body_text, v_body_html, p_variables, p_requires_tokens
  );
  if not coalesce((v_validation ->> 'ok')::boolean, false) then
    if v_validation ->> 'code' = 'TPL05' then
      raise exception 'TPL05: reserved_variable_name'
        using errcode = 'TPL05', detail = 'names: ' || coalesce(v_validation ->> 'names', '');
    elsif v_validation ->> 'code' = 'TPL01' then
      raise exception 'TPL01: unknown_or_invalid_token'
        using errcode = 'TPL01', detail = 'names: ' || coalesce(v_validation ->> 'names', '');
    elsif v_validation ->> 'code' = 'TPL04' then
      raise exception 'TPL04: rejected_html'
        using errcode = 'TPL04', detail = 'names: ' || coalesce(v_validation ->> 'names', '');
    else
      raise exception 'invalid_field'
        using errcode = '22023',
              detail = 'field: ' || coalesce(v_validation ->> 'field', 'variables'),
              hint = 'see names';
    end if;
  end if;

  -- Sample data must be complete enough for a truthful preview.
  if jsonb_typeof(coalesce(p_sample_variables, '{}'::jsonb)) <> 'object' then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: sample_variables';
  end if;
  v_prepared := public.notification_template_prepare_values(p_variables, p_sample_variables);
  if jsonb_array_length(coalesce(v_prepared -> 'missing', '[]'::jsonb)) > 0 then
    raise exception 'invalid_field'
      using errcode = '22023', detail = 'field: sample_variables',
            hint = 'sample data must cover every required variable';
  end if;

  v_hash := public.notification_template_content_hash(
    v_subject, v_body_text, v_body_html, p_variables
  );

  select *
    into v_draft
    from public.notification_templates
   where key = v_key
     and locale = v_locale
     and status = 'draft'
   for update;
  v_had_draft := found;

  if v_had_draft then
    if p_expected_hash is not null and p_expected_hash <> v_draft.content_hash then
      raise exception 'invalid_field'
        using errcode = '22023', detail = 'field: expected_hash',
              hint = 'the draft changed since you loaded it';
    end if;

    if v_draft.content_hash = v_hash
       and v_draft.subject = v_subject
       and v_draft.body_text is not distinct from v_body_text
       and v_draft.body_html is not distinct from v_body_html
       and v_draft.variables is not distinct from p_variables
       and v_draft.sample_variables is not distinct from p_sample_variables
       and v_draft.requires_tokens = coalesce(p_requires_tokens, false)
       and v_draft.layout_key is not distinct from nullif(btrim(coalesce(p_layout_key, '')), '')
       and v_draft.direction = v_direction
       and v_draft.notes is not distinct from nullif(btrim(coalesce(p_notes, '')), '') then
      return jsonb_build_object(
        'id', v_draft.id, 'key', v_draft.key, 'locale', v_draft.locale,
        'channel', v_draft.channel, 'version', v_draft.version,
        'status', v_draft.status, 'content_hash', v_draft.content_hash,
        'unchanged', true, 'updated_at', v_draft.updated_at
      );
    end if;

    v_previous_hash := v_draft.content_hash;

    update public.notification_templates
       set subject = v_subject,
           body_text = v_body_text,
           body_html = v_body_html,
           variables = p_variables,
           sample_variables = coalesce(p_sample_variables, '{}'::jsonb),
           requires_tokens = coalesce(p_requires_tokens, false),
           channel = v_channel,
           layout_key = nullif(btrim(coalesce(p_layout_key, '')), ''),
           direction = v_direction,
           notes = nullif(btrim(coalesce(p_notes, '')), ''),
           content_hash = v_hash,
           updated_by = v_actor
     where id = v_draft.id
    returning * into v_draft;

    insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (
      v_actor,
      'notification.template_updated'::public.audit_action,
      'notification_templates',
      v_draft.id::text,
      jsonb_build_object(
        'transition', 'draft_updated',
        'key', v_draft.key,
        'locale', v_draft.locale,
        'version', v_draft.version,
        'content_hash', left(v_hash, 8),
        'previous_hash', left(v_previous_hash, 8),
        'changed', to_jsonb(array(
          select field_name
            from unnest(array['subject', 'body_text', 'body_html', 'variables',
                              'sample_variables', 'requires_tokens', 'layout_key',
                              'direction', 'notes', 'channel']) as field_name
        ))
      )
    );
  else
    insert into public.notification_templates (
      key, channel, locale, version, status, is_current,
      subject, body_text, body_html, layout_key, direction,
      variables, sample_variables, requires_tokens, content_hash, notes,
      created_by, updated_by
    )
    values (
      v_key, v_channel, v_locale,
      coalesce(
        (select max(existing.version) from public.notification_templates as existing
          where existing.key = v_key and existing.locale = v_locale),
        0
      ) + 1,
      'draft', false,
      v_subject, v_body_text, v_body_html,
      nullif(btrim(coalesce(p_layout_key, '')), ''), v_direction,
      p_variables, coalesce(p_sample_variables, '{}'::jsonb),
      coalesce(p_requires_tokens, false), v_hash,
      nullif(btrim(coalesce(p_notes, '')), ''),
      v_actor, v_actor
    )
    returning * into v_draft;

    insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (
      v_actor,
      'notification.template_updated'::public.audit_action,
      'notification_templates',
      v_draft.id::text,
      jsonb_build_object(
        'transition', 'draft_created',
        'key', v_draft.key,
        'locale', v_draft.locale,
        'version', v_draft.version,
        'content_hash', left(v_hash, 8)
      )
    );
  end if;

  return jsonb_build_object(
    'id', v_draft.id, 'key', v_draft.key, 'locale', v_draft.locale,
    'channel', v_draft.channel, 'version', v_draft.version,
    'status', v_draft.status, 'content_hash', v_draft.content_hash,
    'unchanged', false, 'updated_at', v_draft.updated_at
  );
exception
  when others then
    if sqlstate in ('42501', '22023', 'TPL01', 'TPL02', 'TPL03', 'TPL04', 'TPL05') then
      raise;
    end if;
    raise exception 'template_draft_update_failed' using errcode = sqlstate;
end;
$$;

revoke all on function public.admin_upsert_notification_template_draft(
  text, text, text, text, text, jsonb, jsonb, boolean, text, text, text, text, text
) from public, anon, service_role;
grant execute on function public.admin_upsert_notification_template_draft(
  text, text, text, text, text, jsonb, jsonb, boolean, text, text, text, text, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- 8) Publish / rollback / delete
-- ---------------------------------------------------------------------------
create or replace function public.admin_publish_notification_template(
  p_key text,
  p_locale text,
  p_version integer,
  p_expected_updated_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_draft public.notification_templates%rowtype;
  v_previous_version integer;
  v_validation jsonb;
  v_hash text;
begin
  if v_actor is null or not public.can_manage_notification_templates() then
    raise exception 'administrator privileges required' using errcode = '42501';
  end if;
  if p_version is null or p_version < 1 then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: version';
  end if;

  select *
    into v_draft
    from public.notification_templates
   where key = p_key
     and locale = p_locale
     and version = p_version
     and status = 'draft'
   for update;
  if not found then
    raise exception 'invalid_field'
      using errcode = '22023', detail = 'field: version',
            hint = 'no draft with this key/locale/version';
  end if;

  if p_expected_updated_at is not null and v_draft.updated_at <> p_expected_updated_at then
    raise exception 'invalid_field'
      using errcode = '22023', detail = 'field: expected_updated_at',
            hint = 'the draft changed since you loaded it';
  end if;

  -- Re-prove the content at publish time: a draft that was valid when saved is
  -- not trusted to still be valid (study §3.3 "validation at both ends").
  v_validation := public.notification_template_validate(
    v_draft.subject, v_draft.body_text, v_draft.body_html,
    v_draft.variables, v_draft.requires_tokens
  );
  if not coalesce((v_validation ->> 'ok')::boolean, false) then
    raise exception 'TPL01: invalid_draft'
      using errcode = coalesce(v_validation ->> 'code', 'TPL01')::text,
            detail = 'names: ' || coalesce(v_validation ->> 'names', '');
  end if;

  v_hash := public.notification_template_content_hash(
    v_draft.subject, v_draft.body_text, v_draft.body_html, v_draft.variables
  );
  if v_hash <> v_draft.content_hash then
    raise exception 'invalid_field'
      using errcode = '22023', detail = 'field: content_hash',
            hint = 'stored hash does not match the stored content';
  end if;

  select active.version
    into v_previous_version
    from public.notification_templates as active
   where active.key = p_key
     and active.locale = p_locale
     and active.status = 'active'
     and active.is_current;

  update public.notification_templates
     set status = 'archived', is_current = false, updated_by = v_actor
   where key = p_key
     and locale = p_locale
     and status = 'active';

  update public.notification_templates
     set status = 'active', is_current = true, updated_by = v_actor
   where id = v_draft.id
  returning * into v_draft;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'notification.template_updated'::public.audit_action,
    'notification_templates',
    v_draft.id::text,
    jsonb_build_object(
      'transition', 'publish',
      'key', v_draft.key,
      'locale', v_draft.locale,
      'from_version', v_previous_version,
      'to_version', v_draft.version,
      'content_hash', left(v_draft.content_hash, 8)
    )
  );

  return jsonb_build_object(
    'id', v_draft.id, 'key', v_draft.key, 'locale', v_draft.locale,
    'version', v_draft.version, 'status', v_draft.status,
    'is_current', v_draft.is_current, 'content_hash', v_draft.content_hash,
    'previous_version', v_previous_version, 'updated_at', v_draft.updated_at
  );
exception
  when others then
    if sqlstate in ('42501', '22023', 'TPL01', 'TPL02', 'TPL03', 'TPL04', 'TPL05') then
      raise;
    end if;
    raise exception 'template_publish_failed' using errcode = sqlstate;
end;
$$;

revoke all on function public.admin_publish_notification_template(text, text, integer, timestamptz)
  from public, anon, service_role;
grant execute on function public.admin_publish_notification_template(text, text, integer, timestamptz)
  to authenticated;

create or replace function public.admin_rollback_notification_template(
  p_key text,
  p_locale text,
  p_to_version integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_target public.notification_templates%rowtype;
  v_current_version integer;
begin
  if v_actor is null or not public.can_manage_notification_templates() then
    raise exception 'administrator privileges required' using errcode = '42501';
  end if;

  -- Publishing archives the previous version, so a rollback target is normally
  -- status='archived'. Drafts are never restorable: they were never published.
  select *
    into v_target
    from public.notification_templates
   where key = p_key
     and locale = p_locale
     and version = p_to_version
     and status in ('active', 'archived')
   for update;
  if not found then
    raise exception 'invalid_field'
      using errcode = '22023', detail = 'field: version',
            hint = 'the target version was never published';
  end if;

  if v_target.is_current then
    return jsonb_build_object(
      'id', v_target.id, 'key', v_target.key, 'locale', v_target.locale,
      'version', v_target.version, 'status', v_target.status,
      'is_current', true, 'unchanged', true, 'content_hash', v_target.content_hash
    );
  end if;

  select active.version
    into v_current_version
    from public.notification_templates as active
   where active.key = p_key
     and active.locale = p_locale
     and active.is_current;

  update public.notification_templates
     set status = 'archived', is_current = false, updated_by = v_actor
   where key = p_key and locale = p_locale and is_current;

  update public.notification_templates
     set status = 'active', is_current = true, updated_by = v_actor
   where id = v_target.id
  returning * into v_target;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'notification.template_updated'::public.audit_action,
    'notification_templates',
    v_target.id::text,
    jsonb_build_object(
      'transition', 'rollback',
      'key', v_target.key,
      'locale', v_target.locale,
      'from_version', v_current_version,
      'to_version', v_target.version,
      'content_hash', left(v_target.content_hash, 8)
    )
  );

  return jsonb_build_object(
    'id', v_target.id, 'key', v_target.key, 'locale', v_target.locale,
    'version', v_target.version, 'status', v_target.status,
    'is_current', v_target.is_current, 'unchanged', false,
    'content_hash', v_target.content_hash, 'updated_at', v_target.updated_at
  );
exception
  when others then
    if sqlstate in ('42501', '22023', 'TPL01', 'TPL02', 'TPL03', 'TPL04', 'TPL05') then
      raise;
    end if;
    raise exception 'template_rollback_failed' using errcode = sqlstate;
end;
$$;

revoke all on function public.admin_rollback_notification_template(text, text, integer)
  from public, anon, service_role;
grant execute on function public.admin_rollback_notification_template(text, text, integer)
  to authenticated;

create or replace function public.admin_delete_notification_template_draft(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_draft public.notification_templates%rowtype;
begin
  if v_actor is null or not public.can_manage_notification_templates() then
    raise exception 'administrator privileges required' using errcode = '42501';
  end if;

  select *
    into v_draft
    from public.notification_templates
   where id = p_id
   for update;
  if not found then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: id';
  end if;
  if v_draft.status <> 'draft' then
    raise exception 'invalid_field'
      using errcode = '22023', detail = 'field: status',
            hint = 'only drafts can be deleted';
  end if;

  delete from public.notification_templates where id = p_id;

  insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
  values (
    v_actor,
    'notification.template_updated'::public.audit_action,
    'notification_templates',
    p_id::text,
    jsonb_build_object(
      'transition', 'draft_deleted',
      'key', v_draft.key,
      'locale', v_draft.locale,
      'version', v_draft.version,
      'content_hash', left(v_draft.content_hash, 8)
    )
  );

  return true;
exception
  when others then
    if sqlstate in ('42501', '22023', 'TPL01', 'TPL02', 'TPL03', 'TPL04', 'TPL05') then
      raise;
    end if;
    raise exception 'template_draft_delete_failed' using errcode = sqlstate;
end;
$$;

revoke all on function public.admin_delete_notification_template_draft(uuid)
  from public, anon, service_role;
grant execute on function public.admin_delete_notification_template_draft(uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 9) Renderer (stable, writes nothing) + audited preview wrapper
-- ---------------------------------------------------------------------------
create or replace function public.admin_render_notification(
  p_key text,
  p_locale text default null,
  p_variables jsonb default '{}'::jsonb,
  p_mode text default 'preview'
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_mode text := coalesce(nullif(btrim(coalesce(p_mode, '')), ''), 'preview');
  v_locale text := nullif(btrim(coalesce(p_locale, '')), '');
  v_default_locale text;
  v_template public.notification_templates%rowtype;
  v_fallback_used boolean := false;
  v_values jsonb := coalesce(p_variables, '{}'::jsonb);
  v_types jsonb := '{}'::jsonb;
  v_prepared jsonb;
  v_subject text;
  v_body_text text;
  v_body_html text;
begin
  if v_mode not in ('preview', 'delivery') then
    raise exception 'invalid_field' using errcode = '22023', detail = 'field: mode';
  end if;

  if v_mode = 'preview' then
    if auth.uid() is null or not public.can_manage_notification_templates() then
      raise exception 'administrator privileges required' using errcode = '42501';
    end if;
  else
    -- Delivery is never a browser call: only the sending worker (service_role)
    -- or an operator session may render for real recipients (study §2.7).
    -- The JWT claim wins when it exists: a bearer token issued for
    -- `authenticated` can never claim delivery just because the database
    -- session happens to belong to the migration role.
    if coalesce(auth.role(), '') = '' then
      if session_user not in ('service_role', 'postgres', 'supabase_admin') then
        raise exception 'delivery mode is restricted to the sending worker'
          using errcode = '42501';
      end if;
    elsif coalesce(auth.role(), '') <> 'service_role' then
      raise exception 'delivery mode is restricted to the sending worker'
        using errcode = '42501';
    end if;
  end if;

  select coalesce(value #>> '{}', 'ar')
    into v_default_locale
    from public.app_settings
   where key = 'appearance.default_locale';
  v_default_locale := coalesce(v_default_locale, 'ar');

  if v_mode = 'preview' then
    -- The editor renders the draft it is working on; when no draft exists it
    -- falls back to the published version (requested locale, then default).
    select * into v_template
      from public.notification_templates
     where key = p_key
       and status = 'draft'
       and locale = coalesce(v_locale, v_default_locale)
     order by version desc
     limit 1;

    if not found then
      select * into v_template
        from public.notification_templates
       where key = p_key
         and status = 'active'
         and is_current
         and locale = coalesce(v_locale, v_default_locale)
       limit 1;
      if not found and coalesce(v_locale, v_default_locale) <> v_default_locale then
        v_fallback_used := true;
        select * into v_template
          from public.notification_templates
         where key = p_key
           and status = 'active'
           and is_current
           and locale = v_default_locale
         limit 1;
      end if;
    end if;
  else
    select * into v_template
      from public.notification_templates
     where key = p_key
       and status = 'active'
       and is_current
       and locale = coalesce(v_locale, v_default_locale)
     limit 1;
    if not found and coalesce(v_locale, v_default_locale) <> v_default_locale then
      v_fallback_used := true;
      select * into v_template
        from public.notification_templates
       where key = p_key
         and status = 'active'
         and is_current
         and locale = v_default_locale
       limit 1;
    end if;
  end if;

  if not found then
    raise exception 'TPL03: no_active_template' using errcode = 'TPL03';
  end if;

  -- Preview fills the gaps with masked sample data; delivery never does.
  if v_mode = 'preview' then
    v_values := coalesce(v_template.sample_variables, '{}'::jsonb) || v_values;
  end if;

  select coalesce(
           jsonb_object_agg(element ->> 'name', coalesce(element ->> 'type', 'text')),
           '{}'::jsonb
         )
    into v_types
    from jsonb_array_elements(v_template.variables) as element
   where element ? 'name';

  -- Fail closed: a stored template whose body references an undeclared token
  -- never renders (the seeds are checked by the audit mirror for this reason).
  declare
    v_tokens jsonb;
  begin
    v_tokens := public.notification_template_token_problems(
      public.notification_template_tokens(v_template.subject)
        || public.notification_template_tokens(v_template.body_text)
        || public.notification_template_tokens(v_template.body_html),
      v_template.variables
    );
    if jsonb_array_length(v_tokens -> 'reserved') > 0 then
      raise exception 'TPL05: reserved_variable_name'
        using errcode = 'TPL05', detail = 'names: ' || (v_tokens ->> 'reserved');
    end if;
    if jsonb_array_length(v_tokens -> 'unknown') > 0 then
      raise exception 'TPL01: unknown_or_invalid_token'
        using errcode = 'TPL01', detail = 'names: ' || (v_tokens ->> 'unknown');
    end if;
  end;

  v_prepared := public.notification_template_prepare_values(v_template.variables, v_values);
  if not coalesce((v_prepared ->> 'ok')::boolean, false) then
    if jsonb_array_length(coalesce(v_prepared -> 'missing', '[]'::jsonb)) > 0
       or jsonb_array_length(coalesce(v_prepared -> 'unknown', '[]'::jsonb)) > 0 then
      raise exception 'TPL01: unknown_or_missing_variable'
        using errcode = 'TPL01',
              detail = 'names: ' || coalesce(
                (select string_agg(element, ',' order by element)
                   from jsonb_array_elements_text(
                     coalesce(v_prepared -> 'missing', '[]'::jsonb)
                     || coalesce(v_prepared -> 'unknown', '[]'::jsonb)
                   ) as element),
                ''
              );
    end if;
    raise exception 'TPL02: invalid_variable_value'
      using errcode = 'TPL02',
            detail = 'names: ' || coalesce(
              (select string_agg(element, ',' order by element)
                 from jsonb_array_elements_text(coalesce(v_prepared -> 'invalid', '[]'::jsonb)) as element),
              ''
            );
  end if;

  v_subject := public.notification_template_substitute(
    v_template.subject, v_prepared -> 'values', v_types, false
  );
  v_body_text := public.notification_template_substitute(
    v_template.body_text, v_prepared -> 'values', v_types, false
  );
  v_body_html := public.notification_template_substitute(
    v_template.body_html, v_prepared -> 'values', v_types, true
  );

  return jsonb_build_object(
    'key', v_template.key,
    'template_id', v_template.id,
    'locale', v_template.locale,
    'resolved_locale', v_template.locale,
    'fallback_used', v_fallback_used,
    'version', v_template.version,
    'status', v_template.status,
    'direction', v_template.direction,
    'requires_tokens', v_template.requires_tokens,
    'template_content_hash', v_template.content_hash,
    'rendered_hash', encode(
      extensions.digest(
        coalesce(v_subject, '') || E'\n' ||
        coalesce(v_body_text, '') || E'\n' ||
        coalesce(v_body_html, ''),
        'sha256'
      ),
      'hex'
    ),
    'subject', v_subject,
    'body_text', v_body_text,
    'body_html', v_body_html,
    'mode', v_mode
  );
end;
$$;

revoke all on function public.admin_render_notification(text, text, jsonb, text)
  from public, anon;
grant execute on function public.admin_render_notification(text, text, jsonb, text)
  to authenticated, service_role;

-- The audited preview: §3.5 wants a notification.template_previewed row, while
-- §2.4 wants render itself to stay a pure read. This volatile wrapper is the
-- editor's entry point and keeps both contracts true.
create or replace function public.admin_preview_notification_template(
  p_key text,
  p_locale text default null,
  p_variables jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if v_actor is null or not public.can_manage_notification_templates() then
    raise exception 'administrator privileges required' using errcode = '42501';
  end if;

  v_result := public.admin_render_notification(p_key, p_locale, p_variables, 'preview');

  if coalesce((v_result ->> 'status')::text, '') = 'draft' then
    insert into public.audit_logs (actor_id, action, entity, entity_id, metadata)
    values (
      v_actor,
      'notification.template_previewed'::public.audit_action,
      'notification_templates',
      v_result ->> 'template_id',
      jsonb_build_object(
        'key', v_result ->> 'key',
        'locale', v_result ->> 'locale',
        'mode', 'preview',
        'version', (v_result ->> 'version')::integer,
        'template_content_hash', left(v_result ->> 'template_content_hash', 8)
      )
    );
  end if;

  return v_result;
end;
$$;

revoke all on function public.admin_preview_notification_template(text, text, jsonb)
  from public, anon, service_role;
grant execute on function public.admin_preview_notification_template(text, text, jsonb)
  to authenticated;

-- ---------------------------------------------------------------------------
-- 10) Realtime (invalidation signal only — study §3.2/C9)
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'notification_templates'
  ) then
    alter publication supabase_realtime add table public.notification_templates;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 11) Seeds (study §2.9) — version 1, active, bilingual, hashed
-- ---------------------------------------------------------------------------
-- The bootstrap flag lets the migration insert already-published rows while the
-- immutability guard stays in force for every other writer.
set app.notification_template_bootstrap = 'on';

insert into public.notification_templates (
  key, channel, locale, version, status, is_current,
  subject, body_text, body_html, direction,
  variables, sample_variables, requires_tokens, content_hash, is_system,
  created_by, updated_by
)
values
  -- auth.welcome_invitation (ar)
  (
    'auth.welcome_invitation', 'email', 'ar', 1, 'active', true,
    'مرحباً {{user_name}} — تفعيل حسابك في {{app_name}}',
    E'مرحباً {{user_name}},\n\nتم إنشاء حسابك في {{app_name}}.\nلتفعيل الحساب افتح الرابط التالي:\n{{action_url}}\n\nينتهي الرابط في {{expires_at}}.\nللدعم راسلنا على {{support_email}}.',
    '<div dir="rtl"><h2>مرحباً {{user_name}}</h2><p>تم إنشاء حسابك في {{app_name}}.</p><p>لتفعيل الحساب اضغط على الرابط التالي:</p><p>{{action_url}}</p><p>ينتهي الرابط في {{expires_at}}.</p><hr><p>للدعم راسلنا على {{support_email}}.</p></div>',
    'rtl',
    '[{"name":"user_name","type":"text","required":true,"max_length":120},
      {"name":"app_name","type":"text","required":true,"max_length":80,"source":"identity"},
      {"name":"action_url","type":"url","required":true,"requires_token":true},
      {"name":"expires_at","type":"datetime","required":false},
      {"name":"support_email","type":"email","required":false}]'::jsonb,
    '{"user_name":"لينا","app_name":"نظام الإدارة","action_url":"https://app.example.invalid/invitations/confirm","expires_at":"2026-10-09T12:00:00Z","support_email":"support@example.invalid"}'::jsonb,
    true,
    public.notification_template_content_hash(
      'مرحباً {{user_name}} — تفعيل حسابك في {{app_name}}',
      E'مرحباً {{user_name}},\n\nتم إنشاء حسابك في {{app_name}}.\nلتفعيل الحساب افتح الرابط التالي:\n{{action_url}}\n\nينتهي الرابط في {{expires_at}}.\nللدعم راسلنا على {{support_email}}.',
      '<div dir="rtl"><h2>مرحباً {{user_name}}</h2><p>تم إنشاء حسابك في {{app_name}}.</p><p>لتفعيل الحساب اضغط على الرابط التالي:</p><p>{{action_url}}</p><p>ينتهي الرابط في {{expires_at}}.</p><hr><p>للدعم راسلنا على {{support_email}}.</p></div>',
      '[{"name":"user_name","type":"text","required":true,"max_length":120},
        {"name":"app_name","type":"text","required":true,"max_length":80,"source":"identity"},
        {"name":"action_url","type":"url","required":true,"requires_token":true},
        {"name":"expires_at","type":"datetime","required":false},
        {"name":"support_email","type":"email","required":false}]'::jsonb
    ),
    true, null, null
  ),
  -- auth.welcome_invitation (en)
  (
    'auth.welcome_invitation', 'email', 'en', 1, 'active', true,
    'Welcome {{user_name}} — activate your {{app_name}} account',
    E'Hi {{user_name}},\n\nYour {{app_name}} account has been created.\nOpen the link below to activate it:\n{{action_url}}\n\nThe link expires at {{expires_at}}.\nFor help, contact {{support_email}}.',
    '<div dir="ltr"><h2>Welcome {{user_name}}</h2><p>Your {{app_name}} account has been created.</p><p>Open the link below to activate it:</p><p>{{action_url}}</p><p>The link expires at {{expires_at}}.</p><hr><p>For help, contact {{support_email}}.</p></div>',
    'ltr',
    '[{"name":"user_name","type":"text","required":true,"max_length":120},
      {"name":"app_name","type":"text","required":true,"max_length":80,"source":"identity"},
      {"name":"action_url","type":"url","required":true,"requires_token":true},
      {"name":"expires_at","type":"datetime","required":false},
      {"name":"support_email","type":"email","required":false}]'::jsonb,
    '{"user_name":"Lina","app_name":"Admin System","action_url":"https://app.example.invalid/invitations/confirm","expires_at":"2026-10-09T12:00:00Z","support_email":"support@example.invalid"}'::jsonb,
    true,
    public.notification_template_content_hash(
      'Welcome {{user_name}} — activate your {{app_name}} account',
      E'Hi {{user_name}},\n\nYour {{app_name}} account has been created.\nOpen the link below to activate it:\n{{action_url}}\n\nThe link expires at {{expires_at}}.\nFor help, contact {{support_email}}.',
      '<div dir="ltr"><h2>Welcome {{user_name}}</h2><p>Your {{app_name}} account has been created.</p><p>Open the link below to activate it:</p><p>{{action_url}}</p><p>The link expires at {{expires_at}}.</p><hr><p>For help, contact {{support_email}}.</p></div>',
      '[{"name":"user_name","type":"text","required":true,"max_length":120},
        {"name":"app_name","type":"text","required":true,"max_length":80,"source":"identity"},
        {"name":"action_url","type":"url","required":true,"requires_token":true},
        {"name":"expires_at","type":"datetime","required":false},
        {"name":"support_email","type":"email","required":false}]'::jsonb
    ),
    true, null, null
  ),
  -- security.suspension_alert (ar)
  (
    'security.suspension_alert', 'email', 'ar', 1, 'active', true,
    'تنبيه أمني: تم تعليق حسابك في {{app_name}}',
    E'مرحباً {{user_name}},\n\nقام {{admin_name}} بتعليق حسابك.\nالسبب المُرمَّز: {{reason_code}}\nوقت السريان: {{effective_at}}\n\nيمكنك تقديم طلب مراجعة عبر:\n{{appeal_url}}',
    '<div dir="rtl"><h2>مرحباً {{user_name}}</h2><p>قام {{admin_name}} بتعليق حسابك.</p><p>السبب المُرمَّز: {{reason_code}}</p><p>وقت السريان: {{effective_at}}</p><p>يمكنك تقديم طلب مراجعة عبر الرابط التالي:</p><p>{{appeal_url}}</p></div>',
    'rtl',
    '[{"name":"user_name","type":"text","required":true,"max_length":120},
      {"name":"app_name","type":"text","required":true,"max_length":80,"source":"identity"},
      {"name":"admin_name","type":"text","required":true,"max_length":120},
      {"name":"reason_code","type":"text","required":true,"max_length":64},
      {"name":"effective_at","type":"datetime","required":true},
      {"name":"appeal_url","type":"url","required":true,"requires_token":true}]'::jsonb,
    '{"user_name":"لينا","app_name":"نظام الإدارة","admin_name":"سامي","reason_code":"POLICY_VIOLATION","effective_at":"2026-10-02T09:00:00Z","appeal_url":"https://app.example.invalid/appeals/new"}'::jsonb,
    true,
    public.notification_template_content_hash(
      'تنبيه أمني: تم تعليق حسابك في {{app_name}}',
      E'مرحباً {{user_name}},\n\nقام {{admin_name}} بتعليق حسابك.\nالسبب المُرمَّز: {{reason_code}}\nوقت السريان: {{effective_at}}\n\nيمكنك تقديم طلب مراجعة عبر:\n{{appeal_url}}',
      '<div dir="rtl"><h2>مرحباً {{user_name}}</h2><p>قام {{admin_name}} بتعليق حسابك.</p><p>السبب المُرمَّز: {{reason_code}}</p><p>وقت السريان: {{effective_at}}</p><p>يمكنك تقديم طلب مراجعة عبر الرابط التالي:</p><p>{{appeal_url}}</p></div>',
      '[{"name":"user_name","type":"text","required":true,"max_length":120},
        {"name":"app_name","type":"text","required":true,"max_length":80,"source":"identity"},
        {"name":"admin_name","type":"text","required":true,"max_length":120},
        {"name":"reason_code","type":"text","required":true,"max_length":64},
        {"name":"effective_at","type":"datetime","required":true},
        {"name":"appeal_url","type":"url","required":true,"requires_token":true}]'::jsonb
    ),
    true, null, null
  ),
  -- security.suspension_alert (en)
  (
    'security.suspension_alert', 'email', 'en', 1, 'active', true,
    'Security alert: your {{app_name}} account was suspended',
    E'Hi {{user_name}},\n\n{{admin_name}} suspended your account.\nReason code: {{reason_code}}\nEffective at: {{effective_at}}\n\nYou can request a review here:\n{{appeal_url}}',
    '<div dir="ltr"><h2>Hi {{user_name}}</h2><p>{{admin_name}} suspended your account.</p><p>Reason code: {{reason_code}}</p><p>Effective at: {{effective_at}}</p><p>You can request a review here:</p><p>{{appeal_url}}</p></div>',
    'ltr',
    '[{"name":"user_name","type":"text","required":true,"max_length":120},
      {"name":"app_name","type":"text","required":true,"max_length":80,"source":"identity"},
      {"name":"admin_name","type":"text","required":true,"max_length":120},
      {"name":"reason_code","type":"text","required":true,"max_length":64},
      {"name":"effective_at","type":"datetime","required":true},
      {"name":"appeal_url","type":"url","required":true,"requires_token":true}]'::jsonb,
    '{"user_name":"Lina","app_name":"Admin System","admin_name":"Sami","reason_code":"POLICY_VIOLATION","effective_at":"2026-10-02T09:00:00Z","appeal_url":"https://app.example.invalid/appeals/new"}'::jsonb,
    true,
    public.notification_template_content_hash(
      'Security alert: your {{app_name}} account was suspended',
      E'Hi {{user_name}},\n\n{{admin_name}} suspended your account.\nReason code: {{reason_code}}\nEffective at: {{effective_at}}\n\nYou can request a review here:\n{{appeal_url}}',
      '<div dir="ltr"><h2>Hi {{user_name}}</h2><p>{{admin_name}} suspended your account.</p><p>Reason code: {{reason_code}}</p><p>Effective at: {{effective_at}}</p><p>You can request a review here:</p><p>{{appeal_url}}</p></div>',
      '[{"name":"user_name","type":"text","required":true,"max_length":120},
        {"name":"app_name","type":"text","required":true,"max_length":80,"source":"identity"},
        {"name":"admin_name","type":"text","required":true,"max_length":120},
        {"name":"reason_code","type":"text","required":true,"max_length":64},
        {"name":"effective_at","type":"datetime","required":true},
        {"name":"appeal_url","type":"url","required":true,"requires_token":true}]'::jsonb
    ),
    true, null, null
  ),
  -- backup.failure_notice (ar)
  (
    'backup.failure_notice', 'email', 'ar', 1, 'active', true,
    'فشل النسخ الاحتياطي: {{job_name}}',
    E'تعذّر إكمال مهمة النسخ الاحتياطي {{job_name}}.\nوقت الفشل: {{failed_at}}\nالمدة: {{duration_ms}} مِلّي ثانية\nتصنيف الخطأ: {{error_class}}\n\nلوحة المتابعة:\n{{dashboard_url}}',
    '<div dir="rtl"><h2>فشل النسخ الاحتياطي</h2><p>تعذّر إكمال مهمة <strong>{{job_name}}</strong>.</p><p>وقت الفشل: {{failed_at}}</p><p>المدة: {{duration_ms}} مِلّي ثانية</p><p>تصنيف الخطأ: {{error_class}}</p><p>لوحة المتابعة:</p><p>{{dashboard_url}}</p></div>',
    'rtl',
    '[{"name":"job_name","type":"text","required":true,"max_length":120},
      {"name":"failed_at","type":"datetime","required":true},
      {"name":"duration_ms","type":"int","required":true},
      {"name":"error_class","type":"text","required":true,"max_length":64},
      {"name":"dashboard_url","type":"url","required":true,"requires_token":true}]'::jsonb,
    '{"job_name":"nightly-database","failed_at":"2026-10-02T02:15:00Z","duration_ms":"45000","error_class":"STORAGE_TIMEOUT","dashboard_url":"https://app.example.invalid/settings/backups"}'::jsonb,
    true,
    public.notification_template_content_hash(
      'فشل النسخ الاحتياطي: {{job_name}}',
      E'تعذّر إكمال مهمة النسخ الاحتياطي {{job_name}}.\nوقت الفشل: {{failed_at}}\nالمدة: {{duration_ms}} مِلّي ثانية\nتصنيف الخطأ: {{error_class}}\n\nلوحة المتابعة:\n{{dashboard_url}}',
      '<div dir="rtl"><h2>فشل النسخ الاحتياطي</h2><p>تعذّر إكمال مهمة <strong>{{job_name}}</strong>.</p><p>وقت الفشل: {{failed_at}}</p><p>المدة: {{duration_ms}} مِلّي ثانية</p><p>تصنيف الخطأ: {{error_class}}</p><p>لوحة المتابعة:</p><p>{{dashboard_url}}</p></div>',
      '[{"name":"job_name","type":"text","required":true,"max_length":120},
        {"name":"failed_at","type":"datetime","required":true},
        {"name":"duration_ms","type":"int","required":true},
        {"name":"error_class","type":"text","required":true,"max_length":64},
        {"name":"dashboard_url","type":"url","required":true,"requires_token":true}]'::jsonb
    ),
    true, null, null
  ),
  -- backup.failure_notice (en)
  (
    'backup.failure_notice', 'email', 'en', 1, 'active', true,
    'Backup failure: {{job_name}}',
    E'The backup job {{job_name}} could not complete.\nFailed at: {{failed_at}}\nDuration: {{duration_ms}} ms\nError class: {{error_class}}\n\nDashboard:\n{{dashboard_url}}',
    '<div dir="ltr"><h2>Backup failure</h2><p>The job <strong>{{job_name}}</strong> could not complete.</p><p>Failed at: {{failed_at}}</p><p>Duration: {{duration_ms}} ms</p><p>Error class: {{error_class}}</p><p>Dashboard:</p><p>{{dashboard_url}}</p></div>',
    'ltr',
    '[{"name":"job_name","type":"text","required":true,"max_length":120},
      {"name":"failed_at","type":"datetime","required":true},
      {"name":"duration_ms","type":"int","required":true},
      {"name":"error_class","type":"text","required":true,"max_length":64},
      {"name":"dashboard_url","type":"url","required":true,"requires_token":true}]'::jsonb,
    '{"job_name":"nightly-database","failed_at":"2026-10-02T02:15:00Z","duration_ms":"45000","error_class":"STORAGE_TIMEOUT","dashboard_url":"https://app.example.invalid/settings/backups"}'::jsonb,
    true,
    public.notification_template_content_hash(
      'Backup failure: {{job_name}}',
      E'The backup job {{job_name}} could not complete.\nFailed at: {{failed_at}}\nDuration: {{duration_ms}} ms\nError class: {{error_class}}\n\nDashboard:\n{{dashboard_url}}',
      '<div dir="ltr"><h2>Backup failure</h2><p>The job <strong>{{job_name}}</strong> could not complete.</p><p>Failed at: {{failed_at}}</p><p>Duration: {{duration_ms}} ms</p><p>Error class: {{error_class}}</p><p>Dashboard:</p><p>{{dashboard_url}}</p></div>',
      '[{"name":"job_name","type":"text","required":true,"max_length":120},
        {"name":"failed_at","type":"datetime","required":true},
        {"name":"duration_ms","type":"int","required":true},
        {"name":"error_class","type":"text","required":true,"max_length":64},
        {"name":"dashboard_url","type":"url","required":true,"requires_token":true}]'::jsonb
    ),
    true, null, null
  )
on conflict (key, locale, version) do nothing;

-- The bootstrap flag is scoped to this migration session only; every later
-- writer — including service_role — faces the immutability guard.
reset app.notification_template_bootstrap;
