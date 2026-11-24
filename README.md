# grow-mgt

請求・入金管理のアプリ。

- `docs/`：アプリ本体（GitHub Pages で公開する部分）。データは Firebase（Firestore）に置き、ここには含めない
- `functions/`：メール送信（Cloud Functions）。まだ未接続
- `firestore.rules`：Firestore の読み書きの決まり（ログインした担当者だけ）
- `tools/`：データの書き出しに使った道具

取引先・請求書・口座などのデータは、このリポジトリには入れない。
