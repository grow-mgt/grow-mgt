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

export function renderInvoiceDoc(inv) {
  const s = store.settings();
  const items = inv.items || [];
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

  // 宛名は法人名（なければ取引先名）。1店舗で法人名と違うときは店名を下に添える
  const toName = String(inv.corp_name || '').trim() !== '' ? inv.corp_name : inv.client_name;
  const toSub = (toName !== inv.client_name && !hasShip) ? inv.client_name : '';

  let rows = '';
  for (const [g, list] of groups) {
    if (g !== '') rows += `<tr class="sec"><td></td><td>${h(g === 'その他' ? 'その他' : shortStore(g, inv.client_name))}</td><td></td><td></td><td></td></tr>`;
    for (const it of list) {
      const isHead = Number(it.qty) === 0; // 数量0の行は店舗名などの見出し：数字は出さない
      rows += `<tr>
        <td class="c-date">${h(String(it.item_date || '').replace(/-/g, '/'))}</td>
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
      <p class="client">${h(toName)} ${h(inv.honorific)}</p>
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
    <thead><tr><th class="c-date">取引日</th><th>品目</th><th class="c-qty">数量</th><th class="c-price">単価</th><th class="c-amt">金額</th></tr></thead>
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
