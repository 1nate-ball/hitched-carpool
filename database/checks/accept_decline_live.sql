-- Live check for accept/decline. Run as postgres in the Hitch Supabase SQL Editor
-- after applying 20261109000100_accept_decline_requests.sql.
-- Synthetic Auth rows, a 1-seat trip and two requests exist ONLY inside this transaction; ROLLBACK removes them.
-- Test users have confirmed byu.edu emails so this also passes once driver verification is applied.
begin;
insert into auth.users (id, email, email_confirmed_at) values
 ('e81e5a01-1111-4111-8111-111111111111', 'hitch-decide-driver@byu.edu', now()),
 ('e81e5a01-2222-4222-8222-222222222222', 'hitch-decide-rider1@byu.edu', now()),
 ('e81e5a01-3333-4333-8333-333333333333', 'hitch-decide-rider2@byu.edu', now());
insert into public.trips (id, driver_id, destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat)
values ('e81e5a01-7777-4777-8777-777777777777', 'e81e5a01-1111-4111-8111-111111111111', 'moab', now()+interval '1 day', 'Decide check pickup', 'Decide check dropoff', 1, 25);
insert into public.ride_requests (trip_id, rider_id, note, status) values
 ('e81e5a01-7777-4777-8777-777777777777', 'e81e5a01-2222-4222-8222-222222222222', '', 'pending'),
 ('e81e5a01-7777-4777-8777-777777777777', 'e81e5a01-3333-4333-8333-333333333333', '', 'pending');
set local role authenticated;

-- A rider can't accept their own request (the update matches no rows).
select set_config('request.jwt.claim.sub','e81e5a01-2222-4222-8222-222222222222',true);
update public.ride_requests set status = 'accepted' where rider_id = 'e81e5a01-2222-4222-8222-222222222222';
do $$ begin
  if exists (select 1 from public.ride_requests where rider_id = 'e81e5a01-2222-4222-8222-222222222222' and status <> 'pending') then
    raise exception 'A rider changed their own request status'; end if;
end $$;

-- The driver sees both pending requests and accepts rider 1: the trip is now full.
select set_config('request.jwt.claim.sub','e81e5a01-1111-4111-8111-111111111111',true);
do $$ begin
  if (select count(*) from public.ride_requests where trip_id = 'e81e5a01-7777-4777-8777-777777777777' and status = 'pending') <> 2 then
    raise exception 'Driver could not see both pending requests'; end if;
end $$;
update public.ride_requests set status = 'accepted' where rider_id = 'e81e5a01-2222-4222-8222-222222222222';
do $$ begin
  if exists (select 1 from public.available_trips where id = 'e81e5a01-7777-4777-8777-777777777777') then
    raise exception 'Full trip still shows in search'; end if;
end $$;

-- No overbooking, and decisions are final.
do $$ begin
  update public.ride_requests set status = 'accepted' where rider_id = 'e81e5a01-3333-4333-8333-333333333333';
  raise exception 'Accepted a request on a full trip';
exception when check_violation then null; end $$;
do $$ begin
  update public.ride_requests set status = 'declined' where rider_id = 'e81e5a01-2222-4222-8222-222222222222';
  raise exception 'Changed a request that was already accepted';
exception when check_violation then null; end $$;

-- Declining still works, and the driver can only change the status.
update public.ride_requests set status = 'declined' where rider_id = 'e81e5a01-3333-4333-8333-333333333333';
do $$ begin
  update public.ride_requests set note = 'edited' where rider_id = 'e81e5a01-3333-4333-8333-333333333333';
  raise exception 'Driver edited a rider note';
exception when insufficient_privilege then null; end $$;

reset role;
do $$ begin
  if (select accepted_seats from public.kr_seat_fill_rate where trip_id = 'e81e5a01-7777-4777-8777-777777777777') <> 1 then
    raise exception 'Seat-fill KR view did not count the accepted seat'; end if;
end $$;

rollback;
select 'PASS: driver-only decisions, no overbooking, full trip leaves search, KR counts it; all synthetic rows rolled back' as verification;
