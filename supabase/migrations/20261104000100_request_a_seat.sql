-- Apply once through the Supabase SQL Editor (runs as postgres), after 20261027000100_post_a_trip.sql.
-- Request a Seat: a rider asks to join a trip. Every request starts as pending.
-- Intentionally fails on name collisions, like the earlier migrations.
begin;

create table public.ride_requests (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  rider_id uuid not null default auth.uid() references auth.users(id),
  note text not null default '' check (length(note) <= 300),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at timestamptz not null default now(),
  -- A rider can request a given trip only once.
  constraint ride_requests_one_per_rider unique (trip_id, rider_id)
);

-- (trip_id, rider_id) is already indexed by the unique constraint; riders also look up their own requests.
create index ride_requests_rider_id_idx on public.ride_requests (rider_id);

alter table public.ride_requests enable row level security;
revoke all on public.ride_requests from public, anon, authenticated;
grant select on public.ride_requests to authenticated;
-- Only the trip and the note come from the client. rider_id is the signed-in user,
-- status is always 'pending', and the id and timestamp come from the database.
grant insert (trip_id, note) on public.ride_requests to authenticated;

-- Riders insert only as themselves, and never on a trip they are driving.
create policy ride_requests_insert_own on public.ride_requests
for insert to authenticated
with check (
  rider_id = (select auth.uid())
  and not exists (
    select 1 from public.trips t
    where t.id = trip_id and t.driver_id = (select auth.uid())
  )
);

-- Riders see their own requests; drivers see the requests on their trips.
create policy ride_requests_read_rider_or_driver on public.ride_requests
for select to authenticated
using (
  rider_id = (select auth.uid())
  or exists (
    select 1 from public.trips t
    where t.id = trip_id and t.driver_id = (select auth.uid())
  )
);

-- Accepting, declining and withdrawing are separate backlog items (no update/delete grants yet).
commit;
