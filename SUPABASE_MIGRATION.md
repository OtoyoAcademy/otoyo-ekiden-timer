# Firebase → Supabase 移行手順（駅伝アプリ v0.8）

## 1. Supabaseで新規プロジェクトを作成

学校で管理するSupabaseプロジェクトを作成します。

## 2. Anonymous Sign-Ins を有効化

Supabase Dashboard → Authentication で **Anonymous Sign-Ins** を有効にします。
このアプリは、参加者・申込者を含む各ブラウザを匿名認証し、RLSで権限を分けます。

## 3. SQLを実行

Dashboard → SQL Editor で `supabase-setup.sql` の内容をすべて実行します。

このSQLで以下を作ります。

- リアルタイム同期用 `ekiden_kv`
- 管理者・計測係・チームのセッション
- チームアクセスコードの保護領域
- 端末重複防止ロック
- RLS
- Realtime publication
- ログイン・コード変更用RPC

初期コードはこれまでと同じです。

- 管理者: `1234`
- 計測A: `1111`
- 計測B: `2222`
- 計測C: `3333`

本番前に管理者画面から変更してください。

## 4. URLとPublishable Keyを設定

Supabase Dashboard の **Connect** から、

- Project URL
- Publishable key (`sb_publishable_...`)

を確認して `supabase-config.js` に入力します。

**Secret key / service_role key は絶対にGitHubへ置かないでください。**

```js
window.EKIDEN_SUPABASE_CONFIG = {
  url: "https://xxxxx.supabase.co",
  publishableKey: "sb_publishable_xxxxx"
};
```

## 5. GitHub Pagesへアップロード

このフォルダの中身を `OtoyoAcademy/otoyo-ekiden-timer` のリポジトリ直下へ上書きします。

GitHub Pages:

- Source: Deploy from a branch
- Branch: main
- Folder: /(root)

## 6. 接続確認

公開URLを開き、上部の同期表示が **Supabase同期中** になれば接続成功です。

管理者ログイン → デモ12チーム読込 → 別端末の参加者画面で反映されることを確認します。

## Firebaseからのデータについて

v0.8は保存先をSupabaseへ切り替えるため、Firebase Realtime Databaseの既存データは自動移行しません。
現在がダミーデータ中心なら、Supabase側でデモデータを読み直すのが最も安全です。


## v0.13 証書テンプレート追加時

既存の `school-events` プロジェクトへv0.13を適用する場合は、`supabase-patch-v0.13.sql` をSQL Editorで1回実行します。

このパッチは次を行います。

- 公開済み正式結果・表彰設定を参加者画面から読めるよう `awards` の読み取りを追加
- 証書テンプレート・印画像専用の非公開 Supabase Storage bucket `ekiden-assets` を作成
- `certificates/` 配下の読み取り・アップロード・更新・削除を駅伝アプリの管理者セッションだけに許可
- 画像1ファイルの上限を3MBに設定
- PNG / JPEG / WebP のみ許可

完成した表彰状・記録証PDF自体はStorageへ保存しません。背景テンプレートと印画像だけを保存し、PDFはブラウザ側で都度生成します。
