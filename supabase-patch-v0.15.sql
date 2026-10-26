-- Otoyo Ekiden Timer v0.15 patch
-- ファンラン一般受付を安全にSupabaseへ保存するRPCを追加します。
-- Run once in Supabase Dashboard -> SQL Editor.

create or replace function public.ekiden_submit_funrun(p_path text, p_value jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  safe_value jsonb;
  cfg jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_path !~ '^funRunEntries/[A-Za-z0-9_\-]+$' then raise exception 'Invalid fun run path'; end if;
  if coalesce(p_value->>'id','')='' or p_path <> 'funRunEntries/'||(p_value->>'id') then raise exception 'Fun run ID mismatch'; end if;

  select value into cfg from public.ekiden_kv where path='settings';
  if cfg is not null then
    if coalesce((cfg->>'funRunEnabled')::boolean,true)=false then raise exception 'Fun run disabled'; end if;
    if coalesce((cfg->>'funRunEntryOpen')::boolean,true)=false then raise exception 'Fun run entry closed'; end if;
  end if;

  if exists (
    select 1 from public.ekiden_kv
    where path=p_path and coalesce(value->>'submittedBy','')<>auth.uid()::text
  ) then
    raise exception 'Fun run ID already exists';
  end if;

  safe_value := p_value
    || jsonb_build_object('submittedBy',auth.uid()::text,'attended',false,'source','web')
    - 'attendedAt';

  insert into public.ekiden_kv(path,value,updated_at)
  values(p_path,safe_value,now())
  on conflict(path) do update set value=excluded.value,updated_at=now();
  return true;
end;
$$;

revoke all on function public.ekiden_submit_funrun(text,jsonb) from public;
grant execute on function public.ekiden_submit_funrun(text,jsonb) to authenticated;

notify pgrst, 'reload schema';
