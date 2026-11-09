-- Sprint 2: searchable meeting places, saved pins, and owner-only trip edits.
-- Apply once after the Post a Trip and Request a Seat migrations.
begin;
create table public.locations (
  id text primary key,
  name text not null,
  city text not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180)
);
-- Starter meeting places for the class demo. Drivers can move the pin to the exact meeting spot.
insert into public.locations values
 ('byu-wilk','Wilkinson Student Center','Provo',40.2485,-111.6472),
 ('byu-helaman','Helaman Halls','Provo',40.2530,-111.6540),
 ('byu-heritage','Heritage Halls','Provo',40.2525,-111.6430),
 ('byu-stadium','LaVell Edwards Stadium','Provo',40.2575,-111.6547),
 ('uvu','Utah Valley University','Orem',40.2786,-111.7187),
 ('slc-city-creek','City Creek Center','Salt Lake City',40.7684,-111.8910),
 ('park-city-main','Main Street','Park City',40.6450,-111.4960),
 ('sundance','Sundance Mountain Resort','Sundance',40.3923,-111.5799),
 ('moab-center','Moab city center','Moab',38.5733,-109.5498),
 ('st-george-center','St. George city center','St. George',37.1041,-113.5841),
 ('zion-visitor','Zion Canyon Visitor Center','Springdale',37.2000,-112.9870),
 ('garden-city','Garden City center','Garden City',41.9469,-111.3930),
 ('jackson-square','Jackson Town Square','Jackson',43.4799,-110.7624);
alter table public.locations enable row level security;
revoke all on public.locations from public, anon, authenticated;
grant select on public.locations to authenticated;
create policy locations_read_signed_in on public.locations for select to authenticated
using ((select auth.uid()) is not null);

alter table public.trips
  add column origin_city text not null default 'Provo' check (length(btrim(origin_city)) between 1 and 80),
  add column pickup_latitude double precision,
  add column pickup_longitude double precision,
  add column dropoff_latitude double precision,
  add column dropoff_longitude double precision,
  add constraint pickup_pin_valid check ((pickup_latitude is null and pickup_longitude is null) or
    (pickup_latitude is not null and pickup_longitude is not null and pickup_latitude between -90 and 90 and pickup_longitude between -180 and 180)),
  add constraint dropoff_pin_valid check ((dropoff_latitude is null and dropoff_longitude is null) or
    (dropoff_latitude is not null and dropoff_longitude is not null and dropoff_latitude between -90 and 90 and dropoff_longitude between -180 and 180));
grant insert (origin_city, pickup_latitude, pickup_longitude, dropoff_latitude, dropoff_longitude) on public.trips to authenticated;
-- Driver identity, UUID and creation timestamp remain immutable through the client API.
grant update (destination_id, departure_at, pickup_location, dropoff_location, total_seats,
 price_per_seat, return_at, origin_city, pickup_latitude, pickup_longitude, dropoff_latitude, dropoff_longitude)
on public.trips to authenticated;
create policy trips_update_own on public.trips for update to authenticated
using ((select auth.uid()) = driver_id) with check ((select auth.uid()) = driver_id);

-- Intentionally owner-executed view: reveals only an aggregate seat count, never other riders' identities/notes.
-- All signed-in users can already browse these trip fields. Anonymous callers have no view grant.
create view public.available_trips with (security_barrier = true) as
select t.*, (t.total_seats - (select count(*) from public.ride_requests r
  where r.trip_id = t.id and r.status = 'accepted'))::integer as seats_available
from public.trips t
where (select auth.uid()) is not null and t.departure_at > now()
  and t.total_seats > (select count(*) from public.ride_requests r where r.trip_id = t.id and r.status = 'accepted');
revoke all on public.available_trips from public, anon, authenticated;
grant select on public.available_trips to authenticated;
commit;
