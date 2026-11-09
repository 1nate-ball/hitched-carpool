-- Live check for Objective 1 KR2 (no anonymous trips). Run as postgres in the Hitch Supabase SQL Editor
-- after applying 20261108000200_kr_trips_linked_to_driver.sql.
-- Synthetic Auth rows and trips exist ONLY inside this transaction; ROLLBACK removes them.
-- Test users have confirmed byu.edu emails so this also passes once driver verification is applied.
begin;
insert into auth.users (id, email, email_confirmed_at) values
 ('d81e5a01-1111-4111-8111-111111111111', 'hitch-link-a@byu.edu', now()),
 ('d81e5a01-2222-4222-8222-222222222222', 'hitch-link-b@byu.edu', now());

-- Even postgres can't save a trip with no driver or a driver account that doesn't exist.
do $$ begin
  insert into public.trips (driver_id, destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat)
  values (null, 'moab', now()+interval '1 day', 'KR2 check pickup', 'KR2 check dropoff', 3, 25);
  raise exception 'A trip with no driver was saved';
exception when not_null_violation then null; end $$;

do $$ begin
  insert into public.trips (driver_id, destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat)
  values ('d81e5a01-9999-4999-8999-999999999999', 'moab', now()+interval '1 day', 'KR2 check pickup', 'KR2 check dropoff', 3, 25);
  raise exception 'A trip with a non-existent driver account was saved';
exception when foreign_key_violation then null; end $$;

-- Anonymous visitors can't post.
set local role anon;
select set_config('request.jwt.claim.sub','',true);
do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat)
  values ('moab', now()+interval '1 day', 'KR2 check pickup', 'KR2 check dropoff', 3, 25);
  raise exception 'An anonymous trip was saved';
exception when insufficient_privilege then null; end $$;

-- A signed-in driver's trip is linked to their account automatically.
set local role authenticated;
select set_config('request.jwt.claim.sub','d81e5a01-1111-4111-8111-111111111111',true);
insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat)
values ('moab', now()+interval '1 day', 'KR2 check pickup', 'KR2 check dropoff', 3, 25);
do $$ begin
  if (select driver_id from public.trips where pickup_location = 'KR2 check pickup') <> 'd81e5a01-1111-4111-8111-111111111111' then
    raise exception 'Trip was not linked to the signed-in driver'; end if;
end $$;

-- They can't move it to someone else's account or unlink it.
do $$ begin
  update public.trips set driver_id = 'd81e5a01-2222-4222-8222-222222222222' where pickup_location = 'KR2 check pickup';
  raise exception 'Trip was moved to another account';
exception when insufficient_privilege then null; end $$;

-- An account with trips can't be deleted.
reset role;
do $$ begin
  delete from auth.users where id = 'd81e5a01-1111-4111-8111-111111111111';
  raise exception 'Account with trips was deleted';
exception when foreign_key_violation then null; end $$;

do $$ begin
  if not (select is_linked from public.kr_trip_driver_link
          where driver_id = 'd81e5a01-1111-4111-8111-111111111111') then
    raise exception 'KR view did not count the test trip as linked'; end if;
end $$;

rollback;
select 'PASS: no anonymous, ownerless or reassigned trips; KR view works; all synthetic rows rolled back' as verification;
