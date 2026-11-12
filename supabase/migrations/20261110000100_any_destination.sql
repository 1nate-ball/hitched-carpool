-- Sprint 3 (Robbie): drivers can type any destination, not only the 8 preset places.
-- Apply once through the Supabase SQL Editor, after the earlier migrations.
--
-- * destinations gets an optional map pin, who added it, and photo_url (left empty here;
--   the "Auto-generate a picture for new destinations" card fills it in).
-- * Destination names are unique ignoring case and extra spaces, so "moab" and "Moab "
--   reuse the same row instead of splitting trips across two destinations.
-- * Clients never insert into destinations directly. They call
--   find_or_create_destination(name, latitude, longitude), which returns the existing row
--   or creates one with a database-generated id.
begin;

alter table public.destinations
  add column latitude double precision,
  add column longitude double precision,
  add column photo_url text check (photo_url is null or photo_url ~ '^https://'),
  add column created_by uuid references auth.users(id),
  add column created_at timestamptz not null default now(),
  add constraint destination_pin_valid check (
    (latitude is null and longitude is null) or
    (latitude between -90 and 90 and longitude between -180 and 180));

create unique index destinations_name_unique on public.destinations (lower(btrim(name)));

-- Pins for the presets, so price and drive-time estimates work the same way for every place.
update public.destinations d set latitude = v.lat, longitude = v.lng
from (values
  ('slc', 40.7608, -111.8910), ('sundance', 40.3923, -111.5799), ('parkcity', 40.6461, -111.4980),
  ('bearlake', 41.9469, -111.3930), ('moab', 38.5733, -109.5498), ('stgeorge', 37.0965, -113.5684),
  ('zion', 37.2000, -112.9870), ('jackson', 43.4799, -110.7624)
) as v(id, lat, lng)
where d.id = v.id;

-- SECURITY DEFINER so signed-in users can add a destination without a broad INSERT grant.
-- It only ever inserts a cleaned name, an optional valid pin, and the caller's own id.
create function public.find_or_create_destination(
  p_name text, p_latitude double precision default null, p_longitude double precision default null)
returns public.destinations
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_row public.destinations;
begin
  if auth.uid() is null then
    raise exception 'Sign in before adding a destination.' using errcode = '42501';
  end if;
  if length(v_name) < 2 or length(v_name) > 80 then
    raise exception 'Destination must be 2 to 80 characters.' using errcode = '23514';
  end if;
  if (p_latitude is null) <> (p_longitude is null)
     or (p_latitude is not null and (p_latitude not between -90 and 90 or p_longitude not between -180 and 180)) then
    raise exception 'Destination pin is not valid.' using errcode = '23514';
  end if;

  select * into v_row from public.destinations where lower(btrim(name)) = lower(v_name);
  if found then
    -- Fill in a missing pin the first time someone picks this place from search.
    if v_row.latitude is null and p_latitude is not null then
      update public.destinations set latitude = p_latitude, longitude = p_longitude
      where id = v_row.id returning * into v_row;
    end if;
    return v_row;
  end if;

  insert into public.destinations (id, name, latitude, longitude, created_by)
  values ('d-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12), v_name, p_latitude, p_longitude, auth.uid())
  on conflict ((lower(btrim(name)))) do nothing
  returning * into v_row;
  if v_row.id is null then -- someone else added the same name at the same moment
    select * into v_row from public.destinations where lower(btrim(name)) = lower(v_name);
  end if;
  return v_row;
end;
$$;
revoke all on function public.find_or_create_destination(text, double precision, double precision) from public, anon;
grant execute on function public.find_or_create_destination(text, double precision, double precision) to authenticated;

commit;
