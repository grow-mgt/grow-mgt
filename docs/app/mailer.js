// メールを送る窓口。
//  - プレビュー：送らない（送ったことにして、画面の流れだけ確かめる）
//  - 本番：Cloud Functions の sendMail を呼ぶ（Firebaseのプロジェクトができてからつなぐ）
import { store } from './store.js';

const isEmail = (s) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(s);

export async function sendMail({ from, to, cc, subject, body, invoice, attachments }) {
  if (!from || !isEmail(from)) throw new Error('差し出し人（担当者）を選んでください。');
  for (const addr of (to + ',' + (cc || '')).split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!isEmail(addr)) throw new Error('メールアドレスの形式が正しくありません：' + addr);
  }
  if (store.isPreview) return { ok: true, simulated: true };
  if (!store.backend.sendMail) throw new Error('メール送信は、まだFirebaseにつないでいません。');
  return store.backend.sendMail({ from, to, cc, subject, body, invoiceId: invoice && invoice.id, attachments: attachments || [] });
}
