# otoyo-ekiden-timer v0.9

## v0.9 の変更

- チーム用アクセスコードを新規発行時 **4桁** に変更
- 既存の旧6桁コードも移行用として一時的にログイン可能
- Supabaseのチームログイン照合RPCを安定化する `supabase-patch-v0.9.sql` を追加
- 登録チームごとに **PDF・印刷** ボタンを追加
- 全登録チームの **案内一括PDF・印刷** を追加
- 印刷物には大会名、開催日、会場、チーム番号、アクセスコード、代表者、15区間の登録走者、参考計測の説明を掲載
- PDFはブラウザの印刷画面から「PDFに保存」または紙印刷が可能

### 更新時の重要手順

1. Supabase SQL Editorで `supabase-patch-v0.9.sql` を実行
2. GitHub Pagesへv0.9を上書き
3. 既存6桁コードはそのままテスト可能
4. 4桁へ切り替える場合は管理者画面の「4桁コード再発行」

# school-events 接続済み版

このフォルダは Supabase プロジェクト `school-events` の Project URL と Publishable key を設定済みです。

- Project URL: `https://huimxdyqxowbbgrkrwjb.supabase.co`
- Firebase は使用しません
- GitHub Pages + Supabase 構成です
- `secret` / `service_role` キーは含めていません

# otoyo-ekiden-timer v0.8 — GitHub Pages + Supabase

Firebase版 v0.7 を **GitHub Pages + Supabase** 構成へ移行した版です。
画面・計測ロジック・申込・掲示板・参加者閲覧など、v0.7までの機能を引き継ぎます。

## v0.8 の主な変更

- Firebase SDK / Realtime Database を削除
- Supabase JavaScript v2 をブラウザから利用
- Postgres + Realtime で複数端末同期
- Supabase Auth の Anonymous Sign-In を利用
- 管理者・計測係A/B/C・チームのアクセスコード判定をPostgres RPC側へ移動
- チーム用アクセスコードを公開チームデータから分離
- 申込の氏名・電話・メール・住所などを、管理者以外から読めないRLS構成に変更
- 端末重複防止ロックをSupabase側で管理
- Supabaseサーバー時刻から端末時刻の補正値を取得
- 通信断時のローカルキューと復旧後再送を継続

## 最初にやること

1. Supabaseプロジェクトを作成
2. Authentication で Anonymous Sign-Ins を有効化
3. SQL Editor で `supabase-setup.sql` を実行
4. Dashboard の Connect から Project URL と Publishable key を確認
5. `supabase-config.js` に入力
6. このフォルダの中身を `OtoyoAcademy/otoyo-ekiden-timer` へアップロード
7. GitHub Pages を `main / (root)` で公開

詳しくは `SUPABASE_MIGRATION.md` を参照してください。

## Supabase設定ファイル

```js
window.EKIDEN_SUPABASE_CONFIG = {
  url: "https://xxxxx.supabase.co",
  publishableKey: "sb_publishable_xxxxx"
};
```

ブラウザには **Publishable key** のみを置きます。Secret key / service_role key は入れません。

## 初期アクセスコード

- 管理者: `1234`
- 計測A: `1111`
- 計測B: `2222`
- 計測C: `3333`

Supabase接続後、管理者画面から変更してください。

## Firebaseデータ

Firebase Realtime Databaseに保存されている既存データは自動移行しません。
現段階がダミーデータ中心であれば、Supabase接続後にデモデータを読み直す運用を推奨します。
