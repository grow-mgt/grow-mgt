// 毎月の固定の請求をまとめて作る（今までの fixed_batch.php と同じ画面）
// 消耗品の購入がない月でも、取引先の「毎月の固定の請求」（コンサルティングフィーなど）を、その月の下書きとして作る
import { store } from '../store.js';
import { state, go, setFilter } from '../nav.js';
import { isReconcile, calcInvoice, nextNumber } from '../logic.js';
import { h, yen, today, nowUtc, endOfNextMonth, slashDate, randomToken } from '../util.js';
import { flash } from '../ui.js';

const sel = { month: '' };

export function fixedPage() {
  const B = store.bizOf(state.biz || store.businesses()[0].id);
  if (isReconcile(B)) return null;
  const td = today();
  const month = /^\d{4}-\d{2}$/.test(sel.month) ? sel.month : td.slice(0, 7);
  const mNum = Number(month.slice(5, 7));
  const issue = td;                      // 発行日は今日
  const due = endOfNextMonth(issue);     // 支払期限は発行月の翌月末（CBMと同じ決まり）
  const titleMonth = mNum + '月分';
  const pat = new RegExp('(?<!\\d)' + mNum + '月分', 'u');

  const recOf = (cid) => store.db.recurring.filter((r) => r.client_id === cid).sort((a, b) => (a.sort - b.sort) || (a.id - b.id));
  const plan = store.db.clients.filter((c) => c.business_id === B.id && recOf(c.id).length).sort((a, b) => a.name.localeCompare(b.name, 'ja')).map((c) => {
    const items = recOf(c.id);
    const ref = 'fixed:' + month + ':' + c.id;
    const done = store.db.invoices.find((v) => v.source_ref === ref) || null;
    // 同じ月分（件名の「◯月分」）に、同じ項目がすでにある請求書があれば作らない
    const dup = done ? null : (store.db.invoices.find((v) => v.client_id === c.id && (v.items || []).some((it) => it.name === items[0].name) && pat.test(String(v.title))) || null);
    return { client: c, items, ref, done, dup, total: calcInvoice(items, false).total };
  });

  const html = `
<p class="crumb"><a href="#list">${h(B.name)}の請求書</a> ›</p>
<h1>毎月の固定の請求をまとめて作る <span class="muted small">${h(B.name)}</span></h1>
<p class="muted small">消耗品の購入がない月でも、取引先の「毎月の固定の請求」（コンサルティングフィーなど）を、下書きとして作ります。同じ月に同じ項目がすでに請求されている取引先は作りません。</p>
<div class="filters">
  <label class="check">対象の月 <input type="month" id="fixMonth" value="${h(month)}" style="width:auto;margin-left:8px"></label>
  <span class="muted small">発行日：今日 ／ 支払期限：${h(slashDate(due))}（発行月の翌月末）</span>
</div>
${!plan.length ? '<div class="empty">「毎月の固定の請求」を登録した取引先がまだありません。<br><a href="#clients">取引先を開いて、「月額固定の請求」に金額を入れてください。</a></div>' : `
<form id="fixForm">
  <div class="table-wrap">
  <table class="list">
    <thead><tr><th class="ck"></th><th>取引先</th><th>内容</th><th class="r">金額</th><th>状態</th></tr></thead>
    ${plan.map((p) => { const skip = p.done || p.dup; return `
      <tr class="${skip ? 'done' : ''}" style="cursor:default">
        <td class="ck">${skip ? '' : `<input type="checkbox" name="make" value="${p.client.id}" checked>`}</td>
        <td>${h(p.client.name)}</td>
        <td class="small">${h(p.items.map((i) => i.name).join('、'))}</td>
        <td class="r">${yen(p.total)}</td>
        <td class="small">${p.done ? `<a href="#invoice-${p.done.id}">作成済み ${h(p.done.number)}</a>` : (p.dup ? `同じ月に請求済み（${h(p.dup.number)}）のため作りません` : '作ります')}</td>
      </tr>`; }).join('')}
  </table>
  </div>
  <div class="actions"><button class="btn primary">選んだ取引先の下書きを作る</button></div>
</form>`}`;

  return {
    title: '毎月の固定の請求をまとめて作る', active: 'list', html,
    mount(root) {
      root.querySelector('#fixMonth').addEventListener('change', (e) => { sel.month = e.target.value; go('fixed'); });
      const f = root.querySelector('#fixForm'); if (!f) return;
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pick = new Set([...f.querySelectorAll('input[name="make"]:checked')].map((c) => Number(c.value)));
        let n = 0;
        for (const p of plan) {
          if (p.done || p.dup || !p.items.length || !pick.has(p.client.id)) continue;
          const base = store.newId();
          const items = p.items.map((i, k) => ({ id: base + k, name: i.name, qty: Number(i.qty), unit: i.unit, price: Number(i.price), tax_rate: Number(i.tax_rate), amount: Math.round(i.qty * i.price), product_id: null, item_date: '', ship_to: '' }));
          const calc = calcInvoice(items, false);
          const inv = { id: base + 900, number: nextNumber(issue), client_id: p.client.id, title: p.items[0].name + ' ' + titleMonth, issue_date: issue, due_date: due, notes: '振込手数料はご負担願います。', withholding: 0,
            subtotal: calc.subtotal, tax: calc.tax, withholding_amount: 0, total: calc.total, token: randomToken(), status: 'draft', sent_at: null, opened_at: null, open_count: 0, paid_at: null, paid_amount: 0,
            created_at: nowUtc(), source_ref: p.ref, business_id: B.id, tax_mode: 'exclude', incomplete: 0, items, payments: [], events: [] };
          store.logEvent(inv, 'create', month + 'の固定の請求を下書きとして作成');
          await store.saveInvoice(inv);
          n++;
        }
        flash(n ? `${titleMonth}の固定の請求を${n}件、下書きで作りました。内容を確認して送ってください。` : '作った下書きはありません（作成済み、または同じ項目が請求済みです）。', n ? 'ok' : 'warn');
        setFilter('draft', ''); go('list');
      });
    },
  };
}
