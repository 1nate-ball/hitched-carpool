-- Apply once through the Supabase SQL Editor (runs as postgres), after the earlier migrations.
-- Objective 1, KR1: 100% of drivers are verified.
--
-- What "verified" means in Hitch (this version): the account's email ends in byu.edu
-- (byu.edu or a subdomain such as mail.byu.edu, same rule as the sign-up form) and the user
-- has confirmed it by clicking the link Supabase emailed to that inbox. That shows the
-- person controls a BYU email account. It is NOT an ID, license, driving-record or
-- insurance check; student ID review is planned as a later level of verification.
--
-- The trips insert policy now requires a verified driver, so every new trip has one.
-- The KR views below measure it, including any trips posted before this migration.
-- Intentionally fails on name collisions, like the earlier migrations.
begin;

-- SECURITY DEFINER: reads auth.users, which API roles cannot. Returns only a boolean.
create function public.is_verified_user(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.users u
    where u.id = uid
      and u.email_confirmed_at is not null
      and u.email ~* '^[^[:space:]@]+@([a-z0-9-]+\.)*byu\.edu$'
  );
$$;
revoke all on function public.is_verified_user(uuid) from public, anon, authenticated;
-- The trips policy runs as the signed-in user, so they need to be able to call it.
grant execute on function public.is_verified_user(uuid) to authenticated;

-- Batch lookup for badges: verified yes/no for up to 200 user ids. No emails are returned.
create function public.verification_status(user_ids uuid[])
returns table (user_id uuid, is_verified boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select id, public.is_verified_user(id)
  from (select distinct unnest(user_ids) as id limit 200) ids;
$$;
revoke all on function public.verification_status(uuid[]) from public, anon, authenticated;
grant execute on function public.verification_status(uuid[]) to authenticated;

-- Only verified users can post trips.
drop policy trips_insert_own on public.trips;
create policy trips_insert_verified_driver on public.trips
for insert to authenticated
with check (
  (select auth.uid()) = driver_id
  and (select public.is_verified_user(auth.uid()))
);

-- KR: one row per driver who has posted at least one trip.
create view public.kr_driver_verification with (security_invoker = true) as
select t.driver_id,
  public.is_verified_user(t.driver_id) as is_verified,
  count(*)::integer as trips_posted,
  min(t.created_at) as first_trip_at
from public.trips t
group by t.driver_id;

create view public.kr_driver_verification_summary with (security_invoker = true) as
select count(*) as drivers,
  count(*) filter (where is_verified) as verified_drivers,
  round(100.0 * count(*) filter (where is_verified) / nullif(count(*), 0), 1) as verified_rate
from public.kr_driver_verification;

-- Internal metric: readable from the SQL Editor only, never through the Data API.
revoke all on public.kr_driver_verification, public.kr_driver_verification_summary
from public, anon, authenticated;

commit;
