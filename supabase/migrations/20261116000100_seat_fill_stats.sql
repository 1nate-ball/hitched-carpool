-- Apply once through the Supabase SQL Editor (runs as postgres), after the earlier migrations.
-- Objective 2 KR (posted trips average 70% of seats filled), shown live on an admin-only Stats screen.
--   * public.admins lists the accounts that may see stats. It is managed only in the SQL Editor:
--       insert into public.admins (user_id) select id from auth.users where email = 'someone@byu.edu';
--   * public.seat_fill_stats() returns one row of totals, computed from trips + ride_requests on every
--     call (through kr_seat_fill_rate), so the screen never shows a stored or typed-in number.
--     It returns no trip ids, names or riders, and refuses anyone who isn't an admin.
-- Intentionally fails on name collisions, like the earlier migrations.
begin;

create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
-- No API access at all: not readable, not writable. Only postgres (the SQL Editor) manages it.
alter table public.admins enable row level security;
revoke all on public.admins from public, anon, authenticated;

-- Lets the app decide whether to show the Stats link. Says nothing about anyone else.
create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins where user_id = (select auth.uid()));
$$;
revoke all on function public.is_admin() from public, anon, authenticated;
grant execute on function public.is_admin() to authenticated;

-- Live seat-fill numbers. SECURITY DEFINER so it can read the private KR view; it checks the caller first.
--   avg_fill_rate     the Key Result: average of each departed trip's accepted seats / total seats (max 100%)
--   departed_*        accepted seats and total seats summed across departed trips
--   upcoming_*        the same for trips that haven't left yet (filled so far; not part of the KR)
-- Cancelled trips are already left out by kr_seat_fill_rate (20261115000100).
create function public.seat_fill_stats()
returns table (
  departed_trips integer,
  avg_fill_rate numeric,
  departed_accepted_seats integer,
  departed_total_seats integer,
  upcoming_trips integer,
  upcoming_accepted_seats integer,
  upcoming_total_seats integer,
  target_fill_rate numeric,
  computed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.admins where user_id = (select auth.uid())) then
    raise exception 'Only Hitch admins can see stats.' using errcode = '42501';
  end if;
  return query
  select
    (count(*) filter (where k.has_departed))::integer,
    round(avg(k.fill_rate) filter (where k.has_departed), 4),
    coalesce(sum(least(k.accepted_seats, k.seats_total)) filter (where k.has_departed), 0)::integer,
    coalesce(sum(k.seats_total) filter (where k.has_departed), 0)::integer,
    (count(*) filter (where not k.has_departed))::integer,
    coalesce(sum(least(k.accepted_seats, k.seats_total)) filter (where not k.has_departed), 0)::integer,
    coalesce(sum(k.seats_total) filter (where not k.has_departed), 0)::integer,
    0.70::numeric,
    now()
  from public.kr_seat_fill_rate k;
end;
$$;
revoke all on function public.seat_fill_stats() from public, anon, authenticated;
grant execute on function public.seat_fill_stats() to authenticated;

commit;
