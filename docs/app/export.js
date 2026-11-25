// 表をCSVにして、書き出す・メールで送る（管理表・取引先などで共通）
import { store } from './store.js';
import { h, isEmail } from './util.js';
import { showFlash } from './ui.js';
import { sendMail } from './mailer.js';
import { staffList } from './pages/settings.js';

const cell = (c) => { const s = String(c == null ? '' : c); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
// Excelでそのまま開けるように、先頭に目印（BOM）を付ける
export const csvText = (table) => '﻿' + table.map((r) => r.map(cell).join(',')).join('\r\n');

// 文字を、メールに添付できる形（base64）にする
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** CSVで書き出す（プレビューの中ではファイルを保存できないので、貼り付けられる形でコピーする） */
const NO_EXPORT = 'CSVを書き出す権限がありません。必要なときは、権限のある人に頼んでください。';
export async function exportCsv(table, filename) {
  if (!store.canExport()) { showFlash(NO_EXPORT, 'err'); return; }
  if (store.isPreview) {
    try { await navigator.clipboard.writeText(table.map((r) => r.join('\t')).join('\n')); showFlash('表をコピーしました。スプレッドシートやExcelに貼り付けてください。（本番ではCSVファイルで保存されます）'); }
    catch (err) { showFlash('コピーできませんでした。', 'err'); }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csvText(table)], { type: 'text/csv' })); a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}

/** CSVを添付してメールで送る（小窓）。files：[{name, table}] */
export function mailCsv({ title, files, subject, body }) {
  if (!store.canExport()) { showFlash(NO_EXPORT, 'err'); return; }
  const staff = staffList();
  if (!staff.length) { showFlash('差し出し人にする担当者が未登録です。設定の「メール送信」で登録してください。', 'err'); return; }
  let last = ''; try { last = localStorage.getItem('grow-mgt-sender') || ''; } catch (e) { last = ''; }
  let lastTo = ''; try { lastTo = localStorage.getItem('grow-mgt-csv-to') || ''; } catch (e) { lastTo = ''; }
  const cur = staff.find((x) => x.email === last) || staff[0];
  let dlg = document.getElementById('csvMailDialog');
  if (!dlg) {
    dlg = document.createElement('dialog'); dlg.id = 'csvMailDialog';
    dlg.style.cssText = 'border:0;border-radius:10px;padding:20px 22px;width:min(560px,94vw);box-shadow:0 10px 30px rgba(0,0,0,.25)';
    document.body.appendChild(dlg);
  }
  dlg.innerHTML = `
    <form class="form" method="dialog">
      <h2 style="margin-top:0">${h(title)}</h2>
      <label>差し出し人（担当者）<select name="from">${staff.map((x) => `<option value="${h(x.email)}"${x.email === cur.email ? ' selected' : ''}>${h((x.name ? x.name + ' ' : '') + '<' + x.email + '>')}</option>`).join('')}</select></label>
      <label>宛先（社内の担当者・税理士など。カンマで区切ると複数に送れます）<input name="to" value="${h(lastTo)}" placeholder="tax@example.com"></label>
      <label>件名<input name="subject" value="${h(subject)}"></label>
      <label>本文<textarea name="body" rows="7">${h(body)}</textarea></label>
      <p class="small muted">添付：${files.map((f) => h(f.name) + '（' + (f.table.length - 1) + '行）').join('、')}</p>
      <p class="small" data-msg style="color:#b3261e"></p>
      <div class="actions"><button type="button" class="btn" data-close>閉じる</button><button class="btn primary">送信する</button></div>
    </form>`;
  const f = dlg.querySelector('form'), msg = dlg.querySelector('[data-msg]');
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const to = f.to.value.trim(), from = f.from.value;
    const list = to.split(',').map((s) => s.trim()).filter(Boolean);
    if (!list.length || !list.every(isEmail)) { msg.textContent = '宛先のメールアドレスを確かめてください。'; return; }
    const btn = f.querySelector('button.primary'); btn.disabled = true; msg.textContent = '';
    try {
      const r = await sendMail({ from, to: list.join(','), cc: '', subject: f.subject.value.trim(), body: f.body.value,
        attachments: files.map((x) => ({ name: x.name, content: toBase64(csvText(x.table)) })) });
      try { localStorage.setItem('grow-mgt-sender', from); localStorage.setItem('grow-mgt-csv-to', list.join(', ')); } catch (err) { /* 覚えられなくても送れる */ }
      dlg.close();
      showFlash(r.simulated ? 'プレビューのため、メールは実際には送っていません。（本番ではCSVを添付して送ります）' : 'CSVを添付して、メールで送りました：' + list.join('、'), r.simulated ? 'warn' : 'ok');
    } catch (err) { msg.textContent = err.message; btn.disabled = false; }
  });
  dlg.showModal();
}
