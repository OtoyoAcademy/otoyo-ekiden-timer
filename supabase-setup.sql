-- Otoyo Ekiden Timer v0.9 - Supabase setup
-- Run this entire script once in Supabase Dashboard -> SQL Editor.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.ekiden_kv (
  path text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.ekiden_sessions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin','operator','team')),
  identifier text,
  expires_at timestamptz not null default (now() + interval '12 hours'),
  updated_at timestamptz not null default now()
);

create table if not exists public.ekiden_secrets (
  key text primary key,
  secret_hash text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.ekiden_team_secrets (
  team_no text primary key,
  access_code text not null,
  secret_hash text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.ekiden_locks (
  kind text not null check (kind in ('operators','teams')),
  identifier text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  last_seen timestamptz not null default now(),
  primary key (kind, identifier)
);

-- Seed initial access codes. Change them from the app after first admin login.
insert into public.ekiden_secrets(key, secret_hash)
values
  ('admin', extensions.crypt('1234', extensions.gen_salt('bf'))),
  ('operator:A', extensions.crypt('1111', extensions.gen_salt('bf'))),
  ('operator:B', extensions.crypt('2222', extensions.gen_salt('bf'))),
  ('operator:C', extensions.crypt('3333', extensions.gen_salt('bf')))
on conflict (key) do nothing;

create or replace function public.ekiden_current_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select s.role
  from public.ekiden_sessions s
  where s.user_id = auth.uid() and s.expires_at > now()
  limit 1;
$$;

create or replace function public.ekiden_current_identifier()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select s.identifier
  from public.ekiden_sessions s
  where s.user_id = auth.uid() and s.expires_at > now()
  limit 1;
$$;

create or replace function public.ekiden_sign_in(p_role text, p_identifier text, p_passcode text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  ok boolean := false;
  target_hash text;
  normalized_id text := nullif(trim(coalesce(p_identifier,'')), '');
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_role = 'admin' then
    select secret_hash into target_hash from public.ekiden_secrets where key='admin';
    ok := target_hash is not null and extensions.crypt(p_passcode, target_hash)=target_hash;
    normalized_id := 'admin';
  elsif p_role = 'operator' and normalized_id in ('A','B','C') then
    select secret_hash into target_hash from public.ekiden_secrets where key='operator:'||normalized_id;
    ok := target_hash is not null and extensions.crypt(p_passcode, target_hash)=target_hash;
  elsif p_role = 'team' and normalized_id is not null then
    select secret_hash into target_hash from public.ekiden_team_secrets where team_no=normalized_id;
    ok := target_hash is not null and extensions.crypt(p_passcode, target_hash)=target_hash;
  end if;

  if not ok then
    return jsonb_build_object('ok',false);
  end if;

  insert into public.ekiden_sessions(user_id,role,identifier,expires_at,updated_at)
  values(auth.uid(),p_role,normalized_id,now()+interval '12 hours',now())
  on conflict(user_id) do update set role=excluded.role,identifier=excluded.identifier,expires_at=excluded.expires_at,updated_at=now();

  return jsonb_build_object('ok',true,'role',p_role,'identifier',normalized_id);
end;
$$;

create or replace function public.ekiden_sign_out()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.ekiden_locks where user_id=auth.uid();
  delete from public.ekiden_sessions where user_id=auth.uid();
  return true;
end;
$$;

create or replace function public.ekiden_server_time_ms()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select floor(extract(epoch from clock_timestamp())*1000)::bigint;
$$;

create or replace function public.ekiden_claim_lock(p_kind text, p_identifier text, p_device_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  r text := public.ekiden_current_role();
  ident text := public.ekiden_current_identifier();
  existing public.ekiden_locks%rowtype;
begin
  if not ((r='operator' and p_kind='operators' and ident=p_identifier)
       or (r='team' and p_kind='teams' and ident=p_identifier)) then
    return false;
  end if;

  select * into existing from public.ekiden_locks where kind=p_kind and identifier=p_identifier for update;
  if found and existing.user_id<>auth.uid() and existing.last_seen > now()-interval '90 seconds' then
    return false;
  end if;

  insert into public.ekiden_locks(kind,identifier,user_id,device_id,last_seen)
  values(p_kind,p_identifier,auth.uid(),p_device_id,now())
  on conflict(kind,identifier) do update set user_id=excluded.user_id,device_id=excluded.device_id,last_seen=excluded.last_seen;

  update public.ekiden_sessions set expires_at=now()+interval '12 hours',updated_at=now() where user_id=auth.uid();
  return true;
end;
$$;

create or replace function public.ekiden_release_lock(p_kind text, p_identifier text, p_device_id text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.ekiden_locks
  where kind=p_kind and identifier=p_identifier and user_id=auth.uid() and device_id=p_device_id;
  return true;
end;
$$;

create or replace function public.ekiden_update_access_codes(p_admin text default null, p_a text default null, p_b text default null, p_c text default null)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if public.ekiden_current_role() <> 'admin' then raise exception 'Admin required'; end if;
  if nullif(trim(coalesce(p_admin,'')),'') is not null then update public.ekiden_secrets set secret_hash=extensions.crypt(p_admin,extensions.gen_salt('bf')),updated_at=now() where key='admin'; end if;
  if nullif(trim(coalesce(p_a,'')),'') is not null then update public.ekiden_secrets set secret_hash=extensions.crypt(p_a,extensions.gen_salt('bf')),updated_at=now() where key='operator:A'; end if;
  if nullif(trim(coalesce(p_b,'')),'') is not null then update public.ekiden_secrets set secret_hash=extensions.crypt(p_b,extensions.gen_salt('bf')),updated_at=now() where key='operator:B'; end if;
  if nullif(trim(coalesce(p_c,'')),'') is not null then update public.ekiden_secrets set secret_hash=extensions.crypt(p_c,extensions.gen_salt('bf')),updated_at=now() where key='operator:C'; end if;
  return true;
end;
$$;

create or replace function public.ekiden_set_team_code(p_team_no text, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if public.ekiden_current_role() <> 'admin' then raise exception 'Admin required'; end if;
  insert into public.ekiden_team_secrets(team_no,access_code,secret_hash,updated_at)
  values(trim(p_team_no),trim(p_code),extensions.crypt(trim(p_code),extensions.gen_salt('bf')),now())
  on conflict(team_no) do update set access_code=excluded.access_code,secret_hash=excluded.secret_hash,updated_at=now();
  return true;
end;
$$;

create or replace function public.ekiden_delete_team_code(p_team_no text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.ekiden_current_role() <> 'admin' then raise exception 'Admin required'; end if;
  delete from public.ekiden_team_secrets where team_no=trim(p_team_no);
  return true;
end;
$$;

create or replace function public.ekiden_list_team_codes()
returns table(team_no text, access_code text)
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.ekiden_current_role() <> 'admin' then raise exception 'Admin required'; end if;
  return query select s.team_no,s.access_code from public.ekiden_team_secrets s order by s.team_no;
end;
$$;

create or replace function public.ekiden_clear_team_codes()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.ekiden_current_role() <> 'admin' then raise exception 'Admin required'; end if;
  delete from public.ekiden_team_secrets;
  return true;
end;
$$;

-- RLS
alter table public.ekiden_kv enable row level security;
alter table public.ekiden_sessions enable row level security;
alter table public.ekiden_secrets enable row level security;
alter table public.ekiden_team_secrets enable row level security;
alter table public.ekiden_locks enable row level security;

revoke all on public.ekiden_kv from anon, authenticated;
grant select,insert,update,delete on public.ekiden_kv to authenticated;

-- Make policy creation idempotent when the script is re-run.
drop policy if exists "ekiden public and role reads" on public.ekiden_kv;
drop policy if exists "ekiden admin inserts" on public.ekiden_kv;
drop policy if exists "ekiden admin updates" on public.ekiden_kv;
drop policy if exists "ekiden admin deletes" on public.ekiden_kv;
drop policy if exists "ekiden operator inserts" on public.ekiden_kv;
drop policy if exists "ekiden operator updates" on public.ekiden_kv;
drop policy if exists "ekiden operator deletes" on public.ekiden_kv;
drop policy if exists "ekiden team inserts" on public.ekiden_kv;
drop policy if exists "ekiden team updates" on public.ekiden_kv;
drop policy if exists "ekiden team deletes" on public.ekiden_kv;
drop policy if exists "ekiden application submit" on public.ekiden_kv;
drop policy if exists "ekiden application resubmit" on public.ekiden_kv;

-- Public app data is readable only after anonymous Supabase Auth sign-in.
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

create policy "ekiden admin inserts" on public.ekiden_kv
for insert to authenticated
with check (public.ekiden_current_role()='admin');

create policy "ekiden admin updates" on public.ekiden_kv
for update to authenticated
using (public.ekiden_current_role()='admin')
with check (public.ekiden_current_role()='admin');

create policy "ekiden admin deletes" on public.ekiden_kv
for delete to authenticated
using (public.ekiden_current_role()='admin');

create policy "ekiden operator inserts" on public.ekiden_kv
for insert to authenticated
with check (
  public.ekiden_current_role()='operator'
  and path like 'officialMeasurements/%'
  and coalesce(value->>'operator','')=public.ekiden_current_identifier()
);

create policy "ekiden operator updates" on public.ekiden_kv
for update to authenticated
using (public.ekiden_current_role()='operator' and path like 'officialMeasurements/%')
with check (
  public.ekiden_current_role()='operator'
  and path like 'officialMeasurements/%'
  and coalesce(value->>'operator','')=public.ekiden_current_identifier()
);

create policy "ekiden operator deletes" on public.ekiden_kv
for delete to authenticated
using (
  public.ekiden_current_role()='operator'
  and path like 'officialMeasurements/%'
  and coalesce(value->>'operator','')=public.ekiden_current_identifier()
);

create policy "ekiden team inserts" on public.ekiden_kv
for insert to authenticated
with check (
  public.ekiden_current_role()='team'
  and path like ('teamMeasurements/'||public.ekiden_current_identifier()||'/%')
  and coalesce(value->>'teamNo','')=public.ekiden_current_identifier()
);

create policy "ekiden team updates" on public.ekiden_kv
for update to authenticated
using (public.ekiden_current_role()='team' and path like ('teamMeasurements/'||public.ekiden_current_identifier()||'/%'))
with check (
  public.ekiden_current_role()='team'
  and path like ('teamMeasurements/'||public.ekiden_current_identifier()||'/%')
  and coalesce(value->>'teamNo','')=public.ekiden_current_identifier()
);

create policy "ekiden team deletes" on public.ekiden_kv
for delete to authenticated
using (public.ekiden_current_role()='team' and path like ('teamMeasurements/'||public.ekiden_current_identifier()||'/%'));

-- Public application submission: submitter can insert/update only their own application row.
create policy "ekiden application submit" on public.ekiden_kv
for insert to authenticated
with check (
  path like 'applications/%'
  and coalesce(value->>'submittedBy','')=auth.uid()::text
);

create policy "ekiden application resubmit" on public.ekiden_kv
for update to authenticated
using (
  path like 'applications/%'
  and coalesce(value->>'submittedBy','')=auth.uid()::text
)
with check (
  path like 'applications/%'
  and coalesce(value->>'submittedBy','')=auth.uid()::text
);

-- No direct client access to session/secrets/locks tables; only security-definer RPC functions use them.
revoke all on public.ekiden_sessions from anon, authenticated;
revoke all on public.ekiden_secrets from anon, authenticated;
revoke all on public.ekiden_team_secrets from anon, authenticated;
revoke all on public.ekiden_locks from anon, authenticated;

revoke all on function public.ekiden_current_role() from public;
revoke all on function public.ekiden_current_identifier() from public;
grant execute on function public.ekiden_current_role() to authenticated;
grant execute on function public.ekiden_current_identifier() to authenticated;
grant execute on function public.ekiden_sign_in(text,text,text) to authenticated;
grant execute on function public.ekiden_sign_out() to authenticated;
grant execute on function public.ekiden_server_time_ms() to authenticated;
grant execute on function public.ekiden_claim_lock(text,text,text) to authenticated;
grant execute on function public.ekiden_release_lock(text,text,text) to authenticated;
grant execute on function public.ekiden_update_access_codes(text,text,text,text) to authenticated;
grant execute on function public.ekiden_set_team_code(text,text) to authenticated;
grant execute on function public.ekiden_delete_team_code(text) to authenticated;
grant execute on function public.ekiden_list_team_codes() to authenticated;
grant execute on function public.ekiden_clear_team_codes() to authenticated;

-- Enable Realtime for the key/value state table.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='ekiden_kv'
  ) then
    alter publication supabase_realtime add table public.ekiden_kv;
  end if;
end $$;

-- Safer application submission RPC: applicants can submit but cannot read the applications table.
create or replace function public.ekiden_submit_application(p_path text, p_value jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_value jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_path !~ '^applications/[A-Za-z0-9_\-]+$' then raise exception 'Invalid application path'; end if;
  if coalesce(p_value->>'id','')='' or p_path <> 'applications/'||(p_value->>'id') then raise exception 'Application ID mismatch'; end if;
  if exists (
    select 1 from public.ekiden_kv
    where path=p_path and coalesce(value->>'submittedBy','')<>auth.uid()::text
  ) then
    raise exception 'Application ID already exists';
  end if;
  safe_value := p_value
    || jsonb_build_object('submittedBy',auth.uid()::text,'status','pending')
    - 'issuedTeamNo' - 'issuedAccessCode' - 'approvedAt';
  insert into public.ekiden_kv(path,value,updated_at)
  values(p_path,safe_value,now())
  on conflict(path) do update set value=excluded.value,updated_at=now();
  return true;
end;
$$;

revoke all on function public.ekiden_sign_in(text,text,text) from public;
revoke all on function public.ekiden_sign_out() from public;
revoke all on function public.ekiden_server_time_ms() from public;
revoke all on function public.ekiden_claim_lock(text,text,text) from public;
revoke all on function public.ekiden_release_lock(text,text,text) from public;
revoke all on function public.ekiden_update_access_codes(text,text,text,text) from public;
revoke all on function public.ekiden_set_team_code(text,text) from public;
revoke all on function public.ekiden_delete_team_code(text) from public;
revoke all on function public.ekiden_list_team_codes() from public;
revoke all on function public.ekiden_clear_team_codes() from public;
revoke all on function public.ekiden_submit_application(text,jsonb) from public;

grant execute on function public.ekiden_submit_application(text,jsonb) to authenticated;

-- Application submissions must go through ekiden_submit_application(), not direct table writes.
drop policy if exists "ekiden application submit" on public.ekiden_kv;
drop policy if exists "ekiden application resubmit" on public.ekiden_kv;


-- v0.13 Certificate template storage
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

