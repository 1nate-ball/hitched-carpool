-- Live role/RLS regression only; all synthetic users, trips and requests are rolled back.
-- Does not prove password sign-in or browser persistence.
begin;
-- Drivers must be verified (confirmed byu.edu email) since 20261108000100_driver_verification.sql.
insert into auth.users(id,email,email_confirmed_at) values
 ('b81e5a01-1111-4111-8111-111111111111','hitch-check-a@byu.edu', now()),
 ('b81e5a01-2222-4222-8222-222222222222','hitch-check-b@byu.edu', now()),
 ('b81e5a01-3333-4333-8333-333333333333','hitch-check-c@byu.edu', now());
set local role authenticated;
select set_config('request.jwt.claim.sub','b81e5a01-1111-4111-8111-111111111111',true);
insert into public.trips(destination_id,departure_at,pickup_location,dropoff_location,total_seats,price_per_seat,origin_city,pickup_latitude,pickup_longitude,dropoff_latitude,dropoff_longitude)
 values('moab',now()+interval '7 days','Sprint 2 rollback check','Moab',1,25,'Provo',40.2485,-111.6472,38.5733,-109.5498);
do $$ begin
 if not exists(select 1 from public.trips where driver_id=auth.uid() and pickup_location='Sprint 2 rollback check') then raise exception 'wrong driver'; end if;
 update public.trips set origin_city='Orem' where pickup_location='Sprint 2 rollback check';
 if not exists(select 1 from public.available_trips where pickup_location='Sprint 2 rollback check' and origin_city='Orem' and seats_available=1) then raise exception 'owner update/search failed'; end if;
end $$;
do $$ begin
 update public.trips set driver_id='b81e5a01-2222-4222-8222-222222222222' where pickup_location='Sprint 2 rollback check';
 raise exception 'driver spoof accepted';
exception when insufficient_privilege then null; end $$;
do $$ begin
 update public.trips set pickup_latitude=91 where pickup_location='Sprint 2 rollback check';
 raise exception 'invalid pin accepted';
exception when check_violation then null; end $$;
select set_config('request.jwt.claim.sub','b81e5a01-2222-4222-8222-222222222222',true);
do $$ declare affected integer; begin
 update public.trips set origin_city='Unauthorized' where pickup_location='Sprint 2 rollback check';
 get diagnostics affected=row_count;
 if affected<>0 then raise exception 'other driver could edit'; end if;
end $$;
reset role;
insert into public.ride_requests(trip_id,rider_id,status,note)
 select id,'b81e5a01-2222-4222-8222-222222222222','accepted','Private test note' from public.trips where pickup_location='Sprint 2 rollback check';
set local role authenticated;
select set_config('request.jwt.claim.sub','b81e5a01-3333-4333-8333-333333333333',true);
do $$ begin
 if exists(select 1 from public.available_trips where pickup_location='Sprint 2 rollback check') then raise exception 'full trip is searchable'; end if;
 if exists(select 1 from public.ride_requests where note='Private test note') then raise exception 'private rider data leaked'; end if;
 if (select count(*) from public.locations)<>13 then raise exception 'place list missing'; end if;
end $$;
set local role anon;
do $$ begin perform * from public.available_trips; raise exception 'anonymous trip access'; exception when insufficient_privilege then null; end $$;
do $$ begin perform * from public.locations; raise exception 'anonymous place access'; exception when insufficient_privilege then null; end $$;
rollback;
select 'PASS: driver ownership, owner-only edits, pin validation, private request data, full-trip filtering and signed-out access. Synthetic rows rolled back.' as result;
