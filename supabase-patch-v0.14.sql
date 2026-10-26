-- Otoyo Ekiden Timer v0.14 patch
-- 年度切替時に旧大会の計測端末セッションとチームコードを安全に無効化します。
-- Run once in Supabase Dashboard -> SQL Editor.

create or replace function public.ekiden_prepare_new_event()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.ekiden_current_role() <> 'admin' then
    raise exception 'Admin required';
  end if;

  -- 旧大会の端末ロックを解除
  delete from public.ekiden_locks;

  -- 現在操作中の管理者だけを残し、旧大会の計測係・チームセッションを無効化
  delete from public.ekiden_sessions
  where user_id <> auth.uid();

  -- チーム番号は新大会で再発行するため、旧大会のチームコードを削除
  delete from public.ekiden_team_secrets;

  return true;
end;
$$;

revoke all on function public.ekiden_prepare_new_event() from public;
grant execute on function public.ekiden_prepare_new_event() to authenticated;
