-- Apply once through the Supabase SQL Editor (runs as postgres), after 20261115000100_cancel_request_or_trip.sql.
-- Repair: the live database never got 20261109000100_accept_decline_requests.sql, so requests had no
-- update grant, no driver update policy, no decision trigger and no KR summary view. Re-running that
-- file now would fail partway, because the cancel migration already created some of the same objects.
-- This adds only what is missing, so it is safe on a database where accept/decline did run (no changes).
begin;

grant update (status) on public.ride_requests to authenticated;

do $$
begin
  -- Drivers update requests on their own trips. Anyone else's update matches no rows.
  if not exists (select 1 from pg_policies
                 where schemaname = 'public' and tablename = 'ride_requests' and policyname = 'ride_requests_driver_decides') then
    create policy ride_requests_driver_decides on public.ride_requests
    for update to authenticated
    using (exists (select 1 from public.trips t where t.id = trip_id and t.driver_id = (select auth.uid())))
    with check (exists (select 1 from public.trips t where t.id = trip_id and t.driver_id = (select auth.uid())));
  end if;
  -- The function (driver-only accept/decline, no overbooking, rider-only cancel) was created by the
  -- cancel migration; attach it.
  if not exists (select 1 from pg_trigger
                 where tgrelid = 'public.ride_requests'::regclass and tgname = 'check_ride_request_decision' and not tgisinternal) then
    create trigger check_ride_request_decision
    before update of status on public.ride_requests
    for each row execute function public.check_ride_request_decision();
  end if;
end $$;

-- Objective 2 seat-fill KR summary (same definition as 20261109000100).
create or replace view public.kr_seat_fill_rate_summary with (security_invoker = true) as
select count(*) as departed_trips, round(avg(fill_rate), 4) as avg_fill_rate
from public.kr_seat_fill_rate
where has_departed;

-- Internal metrics: readable from the SQL Editor only, never through the Data API.
revoke all on public.kr_seat_fill_rate, public.kr_seat_fill_rate_summary
from public, anon, authenticated;

commit;
