-- Apply once through the Supabase SQL Editor (runs as postgres).
-- KR: 50% of drivers post a second trip within 30 days of their first.
-- Intentionally fails on name collisions, like the initial migration.
begin;

create index if not exists trips_driver_created_idx on public.trips (driver_id, created_at);

-- One row per driver whose first trip is 30+ days old, so every driver counted
-- has had a full 30-day window to post again.
create view public.kr_driver_repeat_rate with (security_invoker = true) as
with ranked as (
  select driver_id, created_at,
    row_number() over (partition by driver_id order by created_at, id) as trip_number
  from public.trips
), first_two as (
  select driver_id,
    max(created_at) filter (where trip_number = 1) as first_trip_at,
    max(created_at) filter (where trip_number = 2) as second_trip_at
  from ranked
  where trip_number <= 2
  group by driver_id
)
select driver_id, first_trip_at, second_trip_at,
  coalesce(second_trip_at <= first_trip_at + interval '30 days', false) as is_repeat
from first_two
where first_trip_at <= now() - interval '30 days';

create view public.kr_driver_repeat_rate_summary with (security_invoker = true) as
select count(*) as eligible_drivers,
  count(*) filter (where is_repeat) as repeat_drivers,
  round(100.0 * count(*) filter (where is_repeat) / nullif(count(*), 0), 1) as repeat_rate
from public.kr_driver_repeat_rate;

-- Internal metric: readable from the SQL Editor only, never through the Data API.
-- security_invoker keeps trips RLS in force for anyone who is later granted access.
revoke all on public.kr_driver_repeat_rate, public.kr_driver_repeat_rate_summary
from public, anon, authenticated;

commit;
