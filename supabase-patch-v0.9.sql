-- =========================================================
-- school-events / 駅伝アプリ v0.9 patch
-- チームログイン照合の安定化 + 4桁コード運用
-- ofes_* テーブルは変更しません。
-- =========================================================

create extension if not exists pgcrypto;
set search_path = public, extensions;

-- チームコード保存：4桁を標準とする。
-- 移行直後の旧6桁コードも残っている可能性があるため、4〜6桁を許容します。
create or replace function public.ekiden_set_team_code(p_team_no text, p_code text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  normalized_team text := trim(coalesce(p_team_no,''));
  normalized_code text := trim(coalesce(p_code,''));
begin
  if public.ekiden_current_role() <> 'admin' then
    raise exception 'Admin required';
  end if;

  if normalized_team = '' then
    raise exception 'Team number required';
  end if;

  if normalized_code !~ '^[0-9]{4,6}$' then
    raise exception 'Team access code must be 4 to 6 digits';
  end if;

  insert into public.ekiden_team_secrets(team_no,access_code,secret_hash,updated_at)
  values(normalized_team, normalized_code, crypt(normalized_code, gen_salt('bf')), now())
  on conflict(team_no) do update
    set access_code=excluded.access_code,
        secret_hash=excluded.secret_hash,
        updated_at=now();
  return true;
end;
$$;

-- ログイン照合を安定化。
-- 保存済みaccess_codeの完全一致を優先し、旧hash照合も残します。
create or replace function public.ekiden_sign_in(p_role text, p_identifier text, p_passcode text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  ok boolean := false;
  target_hash text;
  stored_code text;
  normalized_id text := nullif(trim(coalesce(p_identifier,'')), '');
  normalized_code text := trim(coalesce(p_passcode,''));
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  if p_role = 'admin' then
    select secret_hash into target_hash
      from public.ekiden_secrets where key='admin';
    ok := target_hash is not null and crypt(normalized_code, target_hash)=target_hash;
    normalized_id := 'admin';

  elsif p_role = 'operator' and normalized_id in ('A','B','C') then
    select secret_hash into target_hash
      from public.ekiden_secrets where key='operator:'||normalized_id;
    ok := target_hash is not null and crypt(normalized_code, target_hash)=target_hash;

  elsif p_role = 'team' and normalized_id is not null then
    select access_code, secret_hash
      into stored_code, target_hash
      from public.ekiden_team_secrets
      where team_no=normalized_id;

    ok := stored_code is not null
          and (
            stored_code = normalized_code
            or (target_hash is not null and crypt(normalized_code, target_hash)=target_hash)
          );
  end if;

  if not ok then
    return jsonb_build_object('ok',false);
  end if;

  insert into public.ekiden_sessions(user_id,role,identifier,expires_at,updated_at)
  values(auth.uid(),p_role,normalized_id,now()+interval '12 hours',now())
  on conflict(user_id) do update
    set role=excluded.role,
        identifier=excluded.identifier,
        expires_at=excluded.expires_at,
        updated_at=now();

  return jsonb_build_object('ok',true,'role',p_role,'identifier',normalized_id);
end;
$$;

revoke all on function public.ekiden_set_team_code(text,text) from public;
revoke all on function public.ekiden_sign_in(text,text,text) from public;
grant execute on function public.ekiden_set_team_code(text,text) to authenticated;
grant execute on function public.ekiden_sign_in(text,text,text) to authenticated;

-- =========================================================
-- 実行後、既存の6桁コードはそのままログイン可能です。
-- 管理者画面の「4桁コード再発行」を押すと4桁へ切替できます。
-- =========================================================
