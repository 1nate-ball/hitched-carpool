-- Apply once through the Supabase SQL Editor (runs as postgres), after 20261116000100_seat_fill_stats.sql.
-- All four Key Results on the admin-only Hitch stats page, computed live on every call from the
-- private KR views (which read trips, ride_requests and auth.users). One row per Key Result.
-- Returns counts and rates only: no ids, names or emails. Refuses anyone not in public.admins.
-- A KR whose view hasn't been created in this database comes back with ready = false instead of
-- breaking the whole page.
-- Intentionally fails on name collisions, like the earlier migrations.
begin;

create function public.okr_stats()
returns table (
  kr text,                 -- stable key the app uses
  objective integer,
  title text,
  current_value numeric,   -- 0..1, null when nothing is eligible yet
  target numeric,          -- 0..1
  numerator integer,
  denominator integer,
  ready boolean,           -- false: this KR's view isn't in the database yet
  computed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  n integer;
  d integer;
  v numeric;
begin
  if not exists (select 1 from public.admins where user_id = (select auth.uid())) then
    raise exception 'Only Hitch admins can see stats.' using errcode = '42501';
  end if;

  -- Objective 1, KR 1: 100% of drivers (anyone who posted a trip) have a confirmed BYU email.
  if to_regclass('public.kr_driver_verification_summary') is null then
    return query select 'drivers_verified', 1, '100% of drivers are verified', null::numeric, 1.0, null::integer, null::integer, false, now();
  else
    execute 'select verified_drivers::integer, drivers::integer from public.kr_driver_verification_summary' into n, d;
    return query select 'drivers_verified', 1, '100% of drivers are verified',
      case when d > 0 then round(n::numeric / d, 4) end, 1.0, n, d, true, now();
  end if;

  -- Objective 1, KR 2: 100% of posted trips are linked to a signed-in driver account.
  if to_regclass('public.kr_trip_driver_link_summary') is null then
    return query select 'trips_linked', 1, '100% of posted trips are linked to a driver account', null::numeric, 1.0, null::integer, null::integer, false, now();
  else
    execute 'select linked_trips::integer, trips::integer from public.kr_trip_driver_link_summary' into n, d;
    return query select 'trips_linked', 1, '100% of posted trips are linked to a driver account',
      case when d > 0 then round(n::numeric / d, 4) end, 1.0, n, d, true, now();
  end if;

  -- Objective 2: posted trips average 70% of seats filled (average of per-trip rates, departed trips).
  -- numerator/denominator are accepted seats / total seats across those trips.
  if to_regclass('public.kr_seat_fill_rate') is null then
    return query select 'seat_fill', 2, 'Posted trips average 70% of seats filled', null::numeric, 0.70, null::integer, null::integer, false, now();
  else
    execute 'select round(avg(fill_rate), 4), coalesce(sum(least(accepted_seats, seats_total)), 0)::integer, coalesce(sum(seats_total), 0)::integer
             from public.kr_seat_fill_rate where has_departed' into v, n, d;
    return query select 'seat_fill', 2, 'Posted trips average 70% of seats filled', v, 0.70, n, d, true, now();
  end if;

  -- Objective 2: 50% of drivers post a second trip within 30 days of their first
  -- (only drivers whose first trip is 30+ days old are eligible).
  if to_regclass('public.kr_driver_repeat_rate_summary') is null then
    return query select 'repeat_drivers', 2, '50% of drivers post a second trip within 30 days', null::numeric, 0.50, null::integer, null::integer, false, now();
  else
    execute 'select repeat_drivers::integer, eligible_drivers::integer from public.kr_driver_repeat_rate_summary' into n, d;
    return query select 'repeat_drivers', 2, '50% of drivers post a second trip within 30 days',
      case when d > 0 then round(n::numeric / d, 4) end, 0.50, n, d, true, now();
  end if;
end;
$$;
revoke all on function public.okr_stats() from public, anon, authenticated;
grant execute on function public.okr_stats() to authenticated;

commit;
