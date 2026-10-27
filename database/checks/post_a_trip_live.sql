-- Live SQL regression check. Run as postgres in a FRESH Hitch development project.
-- Synthetic Auth rows and trips exist ONLY inside this transaction; ROLLBACK removes them.
-- This checks database roles/RLS, not Auth login or the browser UI.
begin;
insert into auth.users (id, email) values
 ('a81e5a01-1111-4111-8111-111111111111', 'hitch-schema-a@example.invalid'),
 ('a81e5a01-2222-4222-8222-222222222222', 'hitch-schema-b@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub','a81e5a01-1111-4111-8111-111111111111',true);

insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at) values ('moab', now()+interval '1 day', 'Class demo pickup', 'Class demo dropoff', 3, 25, null);
insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at) values ('moab', now()+interval '1 day', 'Class demo pickup', 'Class demo dropoff', 3, 25, now()+interval '2 days');


do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at) values ('moab', now()+interval '1 day', 'Class demo pickup', 'Class demo dropoff', 0, 25, null);
  raise exception 'Expected check_violation was not raised';
exception when check_violation then null; end $$;

do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at) values ('moab', now()+interval '1 day', 'Class demo pickup', 'Class demo dropoff', 8, 25, null);
  raise exception 'Expected check_violation was not raised';
exception when check_violation then null; end $$;

do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at) values ('moab', now()+interval '1 day', 'Class demo pickup', 'Class demo dropoff', 3, 0, null);
  raise exception 'Expected check_violation was not raised';
exception when check_violation then null; end $$;

do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at) values ('moab', now()+interval '1 day', 'Class demo pickup', 'Class demo dropoff', 3, 151, null);
  raise exception 'Expected check_violation was not raised';
exception when check_violation then null; end $$;

do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at) values ('moab', now()+interval '1 day', '   ', 'Class demo dropoff', 3, 25, null);
  raise exception 'Expected check_violation was not raised';
exception when check_violation then null; end $$;

do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at) values ('moab', now()+interval '1 day', 'Class demo pickup', '', 3, 25, null);
  raise exception 'Expected check_violation was not raised';
exception when check_violation then null; end $$;

do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at) values ('moab', now()-interval '1 day', 'Class demo pickup', 'Class demo dropoff', 3, 25, null);
  raise exception 'Expected check_violation was not raised';
exception when check_violation then null; end $$;

do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at) values ('moab', now()+interval '1 day', 'Class demo pickup', 'Class demo dropoff', 3, 25, now()+interval '1 day');
  raise exception 'Expected check_violation was not raised';
exception when check_violation then null; end $$;

do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at) values ('unknown', now()+interval '1 day', 'Class demo pickup', 'Class demo dropoff', 3, 25, null);
  raise exception 'Expected foreign_key_violation was not raised';
exception when foreign_key_violation then null; end $$;

do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at) values ('moab', null, 'Class demo pickup', 'Class demo dropoff', 3, 25, null);
  raise exception 'Expected not_null_violation was not raised';
exception when not_null_violation then null; end $$;

do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at, driver_id) values ('moab', now()+interval '1 day', 'Class demo pickup', 'Class demo dropoff', 3, 25, null, 'a81e5a01-2222-4222-8222-222222222222');
  raise exception 'Expected insufficient_privilege was not raised';
exception when insufficient_privilege then null; end $$;

do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at) values ('moab', now()+interval '1 day', 'Class demo pickup', 'Class demo dropoff', '1.5', 25, null);
  raise exception 'Expected invalid_text_representation was not raised';
exception when invalid_text_representation then null; end $$;

do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at) values ('moab', now()+interval '1 day', 'Class demo pickup', 'Class demo dropoff', 3, '1.5', null);
  raise exception 'Expected invalid_text_representation was not raised';
exception when invalid_text_representation then null; end $$;

do $$ begin
  update public.trips set total_seats=2;
  raise exception 'Expected insufficient_privilege was not raised';
exception when insufficient_privilege then null; end $$;

do $$ begin
  delete from public.trips;
  raise exception 'Expected insufficient_privilege was not raised';
exception when insufficient_privilege then null; end $$;

do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at, created_at) values ('moab', now()+interval '1 day', 'Class demo pickup', 'Class demo dropoff', 3, 25, null, now());
  raise exception 'Expected insufficient_privilege was not raised';
exception when insufficient_privilege then null; end $$;

select set_config('request.jwt.claim.sub','a81e5a01-2222-4222-8222-222222222222',true);
do $$ begin
 if (select count(*) from public.trips where driver_id='a81e5a01-1111-4111-8111-111111111111') <> 2 then
  raise exception 'Second user could not read both saved trips'; end if;
 if (select count(*) from public.destinations) <> 8 then
  raise exception 'Expected eight destinations'; end if;
end $$;
set local role anon;
select set_config('request.jwt.claim.sub','',true);

do $$ begin
  perform * from public.trips;
  raise exception 'Expected insufficient_privilege was not raised';
exception when insufficient_privilege then null; end $$;

do $$ begin
  insert into public.trips (destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat, return_at) values ('moab', now()+interval '1 day', 'Class demo pickup', 'Class demo dropoff', 3, 25, null);
  raise exception 'Expected insufficient_privilege was not raised';
exception when insufficient_privilege then null; end $$;

rollback;
select 'PASS: live constraints and RLS checks; all synthetic rows rolled back' as verification;
