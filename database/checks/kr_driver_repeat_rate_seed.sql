-- Test data for the driver repeat-rate KR. Run as postgres in the Supabase SQL Editor
-- after 20261101000100_kr_driver_repeat_rate.sql and 20261119000100_kr_repeat_drivers_any.sql.
-- Synthetic drivers and trips exist ONLY inside this transaction; ROLLBACK removes them.
-- Real trips are ignored by the check.
--   A: two trips (60 and 45 days ago)  -> repeat
--   B: two trips (50 and 10 days ago)  -> repeat (any gap counts)
--   C: one trip 40 days ago            -> not repeat
--   D: one trip 5 days ago             -> counted, not repeat
-- Expected: 4 drivers, 2 repeat, 50.0%.
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
  if eligible <> 4 or repeats <> 2 or round(100.0 * repeats / eligible, 1) <> 50.0 then
    raise exception 'Expected 4 drivers, 2 repeat, 50.0%%; got %, %', eligible, repeats;
  end if;
  if not (select is_repeat from public.kr_driver_repeat_rate where driver_id = '00000000-0000-4000-8000-00000000000a') then
    raise exception 'Driver A should be a repeat driver';
  end if;
  if (select is_repeat from public.kr_driver_repeat_rate where driver_id = '00000000-0000-4000-8000-00000000000d') then
    raise exception 'Driver D has one trip and should not be a repeat driver';
  end if;
end $$;

rollback;
select 'PASS: 4 drivers, 2 repeat, 50.0%; all synthetic rows rolled back' as verification;
