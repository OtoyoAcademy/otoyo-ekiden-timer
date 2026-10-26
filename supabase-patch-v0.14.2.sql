-- Otoyo Ekiden Timer v0.14.2 patch
-- Supabase の safe-update 設定に対応し、全件DELETEにも明示的な WHERE 句を付けます。

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

  -- safe-update 対応: 全件削除でも WHERE 句を明示
  delete from public.ekiden_locks where true;

  -- 現在操作中の管理者セッションだけ残す
  delete from public.ekiden_sessions
  where user_id is distinct from auth.uid();

  -- 旧大会のチーム用コードを無効化
  delete from public.ekiden_team_secrets where true;

  return true;
end;
$$;

create or replace function public.ekiden_clear_team_codes()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.ekiden_current_role() is distinct from 'admin' then
    raise exception 'Admin required';
  end if;
  delete from public.ekiden_team_secrets where true;
  return true;
end;
$$;

revoke all on function public.ekiden_prepare_new_event() from public;
grant execute on function public.ekiden_prepare_new_event() to authenticated;
revoke all on function public.ekiden_clear_team_codes() from public;
grant execute on function public.ekiden_clear_team_codes() to authenticated;

notify pgrst, 'reload schema';
