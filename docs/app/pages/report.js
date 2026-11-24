// 事業ごとの月次集計（年度は4月〜翌3月）。今までの report.php と同じ画面
import { store } from '../store.js';
import { state, go, setBiz } from '../nav.js';
import { h, yen, nf, today } from '../util.js';
import { showFlash } from '../ui.js';

const sel = { fy: 0, basis: 'target' };
const pad = (n) => String(n).padStart(2, '0');
const toHalfNum = (s) => String(s).replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

// 件名の「令和8年8月分」「8月分」から対象の月を読む（なければ発行月）
function targetMonth(r) {
  const t = toHalfNum(r.title || ''), issue = String(r.issue_date).slice(0, 7);
  let m;
  if ((m = /令和\s*(\d+)\s*年\s*(\d{1,2})\s*月分/u.exec(t))) return `${2018 + Number(m[1])}-${pad(m[2])}`;
  if ((m = /(20\d{2})\s*年\s*(\d{1,2})\s*月分/u.exec(t))) return `${m[1]}-${pad(m[2])}`;
  if ((m = /(\d{1,2})\s*月分/u.exec(t))) {
    const y = Number(issue.slice(0, 4)), cand = `${y}-${pad(m[1])}`;
    return cand > issue ? `${y - 1}-${pad(m[1])}` : cand;
  }
  return issue;
}

