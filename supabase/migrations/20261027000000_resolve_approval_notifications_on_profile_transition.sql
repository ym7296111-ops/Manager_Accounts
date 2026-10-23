-- Resolve owner queue notifications for every pending -> approved/rejected
-- profile transition, including direct SQL transitions outside the approval RPC.
-- The existing RPC resolution remains a harmless, idempotent duplicate.

create or replace function public.resolve_approval_notification_trigger()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.approval_status = 'pending'
     and old.approval_status is distinct from new.approval_status
     and new.approval_status in ('approved', 'rejected') then
    begin
      perform public.resolve_related_notifications(new.id, 'user_approval_requested');
    exception when others then
      -- Notifications are auxiliary: a feed failure must never reject the
      -- underlying profile approval/rejection transition.
      raise warning 'in_app_notification: approval resolution failed for %: %',
        new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

revoke all on function public.resolve_approval_notification_trigger()
  from public, anon, authenticated, service_role;
comment on function public.resolve_approval_notification_trigger() is
  'Best-effort trigger: resolves owner queue notifications after a pending profile becomes approved or rejected; never blocks the profile update.';

drop trigger if exists profiles_resolve_approval_notifications on public.profiles;
create trigger profiles_resolve_approval_notifications
  after update of approval_status on public.profiles
  for each row
  when (
    old.approval_status = 'pending'
    and new.approval_status in ('approved', 'rejected')
  )
  execute function public.resolve_approval_notification_trigger();

-- One-time cleanup for legacy queue notifications whose profile has already
-- left pending status. Older rows are linked by the stable dedupe key if the
-- source id was not previously backfilled.
update public.user_notifications as notification
   set related_id = profile.id,
       resolved_at = coalesce(notification.resolved_at, now()),
       is_read = true,
       read_at = coalesce(notification.read_at, now())
  from public.profiles as profile
 where notification.type = 'user_approval_requested'
   and profile.approval_status in ('approved', 'rejected')
   and (
     notification.related_id = profile.id
     or (
       notification.related_id is null
       and notification.dedupe_key = format('user_approval_requested:%s', profile.id)
     )
   );
