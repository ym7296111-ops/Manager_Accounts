-- Enable Supabase Realtime for public.profiles.
--
-- The users-management screen (/settings/system/users) listens to
-- `profiles` changes and treats every event as a cache-invalidation signal
-- only: TanStack Query refetches the authoritative rows over PostgREST, so
-- the default replica identity (primary key only) is sufficient and no
-- column data is reconstructed from the realtime payload.
--
-- Applied automatically by .github/workflows/supabase-migration.yml on every push to main.

ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