export function reportPage() {
  const td = today();
  const fyNow = Number(td.slice(5, 7)) >= 4 ? Number(td.slice(0, 4)) : Number(td.slice(0, 4)) - 1;
  const fy = sel.fy || fyNow, basis = sel.basis, bid = state.biz;
  const months = [...Array(12).keys()].map((i) => { const mo = 3 + i; return `${fy + Math.floor(mo / 12)}-${pad((mo % 12) + 1)}`; });
  const inMonths = new Set(months);
  const cname = (id) => (store.client(id) || {}).name || '';
  const add = (obj, a, b, v) => { (obj[a] = obj[a] || {})[b] = ((obj[a] || {})[b] || 0) + v; };

  const invs = store.db.invoices.filter((v) => v.status !== 'draft');
  // 売上：事業×月（税込・税抜）、入金：事業×月
  const sales = {}, ex = {}, paid = {}, byClient = {}, unpaidNow = {};
  let noBreak = 0;
  if (basis !== 'paid') for (const r of invs) {
    const m = basis === 'issue' ? String(r.issue_date).slice(0, 7) : targetMonth(r);
    if (!inMonths.has(m)) continue;
    const b = r.business_id;
    add(sales, b, m, r.total);
    // invoyから取り込んだ請求書は明細がないので、税抜は分からない（税込のまま数える）
    const isInvoy = r.source_ref === 'invoy' && Number(r.tax) === 0;
    if (isInvoy) noBreak++;
    add(ex, b, m, isInvoy ? r.total : r.subtotal);
    if (bid && b === bid) add(byClient, cname(r.client_id), m, r.total);
  }
  for (const v of store.db.invoices) for (const p of v.payments || []) {
    const m = String(p.paid_date).slice(0, 7);
    if (!inMonths.has(m)) continue;
    add(paid, v.business_id, m, Number(p.amount));
    if (basis === 'paid') { add(sales, v.business_id, m, Number(p.amount)); if (bid && v.business_id === bid) add(byClient, cname(v.client_id), m, Number(p.amount)); }
  }
  for (const r of invs) if (r.status !== 'paid') unpaidNow[r.business_id] = (unpaidNow[r.business_id] || 0) + r.total - r.paid_amount;

  const bizList = bid ? [store.bizOf(bid)] : store.businesses();
  const rowOf = (obj, id) => months.map((m) => (obj[id] || {})[m] || 0);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const label = { target: '対象月（件名の「◯月分」）', issue: '発行月', paid: '入金月（入金額）' }[basis];
  const mLabel = (m) => Number(m.slice(5)) + '月';
  const tot = months.map((m) => bizList.reduce((a, b) => a + ((sales[b.id] || {})[m] || 0), 0));
  const max = Math.max(1, ...tot);
  const clients = Object.entries(byClient).map(([name, row]) => [name, months.map((m) => row[m] || 0)]).sort((a, b) => sum(b[1]) - sum(a[1]));
  const cells = (row) => row.map((v) => `<td class="r${v ? '' : ' zero'}">${v ? nf(v) : '-'}</td>`).join('');
  const mainWord = basis === 'paid' ? '入金額' : '売上（税込）';

  const html = `
<div class="head-row">
  <h1>月次集計 <span class="muted small">${bid ? h(store.bizOf(bid).name) : 'GROW全体'}・${fy}年度（${fy}年4月〜${fy + 1}年3月）</span></h1>
  <div class="btns">
    <button class="btn small" data-fy="${fy - 1}">← ${fy - 1}年度</button>
    <button class="btn small" data-fy="${fy + 1}">${fy + 1}年度 →</button>
    <button class="btn small" id="csvOut">${store.isPreview ? '表をコピーする' : 'CSVで書き出す'}</button>
  </div>
</div>
<div class="filters">
  <span class="muted small">集計の基準：</span>
  ${Object.entries({ target: '対象月（◯月分）', issue: '発行月', paid: '入金月' }).map(([k, l]) => `<a class="chip${basis === k ? ' on' : ''}" href="#report" data-basis="${k}">${l}</a>`).join('')}
</div>

<div class="card">
  <div class="mchart">
    ${months.map((m, i) => `
      <div class="mcol" title="${mLabel(m)} ${yen(tot[i])}">
        <div class="mbar-wrap">${bizList.map((b) => { const v = (sales[b.id] || {})[m] || 0; return v ? `<div class="mbar c${(b.id - 1) % 6}" style="height:${Math.round(v / max * 10000) / 100}%" title="${mLabel(m)} ${h(b.name)} ${yen(v)}"></div>` : ''; }).join('')}</div>
        <span class="mlbl">${mLabel(m)}</span>
      </div>`).join('')}
  </div>
  ${bizList.length > 1 ? `<div class="mlegend">${bizList.map((b) => `<span><i class="c${(b.id - 1) % 6}"></i>${h(b.name)}</span>`).join('')}</div>` : ''}
  <p class="small muted">${h(label)}で集計した${mainWord}です。下書きは入れていません。</p>
</div>

<div class="table-wrap">
<table class="list report">
  <thead><tr><th>事業</th><th></th>${months.map((m) => `<th class="r">${mLabel(m)}</th>`).join('')}<th class="r">年度合計</th></tr></thead>
  <tbody>
  ${bizList.map((b) => {
    const lines = basis === 'paid' ? [['入金額', rowOf(sales, b.id)]] : [['売上（税込）', rowOf(sales, b.id)], ['売上（税抜）', rowOf(ex, b.id)], ['入金額', rowOf(paid, b.id)]];
    return lines.map(([ln, row], i) => `
      <tr class="${i === 0 ? 'r-top' : 'r-sub'}">
        <td>${i === 0 ? `<a href="#report" data-rbiz="${b.id}">${h(b.name)}</a>` : ''}</td>
        <td class="small muted">${ln}</td>${cells(row)}<td class="r b">${nf(sum(row))}</td>
      </tr>`).join('')
      + (basis !== 'paid' ? `<tr class="r-sub"><td></td><td class="small muted">いまの未入金</td><td colspan="12"></td><td class="r ${unpaidNow[b.id] ? 'warn' : ''}">${nf(unpaidNow[b.id] || 0)}</td></tr>` : '');
  }).join('')}
  ${bizList.length > 1 ? `<tr class="r-total"><td>GROW合計</td><td class="small">${mainWord}</td>${tot.map((v) => `<td class="r">${v ? nf(v) : '-'}</td>`).join('')}<td class="r">${nf(sum(tot))}</td></tr>` : ''}
  </tbody>
</table>
</div>
${noBreak && basis !== 'paid' ? `<p class="small muted mt">※invoyから取り込んだ請求書${noBreak}件は明細（消費税の内訳）がないので、「売上（税抜）」にも税込の金額で入っています。</p>` : ''}

${bid && clients.length ? `
<h2>取引先ごとの内訳 <span class="muted small">${mainWord}</span></h2>
<div class="table-wrap">
<table class="list report">
  <thead><tr><th>取引先</th>${months.map((m) => `<th class="r">${mLabel(m)}</th>`).join('')}<th class="r">年度合計</th></tr></thead>
  <tbody>${clients.map(([name, row]) => `<tr><td>${h(name)}</td>${cells(row)}<td class="r b">${nf(sum(row))}</td></tr>`).join('')}</tbody>
</table>
</div>` : (!bid ? '<p class="small muted mt">事業名を押すと、その事業の取引先ごとの内訳が見られます。</p>' : '')}`;

  // 書き出す表（今までのCSVと同じ並び）
  function table() {
    const out = [['事業', '項目', ...months.map(mLabel), '年度合計']];
    for (const b of bizList) {
      const s = rowOf(sales, b.id); out.push([b.name, mainWord, ...s, sum(s)]);
      if (basis !== 'paid') {
        const e = rowOf(ex, b.id); out.push([b.name, '売上（税抜）', ...e, sum(e)]);
        const p = rowOf(paid, b.id); out.push([b.name, '入金額', ...p, sum(p)]);
      }
    }
    for (const [name, row] of clients) out.push([store.bizOf(bid).name + '：' + name, mainWord, ...row, sum(row)]);
    return out;
  }

  return {
    title: '月次集計', active: 'report', html,
    mount(root) {
      root.querySelectorAll('[data-fy]').forEach((b) => b.addEventListener('click', () => { sel.fy = Number(b.dataset.fy); go('report'); }));
      root.querySelectorAll('[data-basis]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); sel.basis = a.dataset.basis; go('report'); }));
      root.querySelectorAll('[data-rbiz]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); const f = state.filter, q = state.q; setBiz(a.dataset.rbiz); state.filter = f; state.q = q; go('report'); }));
      root.querySelector('#csvOut').addEventListener('click', async () => {
        const t = table();
        if (store.isPreview) {
          // プレビューの中ではファイルを保存できないので、表計算ソフトに貼り付けられる形でコピーする
          try { await navigator.clipboard.writeText(t.map((r) => r.join('\t')).join('\n')); showFlash('表をコピーしました。スプレッドシートやExcelに貼り付けてください。'); }
          catch (err) { showFlash('コピーできませんでした。', 'err'); }
          return;
        }
        const csv = '﻿' + t.map((r) => r.map((c) => (/[",\n]/.test(String(c)) ? '"' + String(c).replace(/"/g, '""') + '"' : c)).join(',')).join('\r\n');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `monthly_${fy}_${basis}.csv`; a.click();
        URL.revokeObjectURL(a.href);
      });
    },
  };
}
