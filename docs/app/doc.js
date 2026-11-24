// 請求書本体の表示（管理画面のプレビュー・印刷で共通）。今までの invoice_doc.php と同じレイアウト
import { store } from './store.js';
import { calcInvoice } from './logic.js';
import { h, nf, nl2br, ymdJp } from './util.js';

function qtyText(it) {
  let q = Number(it.qty).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  return q + (it.unit !== '' && it.unit != null ? it.unit : '個');
}

// 店舗名から請求先の名前を外して短くする（「〇〇薬局 △△店」→「△△店」）
function shortStore(storeName, clientName) {
  const s = String(storeName).trim();
  for (const p of [clientName, String(clientName).replace(/^(株式会社|有限会社|合同会社)\s*/u, '')]) {
    if (p !== '' && s.startsWith(p) && [...s].length > [...p].length) {
      const rest = s.slice(p.length).trim();
      if (rest !== '') return rest;
    }
  }
  return s;
}

// 宛名が長いときは、1行に収まるように文字を小さくする（全角1文字＝1、半角＝0.58で幅を見積もる）
function fitSize(text, base, width, min) {
  let units = 0;
  for (const ch of String(text)) units += /[ -~｡-ﾟ]/.test(ch) ? (ch === ' ' ? 0.32 : 0.58) : 1;
  const size = Math.floor(width / Math.max(units, 1) * 10) / 10;
  return size >= base ? null : Math.max(min, size);
}

// 同じ商品を1行にまとめる（取引日を出さない取引先用）。数量を足す
function mergeSame(list) {
  const out = new Map();
  for (const it of list) {
    const key = [it.product_id || 'n:' + it.name, it.price, it.tax_rate, it.unit || ''].join('|');
    const cur = out.get(key);
    if (cur) cur.qty = Number(cur.qty) + Number(it.qty);
    else out.set(key, { ...it, item_date: '' });
  }
  return [...out.values()];
}

