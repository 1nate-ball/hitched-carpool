-- Test data for the driver repeat-rate KR. Run as postgres in the Supabase SQL Editor
-- after 20261101000100_kr_driver_repeat_rate.sql. Synthetic drivers and trips exist
-- ONLY inside this transaction; ROLLBACK removes them. Real trips are ignored by the check.
--   A: first trip 60 days ago, second 45 days ago -> repeat
--   B: first trip 50 days ago, second 10 days ago -> not repeat (gap > 30 days)
--   C: one trip 40 days ago                       -> not repeat
--   D: first trip 5 days ago                      -> not eligible yet
-- Expected: 3 eligible, 1 repeat, 33.3%.
begin;
insert into auth.users (id, email) values
 ('00000000-0000-4000-8000-00000000000a', 'hitch-kr-a@example.invalid'),
 ('00000000-0000-4000-8000-00000000000b', 'hitch-kr-b@example.invalid'),
 ('00000000-0000-4000-8000-00000000000c', 'hitch-kr-c@example.invalid'),
 ('00000000-0000-4000-8000-00000000000d', 'hitch-kr-d@example.invalid');

-- created_at is backdated; departure_at stays in the future to satisfy the insert trigger.
insert into public.trips (driver_id, destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, created_at) values
 ('00000000-0000-4000-8000-00000000000a', 'moab', now()+interval '1 day', 'KR test pickup', 'KR test dropoff', 3, 25, now()-interval '60 days'),
 ('00000000-0000-4000-8000-00000000000a', 'moab', now()+interval '1 day', 'KR test pickup', 'KR test dropoff', 3, 25, now()-interval '45 days'),
 ('00000000-0000-4000-8000-00000000000b', 'zion', now()+interval '1 day', 'KR test pickup', 'KR test dropoff', 3, 25, now()-interval '50 days'),
 ('00000000-0000-4000-8000-00000000000b', 'zion', now()+interval '1 day', 'KR test pickup', 'KR test dropoff', 3, 25, now()-interval '10 days'),
 ('00000000-0000-4000-8000-00000000000c', 'slc',  now()+interval '1 day', 'KR test pickup', 'KR test dropoff', 3, 25, now()-interval '40 days'),
 ('00000000-0000-4000-8000-00000000000d', 'slc',  now()+interval '1 day', 'KR test pickup', 'KR test dropoff', 3, 25, now()-interval '5 days');

do $$
declare
  eligible int;
  repeats int;
begin
  select count(*), count(*) filter (where is_repeat) into eligible, repeats
  from public.kr_driver_repeat_rate
  where driver_id::text like '00000000-0000-4000-8000-00000000000_';
  if eligible <> 3 or repeats <> 1 or round(100.0 * repeats / eligible, 1) <> 33.3 then
    raise exception 'Expected 3 eligible, 1 repeat, 33.3%%; got %, %', eligible, repeats;
  end if;
  if not (select is_repeat from public.kr_driver_repeat_rate where driver_id = '00000000-0000-4000-8000-00000000000a') then
    raise exception 'Driver A should be a repeat driver';
  end if;
  if exists (select 1 from public.kr_driver_repeat_rate where driver_id = '00000000-0000-4000-8000-00000000000d') then
    raise exception 'Driver D should not be eligible yet';
  end if;
end $$;

rollback;
select 'PASS: 3 eligible, 1 repeat, 33.3%; all synthetic rows rolled back' as verification;
