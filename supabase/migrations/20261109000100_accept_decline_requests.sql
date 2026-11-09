-- Apply once through the Supabase SQL Editor (runs as postgres), after the earlier migrations.
-- Driver accepts or declines seat requests; seats left updates.
--   * Only the trip's driver can change a request, and only its status.
--   * Only pending requests can be decided: pending -> accepted or declined, once.
--   * A trip can't have more accepted requests than seats, even with two accepts at the same moment.
-- Seats left and "full trips disappear from search" come from public.available_trips
-- (20261106000100), which already counts accepted requests.
-- Also adds the Objective 2 seat-fill KR views for Supabase trips.
-- Intentionally fails on name collisions, like the earlier migrations.
begin;

grant update (status) on public.ride_requests to authenticated;

-- Drivers update requests on their own trips. Anyone else's update matches no rows.
create policy ride_requests_driver_decides on public.ride_requests
for update to authenticated
using (exists (select 1 from public.trips t where t.id = trip_id and t.driver_id = (select auth.uid())))
with check (exists (select 1 from public.trips t where t.id = trip_id and t.driver_id = (select auth.uid())));

-- SECURITY DEFINER so it can lock the trip row and count every accepted request on it,
-- not just the ones the caller can see. It only reads; it never changes other rows.
create function public.check_ride_request_decision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  seats integer;
  taken integer;
begin
  if new.status is not distinct from old.status then
    return new;
  end if;
  if old.status <> 'pending' or new.status not in ('accepted', 'declined') then
    raise exception 'This request was already %.', old.status using errcode = '23514';
  end if;
  if new.status = 'accepted' then
    -- Lock the trip so two accepts for its last seat can't both succeed.
    select total_seats into seats from public.trips where id = new.trip_id for update;
    select count(*) into taken from public.ride_requests
      where trip_id = new.trip_id and status = 'accepted';
    if taken >= seats then
      raise exception 'This trip is full.' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.check_ride_request_decision() from public, anon, authenticated;

create trigger check_ride_request_decision
before update of status on public.ride_requests
for each row execute function public.check_ride_request_decision();

-- Objective 2 KR: posted trips average 70% of seats filled (same definition as the SQLite
-- kr_seat_fill_rate view): accepted seats / total seats per trip, capped at 100%,
-- averaged over trips that have already departed. One seat per request.
create view public.kr_seat_fill_rate with (security_invoker = true) as
select t.id as trip_id, t.total_seats as seats_total,
  count(r.id) filter (where r.status = 'accepted')::integer as accepted_seats,
  least(1.0, count(r.id) filter (where r.status = 'accepted')::numeric / t.total_seats) as fill_rate,
  t.departure_at <= now() as has_departed
from public.trips t
left join public.ride_requests r on r.trip_id = t.id
group by t.id;

create view public.kr_seat_fill_rate_summary with (security_invoker = true) as
select count(*) as departed_trips, round(avg(fill_rate), 4) as avg_fill_rate
from public.kr_seat_fill_rate
where has_departed;

-- Internal metric: readable from the SQL Editor only, never through the Data API.
revoke all on public.kr_seat_fill_rate, public.kr_seat_fill_rate_summary
from public, anon, authenticated;

commit;
