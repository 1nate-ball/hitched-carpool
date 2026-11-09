-- Apply once through the Supabase SQL Editor (runs as postgres), after the earlier migrations.
-- Objective 1, KR2: 100% of posted trips are linked to a signed-in driver account (no anonymous trips).
--
-- Already enforced by 20261027000100_post_a_trip.sql and 20261106000100_trip_locations_search_ownership.sql:
--   * trips.driver_id is NOT NULL and references auth.users(id), so every trip names a real account;
--   * anon has no privileges on trips; signed-in users may insert only with driver_id = auth.uid();
--   * driver_id is not in the update grant, so a trip can't be moved to another account;
--   * the foreign key has no ON DELETE action, so an account with trips can't be deleted out from under them.
-- This migration only adds the tracking views. Intentionally fails on name collisions.
begin;

-- One row per trip. linked = driver_id is set and is a Supabase Auth account.
create view public.kr_trip_driver_link with (security_invoker = true) as
select t.id as trip_id, t.driver_id, t.created_at,
  (t.driver_id is not null and exists (select 1 from auth.users u where u.id = t.driver_id)) as is_linked
from public.trips t;

create view public.kr_trip_driver_link_summary with (security_invoker = true) as
select count(*) as trips,
  count(*) filter (where is_linked) as linked_trips,
  round(100.0 * count(*) filter (where is_linked) / nullif(count(*), 0), 1) as linked_rate
from public.kr_trip_driver_link;

-- Internal metric: readable from the SQL Editor only, never through the Data API.
revoke all on public.kr_trip_driver_link, public.kr_trip_driver_link_summary
from public, anon, authenticated;

commit;
