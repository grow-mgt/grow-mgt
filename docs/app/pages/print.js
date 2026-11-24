// PDF保存用：選んだ請求書を1つずつ改ページして並べる（今までの print_bulk.php と同じ）
import { store } from '../store.js';
import { renderInvoiceDoc } from '../doc.js';
import { h } from '../util.js';

export function printPage(ids) {
  const invs = ids.map((id) => store.invoiceFull(id)).filter(Boolean);
  if (!invs.length) return null;
  const back = invs.length === 1 ? 'invoice-' + invs[0].id : 'list';
  return {
    bare: true, title: 'PDFで保存',
    html: `<div class="no-print" style="background:#1f2430;color:#fff;padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap;position:sticky;top:0;z-index:5">
        <b>${invs.length}件の請求書</b>
        <span class="small">「印刷する」を押し、送信先で「PDFに保存」を選んでください。</span>
        <span id="printMsg" class="small" style="color:#ffd27a"></span>
        <span style="margin-left:auto;display:flex;gap:8px"><a class="btn small" href="#${h(back)}">戻る</a><button class="btn primary small" id="doPrint">印刷する（PDFで保存）</button></span>
      </div>
      <div style="background:#fff">${invs.map((v) => `<div class="pb">${renderInvoiceDoc(v)}</div>`).join('')}</div>`,
    mount(root) {
      root.querySelector('#doPrint').addEventListener('click', () => {
        if (store.isPreview) { root.querySelector('#printMsg').textContent = 'プレビューの中では印刷画面を開けません。本番では、ここで印刷（PDF保存）の画面が開きます。'; return; }
        window.print();
      });
    },
  };
}
