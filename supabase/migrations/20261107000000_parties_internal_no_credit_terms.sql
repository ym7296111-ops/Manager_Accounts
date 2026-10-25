-- Project Settings -> Parties (Phase 2 hardening): internal parties never
-- carry credit terms.
--
-- `credit_limit` and `payment_terms` describe a commercial settlement between
-- two separate legal entities: a ceiling and a number of days to pay. An
-- internal party is a department of this same entity — there is no invoice and
-- nobody to settle with, so a value in either column is meaningless data. The
-- Phase 2 screen hides both fields for internal parties (and sister
-- companies), but hiding is cosmetic: any other client could still write them.
-- This CHECK makes the rule the database's, for the one type where it is
-- semantically absolute.
--
-- Sister companies are deliberately NOT constrained here. They are separate
-- legal entities, and intercompany settlement terms are a plausible future
-- requirement; the UI rule (no credit fields) can be relaxed without a schema
-- change, while an over-broad CHECK would have to be widened first.
--
-- Sanitization: no UI existed when this migration was written, so the UPDATE
-- below is expected to touch zero rows. It exists only so the constraint can
-- always be added even if a row was written by hand with SQL.

update public.parties
   set credit_limit = null,
       payment_terms = null
 where type = 'internal'
   and (credit_limit is not null or payment_terms is not null);

alter table public.parties
  drop constraint if exists parties_internal_no_credit_terms;

alter table public.parties
  add constraint parties_internal_no_credit_terms check (
    type <> 'internal'
    or (credit_limit is null and payment_terms is null)
  );

notify pgrst, 'reload schema';
