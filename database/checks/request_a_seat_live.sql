-- Live SQL regression check for ride_requests. Run as postgres in the Hitch Supabase SQL Editor
-- after applying 20261104000100_request_a_seat.sql.
-- Synthetic Auth rows, trips and requests exist ONLY inside this transaction; ROLLBACK removes them.
-- This checks database roles/RLS, not Auth login or the browser UI.
begin;
insert into auth.users (id, email) values
 ('a81e5a02-1111-4111-8111-111111111111', 'hitch-request-driver@example.invalid'),
 ('a81e5a02-2222-4222-8222-222222222222', 'hitch-request-rider@example.invalid'),
 ('a81e5a02-3333-4333-8333-333333333333', 'hitch-request-other@example.invalid');
insert into public.trips (id, driver_id, destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat)
values ('a81e5a02-7777-4777-8777-777777777777', 'a81e5a02-1111-4111-8111-111111111111', 'moab', now()+interval '1 day', 'Class demo pickup', 'Class demo dropoff', 3, 25);
set local role authenticated;

-- Driver can't request their own trip.
select set_config('request.jwt.claim.sub','a81e5a02-1111-4111-8111-111111111111',true);
do $$ begin
  insert into public.ride_requests (trip_id, note) values ('a81e5a02-7777-4777-8777-777777777777', '');
  raise exception 'Expected insufficient_privilege was not raised';
exception when insufficient_privilege then null; end $$;

-- Rider can't choose status or rider_id.
select set_config('request.jwt.claim.sub','a81e5a02-2222-4222-8222-222222222222',true);
do $$ begin
  insert into public.ride_requests (trip_id, status) values ('a81e5a02-7777-4777-8777-777777777777', 'accepted');
  raise exception 'Expected insufficient_privilege was not raised';
exception when insufficient_privilege then null; end $$;

do $$ begin
  insert into public.ride_requests (trip_id, rider_id) values ('a81e5a02-7777-4777-8777-777777777777', 'a81e5a02-3333-4333-8333-333333333333');
  raise exception 'Expected insufficient_privilege was not raised';
exception when insufficient_privilege then null; end $$;

do $$ begin
  insert into public.ride_requests (trip_id, note) values ('a81e5a02-7777-4777-8777-777777777777', repeat('a', 301));
  raise exception 'Expected check_violation was not raised';
exception when check_violation then null; end $$;

-- Rider requests once: saved as pending under their own id.
insert into public.ride_requests (trip_id, note) values ('a81e5a02-7777-4777-8777-777777777777', 'Class demo note');
do $$ begin
  if not exists (select 1 from public.ride_requests
    where trip_id='a81e5a02-7777-4777-8777-777777777777'
      and rider_id='a81e5a02-2222-4222-8222-222222222222' and status='pending' and note='Class demo note') then
    raise exception 'Request was not saved as pending for the signed-in rider'; end if;
end $$;

-- Second request for the same trip is rejected.
do $$ begin
  insert into public.ride_requests (trip_id, note) values ('a81e5a02-7777-4777-8777-777777777777', 'again');
  raise exception 'Expected unique_violation was not raised';
exception when unique_violation then null; end $$;

do $$ begin
  update public.ride_requests set status='accepted';
  raise exception 'Expected insufficient_privilege was not raised';
exception when insufficient_privilege then null; end $$;

-- Driver sees the request; an unrelated user doesn't.
select set_config('request.jwt.claim.sub','a81e5a02-1111-4111-8111-111111111111',true);
do $$ begin
  if (select count(*) from public.ride_requests where trip_id='a81e5a02-7777-4777-8777-777777777777') <> 1 then
    raise exception 'Driver could not see the request on their trip'; end if;
end $$;
select set_config('request.jwt.claim.sub','a81e5a02-3333-4333-8333-333333333333',true);
do $$ begin
  if (select count(*) from public.ride_requests where trip_id='a81e5a02-7777-4777-8777-777777777777') <> 0 then
    raise exception 'Unrelated user could see another rider''s request'; end if;
end $$;

set local role anon;
select set_config('request.jwt.claim.sub','',true);
do $$ begin
  perform * from public.ride_requests;
  raise exception 'Expected insufficient_privilege was not raised';
exception when insufficient_privilege then null; end $$;

rollback;
select 'PASS: ride_requests constraints and RLS checks; all synthetic rows rolled back' as verification;
