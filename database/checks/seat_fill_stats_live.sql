-- Live check for the admin seat fill stats. Run as postgres in the Hitch Supabase SQL Editor
-- after applying 20261116000100_seat_fill_stats.sql.
-- Synthetic users, an admin row, two departed test trips and their requests exist ONLY inside this
-- transaction; ROLLBACK removes them. Real data stays as it is, so this checks how the numbers CHANGE.
begin;
insert into auth.users (id, email, email_confirmed_at) values
 ('5ea7f111-1111-4111-8111-111111111111', 'hitch-stats-admin@byu.edu', now()),
 ('5ea7f111-2222-4222-8222-222222222222', 'hitch-stats-driver@byu.edu', now()),
 ('5ea7f111-3333-4333-8333-333333333333', 'hitch-stats-rider1@byu.edu', now()),
 ('5ea7f111-4444-4444-8444-444444444444', 'hitch-stats-rider2@byu.edu', now()),
 ('5ea7f111-5555-4555-8555-555555555555', 'hitch-stats-rider3@byu.edu', now());
insert into public.admins (user_id) values ('5ea7f111-1111-4111-8111-111111111111');

-- One block, so the "before" numbers stay in variables (no temporary table).
-- Test trip A: 4 seats, 3 accepted (0.75). Test trip B: 3 seats, 1 accepted + 1 declined (0.3333).
do $$
declare b record; a record;
begin
  -- Numbers before the test trips, read as the admin through the same function the app calls.
  perform set_config('request.jwt.claim.sub','5ea7f111-1111-4111-8111-111111111111',true);
  execute 'set local role authenticated';
  select * into b from public.seat_fill_stats();
  execute 'reset role';

  insert into public.trips (id, driver_id, destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat) values
   ('5ea7f111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '5ea7f111-2222-4222-8222-222222222222', 'moab', now()+interval '1 day', 'Stats check A', 'Moab', 4, 20),
   ('5ea7f111-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '5ea7f111-2222-4222-8222-222222222222', 'moab', now()+interval '1 day', 'Stats check B', 'Moab', 3, 20);
  insert into public.ride_requests (trip_id, rider_id, note, status) values
   ('5ea7f111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '5ea7f111-3333-4333-8333-333333333333', '', 'accepted'),
   ('5ea7f111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '5ea7f111-4444-4444-8444-444444444444', '', 'accepted'),
   ('5ea7f111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '5ea7f111-5555-4555-8555-555555555555', '', 'accepted'),
   ('5ea7f111-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '5ea7f111-3333-4333-8333-333333333333', '', 'accepted'),
   ('5ea7f111-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '5ea7f111-4444-4444-8444-444444444444', '', 'declined');
  update public.trips set departure_at = now() - interval '1 day'
  where id in ('5ea7f111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '5ea7f111-bbbb-4bbb-8bbb-bbbbbbbbbbbb');

  execute 'set local role authenticated';
  select * into a from public.seat_fill_stats();
  execute 'reset role';
  -- Two more departed trips, 4 more accepted seats, 7 more seats.
  if a.departed_trips <> b.departed_trips + 2 then raise exception 'departed_trips did not go up by 2'; end if;
  if a.departed_accepted_seats <> b.departed_accepted_seats + 4 then raise exception 'accepted seats did not go up by 4'; end if;
  if a.departed_total_seats <> b.departed_total_seats + 7 then raise exception 'total seats did not go up by 7'; end if;
  -- The average now includes the two test rates (0.75 and 0.3333), weighted per trip.
  if abs(a.avg_fill_rate - (coalesce(b.avg_fill_rate, 0) * b.departed_trips + 0.75 + 1.0/3) / (b.departed_trips + 2)) > 0.001 then
    raise exception 'avg_fill_rate % is not the per-trip average', a.avg_fill_rate; end if;
  if a.target_fill_rate <> 0.70 then raise exception 'target is not 70%%'; end if;
end $$;

set local role authenticated;
-- A non-admin is refused, and nobody can read the admin list through the API.
select set_config('request.jwt.claim.sub','5ea7f111-2222-4222-8222-222222222222',true);
do $$ begin
  if public.is_admin() then raise exception 'A non-admin is an admin'; end if;
  perform * from public.seat_fill_stats();
  raise exception 'A non-admin read the stats';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform * from public.admins;
  raise exception 'The admin list is readable through the API';
exception when insufficient_privilege then null; end $$;

rollback;
select 'PASS: admin-only live seat fill stats; per-trip KR average and seat totals move with accepted requests; all synthetic rows rolled back' as verification;
