// メール送信（Cloud Functions）。
// 送信サービス Brevo の鍵は Firebase のシークレット（BREVO_API_KEY）に入れる。コードには書かない。
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
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

// 請求書を見るページの置き場所（ここ以外のリンクは、ボタンにしない）
const ALLOWED_VIEW = ["https://grow-mgt.github.io/grow-mgt/view.html?t="];
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const para = (text) => esc(text.trim()).replace(/\n/g, "<br>");

// 本文（文字）から、ボタンつきのHTMLメールを作る。リンクの行はボタンに置き換える
function invoiceHtml(body, url) {
  const lines = String(body).replace(/\r\n?/g, "\n").split("\n");
  const at = lines.findIndex((l) => l.includes(url));
  const before = (at >= 0 ? lines.slice(0, at) : lines).join("\n");
  const after = at >= 0 ? lines.slice(at + 1).join("\n") : "";
  // 書体はゴシック体（端末の標準の書体）。メールソフトによっては指定が引き継がれないので、すべての部品に直接付ける
  const ff = "font-family:-apple-system,BlinkMacSystemFont,Helvetica Neue,Hiragino Sans,Hiragino Kaku Gothic ProN,Yu Gothic,Meiryo,Arial,sans-serif;";
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body,table,td,div,p,a,span{${ff}}</style></head><body style="margin:0;padding:0;background:#f4f5f7;${ff}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;${ff}"><tr><td align="center" style="padding:24px 12px;${ff}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;${ff}"><tr><td style="padding:32px 28px;${ff}font-size:15px;line-height:1.8;color:#222222;">
<div style="${ff}">${para(before)}</div>
<div style="${ff}text-align:center;padding:28px 0 8px;font-weight:bold;font-size:14px;">下のボタンから請求書の内容をご確認ください。<br>PDFで保存・印刷することもできます。</div>
<div style="${ff}text-align:center;padding:12px 0 28px;"><a href="${esc(url)}" style="${ff}display:inline-block;background:#2f6fde;color:#ffffff;text-decoration:none;font-weight:bold;font-size:19px;padding:15px 44px;border-radius:999px;">請求書を確認する</a></div>
${after.trim() !== "" ? `<div style="${ff}">${para(after)}</div>` : ""}
<div style="${ff}border-top:1px solid #dddddd;margin-top:24px;padding-top:14px;font-size:12px;line-height:1.7;color:#777777;">ボタンが開けない場合は、下のリンクをブラウザに貼り付けてください。<br><a href="${esc(url)}" style="${ff}color:#777777;word-break:break-all;">${esc(url)}</a><br>このメールにそのまま返信すると、担当者に届きます。</div>
</td></tr></table></td></tr></table></body></html>`;
}

exports.sendMail = onCall(
  { secrets: [BREVO_API_KEY], region: "asia-northeast1", maxInstances: 5 },
  async (request) => {
    // ログインしていない人からの送信は受け付けない
    if (!request.auth) throw new HttpsError("unauthenticated", "ログインが必要です。");

    const { from, to, cc, subject, body, attachments, invoiceUrl } = request.data || {};
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
    // 請求書のメール：リンクの行を「請求書を確認する」ボタンにしたHTML版も付ける（文字だけの版も一緒に送る）
    if (invoiceUrl != null && invoiceUrl !== "") {
      if (typeof invoiceUrl !== "string" || !ALLOWED_VIEW.some((p) => invoiceUrl.startsWith(p)) || /[\s"'<>]/.test(invoiceUrl)) {
        throw new HttpsError("invalid-argument", "請求書のリンクが正しくありません。");
      }
      payload.htmlContent = invoiceHtml(body, invoiceUrl);
    }
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

// 先方が請求書を見るページ（view.html）に、その請求書1枚分のデータを渡す。ログイン不要。リンクの合言葉（token）を知っている人だけが見られる
exports.viewInvoice = onRequest(
  { region: "asia-northeast1", maxInstances: 5, cors: ["https://grow-mgt.github.io"] },
  async (req, res) => {
    res.set("Cache-Control", "no-store");
    const t = String(req.query.t || "");
    if (req.method !== "GET" || !/^[a-f0-9]{32,64}$/.test(t)) { res.status(400).json({ error: "リンクが正しくありません。" }); return; }
    const db = admin.firestore();
    const snap = await db.collection("invoices").where("token", "==", t).limit(1).get();
    if (snap.empty) { res.status(404).json({ error: "請求書が見つかりません。リンクをもう一度お確かめください。" }); return; }
    const ref = snap.docs[0].ref, inv = snap.docs[0].data();
    if (inv.status === "draft") { res.status(404).json({ error: "この請求書は、まだ発行されていません。" }); return; }

    const [cSnap, bSnap, values] = await Promise.all([
      db.doc("clients/" + inv.client_id).get(),
      db.doc("businesses/" + (inv.business_id || 1)).get(),
      loadSettings(),
    ]);
    const c = cSnap.exists ? cSnap.data() : {};
    const b = bSnap.exists ? bSnap.data() : {};

    // 開いた記録を残す（送付済み → 開封済み）
    try {
      const now = new Date().toISOString().slice(0, 19).replace("T", " ");
      const upd = { open_count: admin.firestore.FieldValue.increment(1) };
      if (!inv.opened_at) upd.opened_at = now;
      if (inv.status === "sent") {
        upd.status = "opened";
        upd.events = admin.firestore.FieldValue.arrayUnion({ id: Date.now() * 1000, type: "open", detail: "先方が請求書を開きました", created_at: now });
      }
      await ref.update(upd);
    } catch (e) { console.error("open mark failed", e); }

    const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k] == null ? "" : o[k]]));
    res.json({
      invoice: {
        ...pick(inv, ["number", "title", "issue_date", "due_date", "notes", "withholding", "tax_mode", "business_id", "status"]),
        items: (inv.items || []).map((it) => pick(it, ["name", "qty", "unit", "price", "tax_rate", "product_id", "item_date", "ship_to"])),
        client_name: c.name || "", honorific: c.honorific || "", corp_name: c.corp_name || "", merge_items: Number(c.merge_items) === 1 ? 1 : 0,
      },
      settings: pick(values, ["company", "representative", "reg_no", "postal", "address", "tel", "fax", "email", "seal_image", "bank"]),
      business: { id: inv.business_id || 1, bank: b.bank || "" },
    });
  }
);
