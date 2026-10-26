-- Otoyo Ekiden Timer v0.14.1 patch
-- v0.14 RPCを再作成し、PostgRESTのスキーマキャッシュを明示的に再読込します。

create or replace function public.ekiden_prepare_new_event()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.ekiden_current_role() is distinct from 'admin' then
    raise exception 'Admin required';
  end if;

  delete from public.ekiden_locks;

  delete from public.ekiden_sessions
  where user_id is distinct from auth.uid();

  delete from public.ekiden_team_secrets;

  return true;
end;
$$;

revoke all on function public.ekiden_prepare_new_event() from public;
grant execute on function public.ekiden_prepare_new_event() to authenticated;

-- Supabase Data API / PostgREST に新しいRPCを即時認識させる
notify pgrst, 'reload schema';