export function renderInvoiceDoc(inv) {
  const s = store.settings();
  const items = inv.items || [];
  const merge = Number(inv.merge_items) === 1; // 取引日なし・同じ商品は店ごとにまとめる
  const taxMode = inv.tax_mode === 'include' ? 'include' : 'exclude';
  const calc = calcInvoice(items, !!inv.withholding, taxMode);

  // 店舗ごとにまとめる（店舗のない明細は最後の「その他」へ）
  const hasShip = items.some((it) => (it.ship_to || '') !== '');
  const groups = new Map();
  const OTHER = '\u0000その他';
  for (const it of items) {
    const g = hasShip ? ((it.ship_to || '') !== '' ? it.ship_to : OTHER) : '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(it);
  }
  if (groups.has(OTHER)) { const o = groups.get(OTHER); groups.delete(OTHER); groups.set('その他', o); }
  if (merge) for (const [g, list] of groups) groups.set(g, mergeSame(list));
  const dateTd = (v) => (merge ? '' : `<td class="c-date">${v}</td>`);

  // 宛名は法人名（なければ取引先名）。1店舗で法人名と違うときは店名を下に添える
  const toName = String(inv.corp_name || '').trim() !== '' ? inv.corp_name : inv.client_name;
  const toSub = (toName !== inv.client_name && !hasShip) ? inv.client_name : '';

  const fit = fitSize(toName + ' ' + inv.honorific, 18, 356, 10);

  let rows = '';
  for (const [g, list] of groups) {
    if (g !== '') rows += `<tr class="sec">${dateTd('')}<td>${h(g === 'その他' ? 'その他' : shortStore(g, inv.client_name))}</td><td></td><td></td><td></td></tr>`;
    for (const it of list) {
      const isHead = Number(it.qty) === 0; // 数量0の行は店舗名などの見出し：数字は出さない
      rows += `<tr>
        ${dateTd(h(String(it.item_date || '').replace(/-/g, '/')))}
        <td>${h(it.name)}${Number(it.tax_rate) === 8 ? ' <span class="mark">※</span>' : ''}</td>
        <td class="r">${isHead ? '' : h(qtyText(it))}</td>
        <td class="r">${isHead ? '' : nf(it.price)}</td>
        <td class="r">${isHead ? '' : nf(Math.round(Number(it.qty) * Number(it.price)))}</td>
      </tr>`;
    }
  }

  let taxRows = '';
  for (const rate of [10, 8]) {
    const b = calc.breakdown[rate] || { base: 0, tax: 0 };
    taxRows += `<tr><th>${rate}%対象</th><td>${nf(b.base)}</td><th>消費税</th><td>${nf(b.tax)}</td></tr>`;
  }
  if (calc.breakdown[0]) taxRows += `<tr><th>対象外</th><td>${nf(calc.breakdown[0].base)}</td><th></th><td></td></tr>`;

  let sumRows = `<tr><th>小計${taxMode === 'include' ? '（税抜）' : ''}</th><td>${nf(calc.subtotal)}</td></tr>`;
  for (const rate of calc.rates) { const b = calc.breakdown[rate]; if (rate > 0 && b.tax > 0) sumRows += `<tr><th>消費税 (${rate}%)</th><td>${nf(b.tax)}</td></tr>`; }
  if (inv.withholding) sumRows += `<tr><th>源泉徴収税</th><td>−${nf(calc.withholding_amount)}</td></tr>`;
  sumRows += `<tr class="grand"><th>合計</th><td>${nf(calc.total)}</td></tr>`;

  const bizBank = String((store.bizOf(inv.business_id || 1) || {}).bank || '').trim();
  const bank = bizBank !== '' ? bizBank : s.bank;

  return `
<article class="doc">
  <div class="doc-top">
    <p>${h(ymdJp(inv.issue_date))}</p>
    <p>請求書番号: ${h(inv.number)}</p>
  </div>
  <h1 class="doc-title">請 求 書</h1>

  <div class="doc-parties">
    <div class="to">
      <p class="client"${fit ? ` style="font-size:${fit}px"` : ''}>${h(toName)} ${h(inv.honorific)}</p>
      ${toSub !== '' ? `<p class="client-sub">${h(toSub)}</p>` : ''}
      ${inv.title ? `<p class="subject">件名：${h(inv.title)}</p>` : ''}
      <p class="lead">下記のとおりご請求申し上げます。</p>
      <div class="amount-box"><span>ご請求金額</span><b>¥ ${nf(calc.total)}</b></div>
      <p class="due">お支払期限：${h(ymdJp(inv.due_date))}</p>
    </div>
    <div class="from">
      <div class="from-text">
        <p class="company">${h(s.company)}</p>
        ${s.representative ? `<p class="rep">${h(s.representative)}</p>` : ''}
        ${s.reg_no ? `<p class="rep">登録番号: ${h(s.reg_no)}</p>` : ''}
        <p class="addr">${s.postal ? '〒' + h(String(s.postal).replace(/-/g, '')) + '<br>' : ''}${nl2br(s.address)}</p>
        <p class="tel">${s.tel ? 'TEL:' + h(s.tel) : ''}${(s.fax || '') !== '' ? '<br>FAX:' + h(s.fax) : ''}${s.email ? '<br>' + h(s.email) : ''}</p>
      </div>
      ${(s.seal_image || '') !== '' ? `<img class="seal" src="${h(s.seal_image)}" alt="印">` : ''}
    </div>
  </div>

  <table class="doc-items">
    <thead><tr>${merge ? '' : '<th class="c-date">取引日</th>'}<th>品目</th><th class="c-qty">数量</th><th class="c-price">単価</th><th class="c-amt">金額</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="doc-foot">
    <table class="doc-tax">${taxRows}</table>
    <table class="doc-sum">${sumRows}</table>
  </div>

  <div class="doc-bank">
    <p class="label">振込先</p>
    <div class="box">${nl2br(bank)}</div>
  </div>
  ${inv.notes ? `<div class="doc-bank"><p class="label">備考</p><div class="box">${nl2br(inv.notes)}</div></div>` : ''}
</article>`;
}

// 画面の幅に合わせて、請求書（A4の幅で組んだもの）を縮めて見せる。印刷のときは実寸
export function fitDocs(root) {
  const docs = [...root.querySelectorAll('.doc')];
  if (!docs.length) return;
  const apply = () => {
    for (const d of docs) {
      const box = d.parentElement, cs = getComputedStyle(box);
      const w = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (w > 0) d.style.setProperty('--doc-zoom', String(Math.min(1, Math.floor(w / 794 * 1000) / 1000)));
    }
  };
  apply();
  if (typeof ResizeObserver !== 'undefined') { const ro = new ResizeObserver(apply); for (const d of docs) ro.observe(d.parentElement); }
}
