// 先方が請求書を見るページ。メールの「請求書を確認する」ボタンから開く（ログイン不要・その請求書1枚だけ）
import { store } from './store.js';
import { renderInvoiceDoc, fitDocs } from './doc.js';
import { h } from './util.js';

const API = 'https://asia-northeast1-grow-mgt.cloudfunctions.net/viewInvoice';
const root = document.getElementById('view');
const say = (msg) => { root.innerHTML = `<p style="text-align:center;padding:60px 16px">${h(msg)}</p>`; };

async function main() {
  const t = new URLSearchParams(location.search).get('t') || '';
  if (!/^[a-f0-9]{32,64}$/.test(t)) { say('リンクが正しくありません。メールのボタンから、もう一度お開きください。'); return; }
  let data;
  try {
    const res = await fetch(API + '?t=' + t, { cache: 'no-store' });
    data = await res.json();
    if (!res.ok) { say(data.error || '請求書を表示できませんでした。'); return; }
  } catch (e) { say('請求書を読み込めませんでした。少し時間をおいて、もう一度お試しください。'); return; }

  // 請求書の組み立て（管理画面・印刷と同じもの）に必要な分だけ渡す
  store.db = { settings: data.settings || {}, businesses: [data.business], clients: [], products: [], invoices: [] };
  const inv = data.invoice;
  document.title = '請求書 ' + inv.number + '｜' + (data.settings.company || '');
  root.innerHTML = `
    <div class="public-bar no-print" style="padding-left:12px;padding-right:12px">
      <span>${h(data.settings.company || '')} からの請求書</span>
      <button class="btn primary" id="savePdf">PDFで保存・印刷する</button>
    </div>
    <div class="view-sheet">${renderInvoiceDoc(inv)}</div>
    <p class="small muted no-print" style="text-align:center;margin-top:14px">「PDFで保存・印刷する」を押し、送信先で「PDFに保存」を選ぶと、PDFファイルで保存できます。</p>`;
  fitDocs(root);
  root.querySelector('#savePdf').addEventListener('click', () => window.print());
}
main();
