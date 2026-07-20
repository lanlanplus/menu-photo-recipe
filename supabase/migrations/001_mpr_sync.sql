-- Menu Photo Recipe (mpr_) cloud state. Run this migration in the target
-- Supabase project's SQL editor. It is safe to re-run.
create table if not exists public.mpr_user_app_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  app_state jsonb not null default '{"version":1,"dishes":[],"orders":[],"photoIds":[]}'::jsonb,
  revision bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.mpr_user_app_states enable row level security;

drop policy if exists "mpr_select_own_state" on public.mpr_user_app_states;
create policy "mpr_select_own_state" on public.mpr_user_app_states
  for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "mpr_insert_own_state" on public.mpr_user_app_states;
create policy "mpr_insert_own_state" on public.mpr_user_app_states
  for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists "mpr_update_own_state" on public.mpr_user_app_states;
create policy "mpr_update_own_state" on public.mpr_user_app_states
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public)
values ('mpr-photos', 'mpr-photos', false)
on conflict (id) do update set public = false;

drop policy if exists "mpr_read_own_photos" on storage.objects;
create policy "mpr_read_own_photos" on storage.objects
  for select to authenticated
  using (bucket_id = 'mpr-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "mpr_upload_own_photos" on storage.objects;
create policy "mpr_upload_own_photos" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'mpr-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "mpr_update_own_photos" on storage.objects;
create policy "mpr_update_own_photos" on storage.objects
  for update to authenticated
  using (bucket_id = 'mpr-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "mpr_delete_own_photos" on storage.objects;
create policy "mpr_delete_own_photos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'mpr-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
