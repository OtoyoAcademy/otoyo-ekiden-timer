# Supabase migration notes - v0.15

`supabase-patch-v0.15.sql` を1回実行してください。

追加されるRPC: `public.ekiden_submit_funrun(text,jsonb)`

- 匿名認証済み利用者がファンラン受付を安全に送信するための関数です。
- `funRunEntries/*` は一般のSELECT対象には追加しません。管理者のみ一覧取得できます。
- 受付時に `attended=false` をサーバー側で強制します。参加済み処理は管理者のみ可能です。
- Storageの追加バケットは不要です。既存の非公開 `ekiden-assets` をファンラン参加証テンプレートにも使用します。
