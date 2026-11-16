-- Apply once through the Supabase SQL Editor (runs as postgres), after 20261115000100_cancel_request_or_trip.sql.
-- In-app notifications for seat requests and request decisions.
--   * A saved seat request notifies the trip's driver (seat_requested).
--   * A driver's saved accept or decline notifies the rider (request_accepted / request_declined).
-- Database triggers create them only after the request or status change is actually saved, so
-- a refused insert or update creates nothing. One notification per request per event (unique
-- constraint), so retries and repeated saves never duplicate an alert.
-- Only the recipient can read or mark their own notifications. Nobody can insert, edit or
-- delete them through the API. Email and push notifications are later work.
-- Intentionally fails on name collisions, like the earlier migrations.
begin;

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('seat_requested', 'request_accepted', 'request_declined')),
  request_id uuid not null references public.ride_requests(id) on delete cascade,
  trip_id uuid not null references public.trips(id) on delete cascade,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint notifications_one_per_event unique (request_id, kind)
);
create index notifications_recipient_idx on public.notifications (recipient_id, created_at desc);

alter table public.notifications enable row level security;
revoke all on public.notifications from public, anon, authenticated;
grant select on public.notifications to authenticated;
create policy notifications_read_own on public.notifications
for select to authenticated
using (recipient_id = (select auth.uid()));

-- SECURITY DEFINER: the rider who requests a seat can't insert into the driver's notifications
-- (and the driver can't insert into the rider's). It only ever writes the one row for this event.
create function public.notify_ride_request()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    insert into public.notifications (recipient_id, kind, request_id, trip_id)
    select t.driver_id, 'seat_requested', new.id, new.trip_id
    from public.trips t where t.id = new.trip_id
    on conflict (request_id, kind) do nothing;
  elsif tg_op = 'UPDATE' and old.status = 'pending' and new.status in ('accepted', 'declined') then
    insert into public.notifications (recipient_id, kind, request_id, trip_id)
    values (new.rider_id, 'request_' || new.status, new.id, new.trip_id)
    on conflict (request_id, kind) do nothing;
  end if;
  return null;
end;
$$;
revoke all on function public.notify_ride_request() from public, anon, authenticated;

-- AFTER triggers run only once the row is saved and the decision/cancel checks have passed.
create trigger notify_ride_request_insert
after insert on public.ride_requests
for each row execute function public.notify_ride_request();
create trigger notify_ride_request_update
after update of status on public.ride_requests
for each row execute function public.notify_ride_request();

-- The signed-in user's 50 newest notifications, with what the app needs to describe them:
-- the destination, departure time, and the other person's name (rider for the driver,
-- driver for the rider). Never returns emails or anyone else's notifications.
create function public.my_notifications()
returns table (
  id uuid,
  kind text,
  request_id uuid,
  trip_id uuid,
  created_at timestamptz,
  read_at timestamptz,
  destination_id text,
  departure_at timestamptz,
  other_name text
)
language sql
stable
security definer
set search_path = ''
as $$
  select n.id, n.kind, n.request_id, n.trip_id, n.created_at, n.read_at,
    t.destination_id, t.departure_at,
    p.full_name
  from public.notifications n
  join public.trips t on t.id = n.trip_id
  join public.ride_requests r on r.id = n.request_id
  left join public.profiles p on p.id = case when n.kind = 'seat_requested' then r.rider_id else t.driver_id end
  where n.recipient_id = (select auth.uid())
  order by n.created_at desc, n.id
  limit 50;
$$;
revoke all on function public.my_notifications() from public, anon, authenticated;
grant execute on function public.my_notifications() to authenticated;

-- Mark the signed-in user's notifications read: the given ids, or all of them when ids is null.
-- Other people's ids are ignored. Returns how many changed.
create function public.mark_notifications_read(ids uuid[] default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  changed integer;
begin
  update public.notifications
  set read_at = now()
  where recipient_id = (select auth.uid())
    and read_at is null
    and (ids is null or id = any(ids));
  get diagnostics changed = row_count;
  return changed;
end;
$$;
revoke all on function public.mark_notifications_read(uuid[]) from public, anon, authenticated;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;

commit;
