-- Otoyo Ekiden Timer v0.13 patch
-- 1) 公開する正式結果・表彰設定の読み取りを許可
-- 2) 表彰状/記録証テンプレート・印画像用 Supabase Storage bucket を作成
-- Run once in Supabase Dashboard -> SQL Editor.

-- awards は公開/非公開フラグと表彰ルールのみで、個人連絡先等は含みません。
drop policy if exists "ekiden public and role reads" on public.ekiden_kv;
create policy "ekiden public and role reads" on public.ekiden_kv
for select to authenticated
using (
  public.ekiden_current_role()='admin'
  or path='meta' or path='settings' or path='awards'
  or path='notices' or path like 'notices/%'
  or path='teams' or path like 'teams/%'
  or path='officialMeasurements' or path like 'officialMeasurements/%'
  or path='teamMeasurements' or path like 'teamMeasurements/%'
  or path='adoptions' or path like 'adoptions/%'
  or path='overrides' or path like 'overrides/%'
);

-- 証書用画像だけを置く非公開 bucket。完成PDFは保存しません。
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'ekiden-assets',
  'ekiden-assets',
  false,
  3145728,
  array['image/png','image/jpeg','image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 再実行可能にするため既存ポリシーを作り直します。
drop policy if exists "ekiden assets public read" on storage.objects;
drop policy if exists "ekiden assets admin insert" on storage.objects;
drop policy if exists "ekiden assets admin update" on storage.objects;
drop policy if exists "ekiden assets admin delete" on storage.objects;

create policy "ekiden assets public read" on storage.objects
for select to authenticated
using (bucket_id='ekiden-assets' and public.ekiden_current_role()='admin');

create policy "ekiden assets admin insert" on storage.objects
for insert to authenticated
with check (
  bucket_id='ekiden-assets'
  and name like 'certificates/%'
  and public.ekiden_current_role()='admin'
);

create policy "ekiden assets admin update" on storage.objects
for update to authenticated
using (
  bucket_id='ekiden-assets'
  and name like 'certificates/%'
  and public.ekiden_current_role()='admin'
)
with check (
  bucket_id='ekiden-assets'
  and name like 'certificates/%'
  and public.ekiden_current_role()='admin'
);

create policy "ekiden assets admin delete" on storage.objects
for delete to authenticated
using (
  bucket_id='ekiden-assets'
  and name like 'certificates/%'
  and public.ekiden_current_role()='admin'
);
