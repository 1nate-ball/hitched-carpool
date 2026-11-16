-- Live check for the admin OKR stats page. Run as postgres in the Hitch Supabase SQL Editor after
-- applying 20261117000100_okr_stats.sql. Run the WHOLE file with nothing highlighted.
-- A synthetic admin exists ONLY inside this transaction; ROLLBACK removes it. Real data is only read.
-- It checks that every Key Result is set up, and that the page's numbers match the KR views exactly.
begin;
insert into auth.users (id, email, email_confirmed_at) values
 ('0c4e5a11-1111-4111-8111-111111111111', 'hitch-okr-admin@byu.edu', now());
insert into public.admins (user_id) values ('0c4e5a11-1111-4111-8111-111111111111');

do $$
declare
  page jsonb;
  r jsonb;
  n integer;
  d integer;
  v numeric;
  needs constant jsonb := '{
    "drivers_verified": "20261108000100_driver_verification.sql",
    "trips_linked": "20261108000200_kr_trips_linked_to_driver.sql",
    "seat_fill": "20261115000100_cancel_request_or_trip.sql",
    "repeat_drivers": "20261101000100_kr_driver_repeat_rate.sql, then 20261119000100_kr_repeat_drivers_any.sql"}';
begin
  -- What the stats page gets, read as the admin through the same function the app calls.
  perform set_config('request.jwt.claim.sub','0c4e5a11-1111-4111-8111-111111111111',true);
  execute 'set local role authenticated';
  select jsonb_agg(to_jsonb(o)) into page from public.okr_stats() o;
  execute 'reset role';

  if jsonb_array_length(page) <> 4 then raise exception 'Expected 4 Key Results, got %', jsonb_array_length(page); end if;
  for r in select * from jsonb_array_elements(page) loop
    if not (r->>'ready')::boolean then
      raise exception 'Key Result % is not set up in this database. Run supabase/migrations/%, then run this check again.', r->>'kr', needs->>(r->>'kr');
    end if;
    -- The same numbers, read straight from the private KR views.
    if r->>'kr' = 'drivers_verified' then
      select verified_drivers, drivers into n, d from public.kr_driver_verification_summary;
    elsif r->>'kr' = 'trips_linked' then
      select linked_trips, trips into n, d from public.kr_trip_driver_link_summary;
    elsif r->>'kr' = 'repeat_drivers' then
      select repeat_drivers, eligible_drivers into n, d from public.kr_driver_repeat_rate_summary;
    else
      select coalesce(sum(least(accepted_seats, seats_total)), 0), coalesce(sum(seats_total), 0), round(avg(fill_rate), 4)
        into n, d, v from public.kr_seat_fill_rate where has_departed;
      if (r->>'current_value')::numeric is distinct from v then
        raise exception 'seat_fill shows % but the KR view says %', r->>'current_value', v; end if;
    end if;
    if (r->>'numerator')::integer <> n or (r->>'denominator')::integer <> d then
      raise exception '% shows % of % but the KR view says % of %', r->>'kr', r->>'numerator', r->>'denominator', n, d;
    end if;
  end loop;
end $$;

-- A signed-in user who isn't an admin is refused.
set local role authenticated;
select set_config('request.jwt.claim.sub','0c4e5a11-2222-4222-8222-222222222222',true);
do $$ begin
  perform * from public.okr_stats();
  raise exception 'A non-admin read the OKR stats';
exception when insufficient_privilege then null; end $$;

rollback;
select 'PASS: all 4 Key Results are set up, admin-only, and match the KR views; synthetic admin rolled back' as verification;
