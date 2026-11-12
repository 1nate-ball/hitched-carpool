-- Sprint 3 (Robbie): pickup identification.
-- Apply once through the Supabase SQL Editor, after the earlier migrations.
--
-- Helps a confirmed rider find the right car at pickup. This is pickup identification,
-- NOT proof of verified identity or a safety guarantee.
--
-- * One row per trip: car make/model, color, license plate, and a 4-digit pickup code.
-- * Kept in its own table (not on trips) so the plate and code never show up through the
--   public trip list or the available_trips view.
-- * Only the trip's driver and riders whose request was ACCEPTED can read the row.
--   Pending, declined, and unrelated users get nothing back.
-- * Only the driver can add or change car details. The pickup code is created by the
--   database and can't be chosen or edited from the app.
--
-- How the code is used: the rider tells the driver the code at pickup, and the driver
-- checks it against the code on their Manage requests page.
begin;

create table public.trip_pickup_details (
  trip_id uuid primary key references public.trips(id) on delete cascade,
  vehicle_make_model text not null default '' check (length(vehicle_make_model) <= 60),
  vehicle_color text not null default '' check (length(vehicle_color) <= 30),
  license_plate text not null default '' check (license_plate ~ '^[A-Z0-9 -]{0,10}$'),
  pickup_code text not null default lpad((floor(random() * 10000))::int::text, 4, '0') check (pickup_code ~ '^[0-9]{4}$'),
  updated_at timestamptz not null default now()
);

-- Plates are stored uppercase so "abc 123" and "ABC 123" are the same plate.
create function public.normalize_pickup_details()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.vehicle_make_model := btrim(new.vehicle_make_model);
  new.vehicle_color := btrim(new.vehicle_color);
  new.license_plate := upper(btrim(new.license_plate));
  new.updated_at := now();
  if tg_op = 'UPDATE' then new.pickup_code := old.pickup_code; new.trip_id := old.trip_id; end if;
  return new;
end;
$$;
revoke all on function public.normalize_pickup_details() from public, anon, authenticated;
create trigger normalize_pickup_details
before insert or update on public.trip_pickup_details
for each row execute function public.normalize_pickup_details();

alter table public.trip_pickup_details enable row level security;
revoke all on public.trip_pickup_details from public, anon, authenticated;
grant select on public.trip_pickup_details to authenticated;
grant insert (trip_id, vehicle_make_model, vehicle_color, license_plate) on public.trip_pickup_details to authenticated;
-- trip_id is in the update grant only because the app saves with an upsert (ON CONFLICT DO UPDATE
-- sets every sent column). The trigger above keeps the original trip_id and pickup_code on update.
grant update (trip_id, vehicle_make_model, vehicle_color, license_plate) on public.trip_pickup_details to authenticated;

create policy pickup_read_driver_or_confirmed on public.trip_pickup_details
for select to authenticated
using (
  exists (select 1 from public.trips t where t.id = trip_id and t.driver_id = (select auth.uid()))
  or exists (select 1 from public.ride_requests r
             where r.trip_id = trip_pickup_details.trip_id and r.rider_id = (select auth.uid()) and r.status = 'accepted')
);
create policy pickup_insert_driver on public.trip_pickup_details
for insert to authenticated
with check (exists (select 1 from public.trips t where t.id = trip_id and t.driver_id = (select auth.uid())));
create policy pickup_update_driver on public.trip_pickup_details
for update to authenticated
using (exists (select 1 from public.trips t where t.id = trip_id and t.driver_id = (select auth.uid())))
with check (exists (select 1 from public.trips t where t.id = trip_id and t.driver_id = (select auth.uid())));

commit;
