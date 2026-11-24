// メール送信（Cloud Functions）。Firebase版の土台。
// 送信サービス（Brevoなど）のAPIキーは、Firebaseのシークレットに入れる（コードには書かない）。
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const BREVO_API_KEY = defineSecret("BREVO_API_KEY");
const ALLOWED_DOMAIN = "@grow.co.jp";

exports.sendMail = onCall(
  { secrets: [BREVO_API_KEY], region: "asia-northeast1" },
  async (request) => {
    // ログインしていない人からの送信は受け付けない
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "ログインが必要です。");
    }

    const { from, to, subject, html } = request.data || {};

    // 差し出し人は会社のドメインのみ
    if (typeof from !== "string" || !from.endsWith(ALLOWED_DOMAIN)) {
      throw new HttpsError("invalid-argument", "差し出し人は会社のアドレスにしてください。");
    }
    if (typeof to !== "string" || !to.includes("@")) {
      throw new HttpsError("invalid-argument", "宛先のメールアドレスが正しくありません。");
    }
    if (typeof subject !== "string" || subject.trim() === "") {
      throw new HttpsError("invalid-argument", "件名が空です。");
    }

    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": BREVO_API_KEY.value(),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { email: from },
        replyTo: { email: from },   // 返信は担当者のアドレスへ
        to: [{ email: to }],
        subject,
        htmlContent: html || "",
      }),
    });

    if (!res.ok) {
      const detail = await res.text();
      throw new HttpsError("internal", "送信に失敗しました: " + detail);
    }
    const data = await res.json();
    return { ok: true, messageId: data.messageId || null };
  }
);
