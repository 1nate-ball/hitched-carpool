-- Apply once through the Supabase SQL Editor (runs as postgres), after the earlier migrations.
-- Cancel a seat request or cancel a posted trip.
--   * A rider cancels their own pending or accepted request: status -> 'cancelled'.
--     Seats left only counts accepted requests, so cancelling an accepted seat gives it back.
--   * A driver cancels their own trip: trips.cancelled_at is set (to the database time).
--     Cancelled trips leave search, take no new requests or decisions, and can't be edited.
--   * Nothing can be cancelled after the trip has left, and a cancellation can't be undone.
--   * A rider who cancelled can request the same trip again (one active request per rider).
-- Intentionally fails on name collisions, like the earlier migrations.
begin;

-- ---------- Requests ----------
alter table public.ride_requests drop constraint ride_requests_status_check;
alter table public.ride_requests add constraint ride_requests_status_check
  check (status in ('pending', 'accepted', 'declined', 'cancelled'));

-- One request per rider per trip still applies, except to requests the rider cancelled.
alter table public.ride_requests drop constraint ride_requests_one_per_rider;
create unique index ride_requests_one_active_per_rider on public.ride_requests (trip_id, rider_id)
  where status <> 'cancelled';

-- Riders may update their own requests. The trigger below allows them only one change:
-- pending/accepted -> cancelled. (status is still the only column in the update grant.)
create policy ride_requests_rider_cancels on public.ride_requests
for update to authenticated
using (rider_id = (select auth.uid()))
with check (rider_id = (select auth.uid()));

-- Replaces the accept/decline check (same trigger) so it also covers cancelling.
-- auth.uid() is null only for postgres in the SQL Editor, which may act as either side.
create or replace function public.check_ride_request_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller uuid := auth.uid();
  trip public.trips%rowtype;
  taken integer;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  -- Lock the trip so two accepts for its last seat can't both succeed.
  select * into trip from public.trips where id = new.trip_id for update;

  if new.status = 'cancelled' then
    if caller is not null and caller <> old.rider_id then
      raise exception 'Only the rider can cancel this request.' using errcode = '42501';
    end if;
    if old.status not in ('pending', 'accepted') then
      raise exception 'This request was already %.', old.status using errcode = '23514';
    end if;
    if trip.departure_at <= now() then
      raise exception 'This trip already left.' using errcode = '23514';
    end if;
    return new;
  end if;

  if caller is not null and caller <> trip.driver_id then
    raise exception 'Only the driver can accept or decline this request.' using errcode = '42501';
  end if;
  if old.status <> 'pending' or new.status not in ('accepted', 'declined') then
    raise exception 'This request was already %.', old.status using errcode = '23514';
  end if;
  if trip.cancelled_at is not null then
    raise exception 'This trip was cancelled.' using errcode = '23514';
  end if;
  if new.status = 'accepted' then
    select count(*) into taken from public.ride_requests
      where trip_id = new.trip_id and status = 'accepted';
    if taken >= trip.total_seats then
      raise exception 'This trip is full.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.check_ride_request_decision() from public, anon, authenticated;

-- ---------- Trips ----------
alter table public.trips add column cancelled_at timestamptz;
grant update (cancelled_at) on public.trips to authenticated;
-- trips_update_own (20261106000100) already limits updates to the trip's driver.

create function public.check_trip_cancellation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.cancelled_at is not null then
    raise exception 'This trip was already cancelled.' using errcode = '23514';
  end if;
  if new.cancelled_at is not null then
    if old.departure_at <= now() then
      raise exception 'This trip already left.' using errcode = '23514';
    end if;
    new.cancelled_at := now(); -- the database clock, not the browser's
  end if;
  return new;
end;
$$;
revoke all on function public.check_trip_cancellation() from public, anon, authenticated;

create trigger check_trip_cancellation
before update on public.trips
for each row execute function public.check_trip_cancellation();

-- No new requests on a cancelled trip.
create function public.check_request_trip_open()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.trips where id = new.trip_id and cancelled_at is not null) then
    raise exception 'This trip was cancelled.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.check_request_trip_open() from public, anon, authenticated;

create trigger check_request_trip_open
before insert on public.ride_requests
for each row execute function public.check_request_trip_open();

-- ---------- Search and KR views skip cancelled trips ----------
-- Recreated (not replaced) because t.* now includes cancelled_at.
drop view public.available_trips;
create view public.available_trips with (security_barrier = true) as
select t.*, (t.total_seats - (select count(*) from public.ride_requests r
  where r.trip_id = t.id and r.status = 'accepted'))::integer as seats_available
from public.trips t
where (select auth.uid()) is not null and t.departure_at > now() and t.cancelled_at is null
  and t.total_seats > (select count(*) from public.ride_requests r where r.trip_id = t.id and r.status = 'accepted');
revoke all on public.available_trips from public, anon, authenticated;
grant select on public.available_trips to authenticated;

-- Objective 2 seat-fill KR: a cancelled trip never had a chance to fill, so it isn't averaged in.
create or replace view public.kr_seat_fill_rate with (security_invoker = true) as
select t.id as trip_id, t.total_seats as seats_total,
  count(r.id) filter (where r.status = 'accepted')::integer as accepted_seats,
  least(1.0, count(r.id) filter (where r.status = 'accepted')::numeric / t.total_seats) as fill_rate,
  t.departure_at <= now() as has_departed
from public.trips t
left join public.ride_requests r on r.trip_id = t.id
where t.cancelled_at is null
group by t.id;

commit;
