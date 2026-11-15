-- Live check for cancelling a seat request or a posted trip. Run as postgres in the Hitch Supabase
-- SQL Editor after applying 20261115000100_cancel_request_or_trip.sql.
-- Synthetic Auth rows, a 1-seat trip and two requests exist ONLY inside this transaction; ROLLBACK removes them.
-- Test users have confirmed byu.edu emails so this also passes with driver verification applied.
begin;
insert into auth.users (id, email, email_confirmed_at) values
 ('ca9ce101-1111-4111-8111-111111111111', 'hitch-cancel-driver@byu.edu', now()),
 ('ca9ce101-2222-4222-8222-222222222222', 'hitch-cancel-rider1@byu.edu', now()),
 ('ca9ce101-3333-4333-8333-333333333333', 'hitch-cancel-rider2@byu.edu', now());
insert into public.trips (id, driver_id, destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat)
values ('ca9ce101-7777-4777-8777-777777777777', 'ca9ce101-1111-4111-8111-111111111111', 'moab', now()+interval '1 day', 'Cancel check pickup', 'Cancel check dropoff', 1, 25);
insert into public.ride_requests (trip_id, rider_id, note, status) values
 ('ca9ce101-7777-4777-8777-777777777777', 'ca9ce101-2222-4222-8222-222222222222', '', 'accepted'),
 ('ca9ce101-7777-4777-8777-777777777777', 'ca9ce101-3333-4333-8333-333333333333', '', 'pending');
set local role authenticated;

-- The trip is full, so it isn't in search.
select set_config('request.jwt.claim.sub','ca9ce101-3333-4333-8333-333333333333',true);
do $$ begin
  if exists (select 1 from public.available_trips where id = 'ca9ce101-7777-4777-8777-777777777777') then
    raise exception 'Full trip shows in search'; end if;
end $$;

-- Rider 2 can't cancel rider 1's seat (the update matches no rows) and can't accept themselves.
update public.ride_requests set status = 'cancelled' where rider_id = 'ca9ce101-2222-4222-8222-222222222222';
do $$ begin
  update public.ride_requests set status = 'accepted' where rider_id = 'ca9ce101-3333-4333-8333-333333333333';
  raise exception 'A rider accepted their own request';
exception when insufficient_privilege then null; end $$;

-- Rider 1 cancels their accepted seat: the seat goes back and the trip returns to search.
select set_config('request.jwt.claim.sub','ca9ce101-2222-4222-8222-222222222222',true);
update public.ride_requests set status = 'cancelled' where rider_id = 'ca9ce101-2222-4222-8222-222222222222';
do $$ begin
  if (select status from public.ride_requests where rider_id = 'ca9ce101-2222-4222-8222-222222222222') <> 'cancelled' then
    raise exception 'Rider could not cancel their seat'; end if;
  if coalesce((select seats_available from public.available_trips where id = 'ca9ce101-7777-4777-8777-777777777777'), 0) <> 1 then
    raise exception 'Cancelled seat was not given back'; end if;
end $$;
-- Cancelling is final.
do $$ begin
  update public.ride_requests set status = 'cancelled' where rider_id = 'ca9ce101-2222-4222-8222-222222222222';
  raise exception 'Cancelled the same request twice';
exception when check_violation then null; end $$;

-- A rider can't cancel the trip (the update matches no rows).
update public.trips set cancelled_at = now() where id = 'ca9ce101-7777-4777-8777-777777777777';
do $$ begin
  if (select cancelled_at from public.trips where id = 'ca9ce101-7777-4777-8777-777777777777') is not null then
    raise exception 'A rider cancelled the trip'; end if;
end $$;

-- The driver cancels the trip: it leaves search and takes no more decisions.
select set_config('request.jwt.claim.sub','ca9ce101-1111-4111-8111-111111111111',true);
update public.trips set cancelled_at = now() where id = 'ca9ce101-7777-4777-8777-777777777777';
do $$ begin
  if (select cancelled_at from public.trips where id = 'ca9ce101-7777-4777-8777-777777777777') is null then
    raise exception 'Driver could not cancel the trip'; end if;
  if exists (select 1 from public.available_trips where id = 'ca9ce101-7777-4777-8777-777777777777') then
    raise exception 'Cancelled trip still shows in search'; end if;
end $$;
do $$ begin
  update public.ride_requests set status = 'accepted' where rider_id = 'ca9ce101-3333-4333-8333-333333333333';
  raise exception 'Accepted a request on a cancelled trip';
exception when check_violation then null; end $$;
do $$ begin
  update public.trips set cancelled_at = null where id = 'ca9ce101-7777-4777-8777-777777777777';
  raise exception 'Un-cancelled a trip';
exception when check_violation then null; end $$;

reset role;
do $$ begin
  if exists (select 1 from public.kr_seat_fill_rate where trip_id = 'ca9ce101-7777-4777-8777-777777777777') then
    raise exception 'Seat-fill KR counts a cancelled trip'; end if;
end $$;

rollback;
select 'PASS: rider cancels own request and gets the seat back; driver-only trip cancel; final; leaves search and KR; all synthetic rows rolled back' as verification;
