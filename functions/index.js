// メール送信（Cloud Functions）。
// 送信サービス Brevo の鍵は Firebase のシークレット（BREVO_API_KEY）に入れる。コードには書かない。
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const BREVO_API_KEY = defineSecret("BREVO_API_KEY");

const isEmail = (s) => typeof s === "string" && /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(s);
const splitList = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

// 設定画面に登録してある担当者（差し出し人にできるのは、この人たちだけ）
async function loadSettings() {
  const snap = await admin.firestore().doc("settings/main").get();
  return snap.exists ? snap.data().values || {} : {};
}
function staffOf(values) {
  try {
    const a = JSON.parse(values.staff || "[]");
    return Array.isArray(a) ? a.filter((x) => x && x.email) : [];
  } catch (e) {
    return [];
  }
}

exports.sendMail = onCall(
  { secrets: [BREVO_API_KEY], region: "asia-northeast1", maxInstances: 5 },
  async (request) => {
    // ログインしていない人からの送信は受け付けない
    if (!request.auth) throw new HttpsError("unauthenticated", "ログインが必要です。");

    const { from, to, cc, subject, body, attachments } = request.data || {};
    const toList = splitList(to);
    const ccList = splitList(cc);

    if (!isEmail(from)) throw new HttpsError("invalid-argument", "差し出し人を選んでください。");
    if (!toList.length) throw new HttpsError("invalid-argument", "送付先のメールアドレスを入力してください。");
    for (const a of toList.concat(ccList)) {
      if (!isEmail(a)) throw new HttpsError("invalid-argument", "メールアドレスの形式が正しくありません：" + a);
    }
    if (toList.length + ccList.length > 10) throw new HttpsError("invalid-argument", "宛先は合わせて10件までにしてください。");
    if (typeof subject !== "string" || subject.trim() === "") throw new HttpsError("invalid-argument", "件名が空です。");
    if (typeof body !== "string" || body.trim() === "") throw new HttpsError("invalid-argument", "本文が空です。");

    // 添付（CSVなど）：3つまで、合わせて約3MBまで
    const files = Array.isArray(attachments) ? attachments : [];
    if (files.length > 3) throw new HttpsError("invalid-argument", "添付は3つまでにしてください。");
    let size = 0;
    for (const f of files) {
      if (!f || typeof f.name !== "string" || !/^[^\\/:*?"<>|\r\n]{1,80}\.(csv|pdf)$/i.test(f.name)) throw new HttpsError("invalid-argument", "添付のファイル名が正しくありません。");
      if (typeof f.content !== "string" || !/^[A-Za-z0-9+/=]+$/.test(f.content)) throw new HttpsError("invalid-argument", "添付の中身が正しくありません。");
      size += f.content.length;
    }
    if (size > 4000000) throw new HttpsError("invalid-argument", "添付が大きすぎます。");

    const values = await loadSettings();
    const me = staffOf(values).find((s) => String(s.email).toLowerCase() === from.toLowerCase());
    if (!me) throw new HttpsError("permission-denied", "この差し出し人は、設定の担当者に登録されていません。");

    const company = String(values.company || "").trim();
    const senderName = [company, String(me.name || "").trim()].filter(Boolean).join(" ");

    const payload = {
      sender: senderName ? { email: me.email, name: senderName } : { email: me.email },
      replyTo: { email: me.email }, // 返信は担当者のアドレスへ
      to: toList.map((email) => ({ email })),
      subject: subject.trim(),
      textContent: body,
    };
    if (ccList.length) payload.cc = ccList.map((email) => ({ email }));
    if (files.length) payload.attachment = files.map((f) => ({ name: f.name, content: f.content }));

    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": BREVO_API_KEY.value(), "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json()).message || ""; } catch (e) { detail = ""; }
      console.error("brevo error", res.status, detail);
      throw new HttpsError("internal", "送信サービスが受け付けませんでした（" + res.status + "）" + (detail ? "：" + detail : ""));
    }
    const data = await res.json();
    return { ok: true, messageId: data.messageId || null };
  }
);
