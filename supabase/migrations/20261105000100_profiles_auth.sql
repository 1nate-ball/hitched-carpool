-- Apply once through the Supabase SQL Editor (runs as postgres), after the earlier migrations.
-- Sign Up: every Supabase Auth user gets a matching row in public.profiles.
-- The row is created by a trigger on auth.users, so it exists even while the
-- user still has to confirm their email (when no browser session exists yet).
-- Intentionally fails on name collisions, like the earlier migrations.
begin;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (length(btrim(full_name)) between 1 and 80),
  email text not null,
  created_at timestamptz not null default now()
);

-- SECURITY DEFINER: the trigger runs inside Supabase Auth's sign-up, where the new
-- user has no session yet. It only ever inserts the row for the user being created.
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''), split_part(new.email, '@', 1)),
    new.email
  );
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Test accounts created in the dashboard before this migration get a profile too.
insert into public.profiles (id, full_name, email)
select u.id,
  coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''), split_part(u.email, '@', 1)),
  u.email
from auth.users u
on conflict (id) do nothing;

alter table public.profiles enable row level security;
revoke all on public.profiles from public, anon, authenticated;
-- Signed-in users can read names (drivers and riders will need each other's names).
-- Email is not granted: other students' emails are not exposed through the API.
grant select (id, full_name, created_at) on public.profiles to authenticated;

create policy profiles_read_signed_in on public.profiles
for select to authenticated using ((select auth.uid()) is not null);

-- Inserts only come from the trigger; editing the profile is separate backlog work.
commit;
