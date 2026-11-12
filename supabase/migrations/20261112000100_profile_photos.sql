-- Profile photos: private files, readable by signed-in users and writable only by their owner.
begin;

alter table public.profiles add column avatar_path text;
alter table public.profiles add constraint profile_avatar_owner_path check (
  avatar_path is null or avatar_path ~ ('^' || id::text || '/[0-9a-f-]{36}\.jpg$')
);
grant select (avatar_path), update (avatar_path) on public.profiles to authenticated;
create policy profiles_update_own_photo on public.profiles for update to authenticated
using (id = (select auth.uid())) with check (id = (select auth.uid()));

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', false, 1048576, array['image/jpeg']);

create policy profile_photos_read_signed_in on storage.objects for select to authenticated
using (bucket_id = 'profile-photos');
create policy profile_photos_insert_own on storage.objects for insert to authenticated
with check (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy profile_photos_delete_own on storage.objects for delete to authenticated
using (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

commit;
