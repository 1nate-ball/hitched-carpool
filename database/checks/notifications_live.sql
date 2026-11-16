-- Live check for in-app notifications. Run as postgres in the Hitch Supabase SQL Editor after
-- applying 20261118000100_notifications.sql. Run the WHOLE file with nothing highlighted.
-- Synthetic users, a test trip, its requests and their notifications exist ONLY inside this
-- transaction; ROLLBACK removes them. Real data is never read or changed.
begin;
insert into auth.users (id, email, email_confirmed_at) values
 ('a0717f11-1111-4111-8111-111111111111', 'hitch-notify-driver@byu.edu', now()),
 ('a0717f11-2222-4222-8222-222222222222', 'hitch-notify-rider@byu.edu', now()),
 ('a0717f11-3333-4333-8333-333333333333', 'hitch-notify-other@byu.edu', now());
insert into public.trips (id, driver_id, destination_id, departure_at, pickup_location, dropoff_location, total_seats, price_per_seat) values
 ('a0717f11-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a0717f11-1111-4111-8111-111111111111', 'moab', now() + interval '3 days', 'Notify check', 'Moab', 2, 20);

do $$
declare
  req uuid;
  n integer;
  k text;
begin
  -- The rider requests a seat through the API role: the driver gets one alert, nobody else does.
  perform set_config('request.jwt.claim.sub', 'a0717f11-2222-4222-8222-222222222222', true);
  execute 'set local role authenticated';
  insert into public.ride_requests (trip_id, note) values ('a0717f11-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'notify check') returning id into req;
  select count(*) into n from public.my_notifications();
  if n <> 0 then raise exception 'The rider got an alert for their own request'; end if;

  perform set_config('request.jwt.claim.sub', 'a0717f11-1111-4111-8111-111111111111', true);
  select count(*), min(kind) into n, k from public.my_notifications() where request_id = req;
  if n <> 1 or k <> 'seat_requested' then raise exception 'The driver did not get exactly one seat request alert (got % %)', n, k; end if;

  -- The driver accepts: the rider gets one alert. Saving the same status again adds nothing.
  update public.ride_requests set status = 'accepted' where id = req;
  update public.ride_requests set status = 'accepted' where id = req;
  perform set_config('request.jwt.claim.sub', 'a0717f11-2222-4222-8222-222222222222', true);
  select count(*), min(kind) into n, k from public.my_notifications() where request_id = req;
  if n <> 1 or k <> 'request_accepted' then raise exception 'The rider did not get exactly one accepted alert (got % %)', n, k; end if;

  -- Another signed-in user sees none of them and can't mark them read.
  perform set_config('request.jwt.claim.sub', 'a0717f11-3333-4333-8333-333333333333', true);
  select count(*) into n from public.notifications where trip_id = 'a0717f11-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  if n <> 0 then raise exception 'Another user can read these notifications'; end if;
  if public.mark_notifications_read((select array_agg(id) from public.notifications)) <> 0 then
    raise exception 'Another user marked someone else''s notification read'; end if;

  -- The rider marks theirs read, and it stays read.
  perform set_config('request.jwt.claim.sub', 'a0717f11-2222-4222-8222-222222222222', true);
  if public.mark_notifications_read() <> 1 then raise exception 'Mark all read did not mark the rider''s alert'; end if;
  if exists (select 1 from public.my_notifications() where read_at is null) then raise exception 'The alert is still unread'; end if;

  -- Nobody can write notifications through the API.
  begin
    insert into public.notifications (recipient_id, kind, request_id, trip_id)
    values ('a0717f11-3333-4333-8333-333333333333', 'seat_requested', req, 'a0717f11-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    raise exception 'A user created a notification directly';
  exception when insufficient_privilege then null; end;
  execute 'reset role';
end $$;

rollback;
select 'PASS: seat requests alert the driver, decisions alert the rider, once each; only the recipient can read or mark them; all test rows rolled back' as verification;
