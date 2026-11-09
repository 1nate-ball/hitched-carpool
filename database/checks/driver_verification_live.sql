-- Live check for Objective 1 KR1 (verified drivers). Run as postgres in the Hitch Supabase SQL Editor
-- after applying 20261108000100_driver_verification.sql.
-- Synthetic Auth rows and trips exist ONLY inside this transaction; ROLLBACK removes them.
--   A: confirmed byu.edu email      -> verified, can post
--   B: byu.edu email, not confirmed -> not verified, blocked
--   C: confirmed gmail.com email    -> not verified, blocked
begin;
insert into auth.users (id, email, email_confirmed_at) values
 ('c81e5a01-1111-4111-8111-111111111111', 'hitch-verify-a@byu.edu', now()),
 ('c81e5a01-2222-4222-8222-222222222222', 'hitch-verify-b@byu.edu', null),
 ('c81e5a01-3333-4333-8333-333333333333', 'hitch-verify-c@gmail.com', now());
set local role authenticated;

select set_config('request.jwt.claim.sub','c81e5a01-1111-4111-8111-111111111111',true);
insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat)
values ('moab', now()+interval '1 day', 'Verification check pickup', 'Verification check dropoff', 3, 25);

select set_config('request.jwt.claim.sub','c81e5a01-2222-4222-8222-222222222222',true);
do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat)
  values ('moab', now()+interval '1 day', 'Verification check pickup', 'Verification check dropoff', 3, 25);
  raise exception 'Unconfirmed BYU email was allowed to post';
exception when insufficient_privilege then null; end $$;

select set_config('request.jwt.claim.sub','c81e5a01-3333-4333-8333-333333333333',true);
do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat)
  values ('moab', now()+interval '1 day', 'Verification check pickup', 'Verification check dropoff', 3, 25);
  raise exception 'Non-BYU email was allowed to post';
exception when insufficient_privilege then null; end $$;

do $$ begin
  if (select count(*) from public.verification_status(array[
        'c81e5a01-1111-4111-8111-111111111111','c81e5a01-2222-4222-8222-222222222222','c81e5a01-3333-4333-8333-333333333333']::uuid[])
      where is_verified) <> 1 then
    raise exception 'Expected exactly one of the three test users to be verified'; end if;
end $$;

do $$ begin
  perform * from public.kr_driver_verification_summary;
  raise exception 'Signed-in users should not be able to read the KR view';
exception when insufficient_privilege then null; end $$;

reset role;
do $$ begin
  if not (select is_verified from public.kr_driver_verification where driver_id = 'c81e5a01-1111-4111-8111-111111111111') then
    raise exception 'Test driver A should count as verified in the KR view'; end if;
end $$;

rollback;
select 'PASS: only verified users can post; KR view and badge lookup work; all synthetic rows rolled back' as verification;
