// まとめて行う2つの画面：
//  1) 毎月の入金予定をまとめて作る（今までの expect_batch.php）
//  2) 選んだ請求書をまとめてメールで送る（今までの bulk_send.php）
import { store } from '../store.js';
import { state, go } from '../nav.js';
import { needsCheck, calcInvoice, nextNumber, fillTemplate } from '../logic.js';
import { sendMail } from '../mailer.js';
import { staffList } from './settings.js';
import { h, yen, today, nowUtc, slashDate, randomToken } from '../util.js';
import { flash, showFlash, confirmBox } from '../ui.js';

const sel = { month: '' };
const pad = (n) => String(n).padStart(2, '0');

/* ---------- 毎月の入金予定 ---------- */
// 入金の消し込みだけの事業（スマート介護・不動産賃貸業など）で、取引先ごとの「毎月の入金」から、その月の入金予定を作る
export function expectPage() {
  const B = store.bizOf(state.biz || store.businesses()[0].id);
  const td = today();
  const month = /^\d{4}-\d{2}$/.test(sel.month) ? sel.month : td.slice(0, 7);
  const y = Number(month.slice(0, 4)), m = Number(month.slice(5, 7));
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const due = `${month}-${pad(Number(B.due_day) > 0 ? Math.min(Number(B.due_day), lastDay) : lastDay)}`;
  const label = `令和${y - 2018}年${m}月分`;
  const recOf = (cid) => store.db.recurring.filter((r) => r.client_id === cid).sort((a, b) => (a.sort - b.sort) || (a.id - b.id));
  const plan = store.db.clients.filter((c) => c.business_id === B.id && recOf(c.id).length).sort((a, b) => a.name.localeCompare(b.name, 'ja')).map((c) => {
    const items = recOf(c.id), ref = 'monthly:' + month + ':' + c.id;
    return { client: c, items, ref, done: store.db.invoices.find((v) => v.source_ref === ref) || null, total: calcInvoice(items, false).total };
  });

  const html = `
<p class="crumb"><a href="#list">${h(B.name)}の入金予定</a> ›</p>
<h1>毎月の入金予定をまとめて作る <span class="muted small">${h(B.name)}</span></h1>
<div class="filters">
  <label class="check">対象の月 <input type="month" id="expMonth" value="${h(month)}" style="width:auto;margin-left:8px"></label>
  <span class="muted small">期日：${h(slashDate(due))}（設定の「毎月の入金予定の期日」）</span>
</div>
${!plan.length ? '<div class="empty">「毎月の入金」を登録した取引先がまだありません。<br><a href="#client-new">取引先を登録</a>して、「毎月の入金（家賃など）」に金額を入れてください。</div>' : `
<form id="expForm">
  <div class="table-wrap">
  <table class="list">
    <thead><tr><th class="ck"></th><th>取引先</th><th>内容</th><th class="r">金額</th><th>期日</th><th></th></tr></thead>
    ${plan.map((p) => `
      <tr class="${p.done ? 'done' : ''}" style="cursor:default">
        <td class="ck">${p.done ? '' : `<input type="checkbox" name="make" value="${p.client.id}" checked>`}</td>
        <td>${h(p.client.name)}</td>
        <td class="small">${h(p.items.map((i) => i.name).join('、'))}</td>
        <td class="r">${yen(p.total)}</td>
        <td>${h(slashDate(due))}</td>
        <td class="small">${p.done ? `<a href="#invoice-${p.done.id}">作成済 ${h(p.done.number)}</a>` : ''}</td>
      </tr>`).join('')}
  </table>
  </div>
  <div class="actions"><button class="btn primary">チェックした${h(label)}の入金予定を作る</button></div>
</form>`}`;

  return {
    title: '毎月の入金予定をまとめて作る', active: 'list', html,
    mount(root) {
      root.querySelector('#expMonth').addEventListener('change', (e) => { sel.month = e.target.value; go('expect'); });
      const f = root.querySelector('#expForm'); if (!f) return;
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const pick = new Set([...f.querySelectorAll('input[name="make"]:checked')].map((c) => Number(c.value)));
        let n = 0;
        for (const p of plan) {
          if (p.done || !pick.has(p.client.id)) continue;
          const base = store.newId();
          const items = p.items.map((i, k) => ({ id: base + k, name: i.name, qty: Number(i.qty), unit: i.unit, price: Number(i.price), tax_rate: Number(i.tax_rate), amount: Math.round(i.qty * i.price), product_id: null, item_date: '', ship_to: '' }));
          const calc = calcInvoice(items, false);
          const inv = { id: base + 900, number: nextNumber(), client_id: p.client.id, title: label + ' ' + (items[0] ? items[0].name : ''), issue_date: td, due_date: due, notes: '', withholding: 0,
            subtotal: calc.subtotal, tax: calc.tax, withholding_amount: 0, total: calc.total, token: randomToken(), status: 'sent', sent_at: nowUtc(), opened_at: null, open_count: 0, paid_at: null, paid_amount: 0,
            created_at: nowUtc(), source_ref: p.ref, business_id: B.id, tax_mode: 'exclude', incomplete: 0, items, payments: [], events: [] };
          store.logEvent(inv, 'create', label + 'の入金予定をまとめて作成');
          await store.saveInvoice(inv);
          n++;
        }
        flash(n ? `${label}の入金予定を${n}件作りました。入金照合で銀行の入金と突き合わせられます。` : '作った入金予定はありません。', n ? 'ok' : 'warn');
        go('list');
      });
    },
  };
}

/* ---------- まとめてメール ---------- */
// 選んだ請求書を、それぞれの取引先のメールアドレスへまとめて送る（送る前に一覧で確認してから押す）
export function bulkMailPage(ids) {
  const list = ids.map((id) => store.invoiceFull(id)).filter(Boolean);
  if (!list.length) return null;
  const staff = staffList();
  let last = ''; try { last = localStorage.getItem('grow-mgt-sender') || ''; } catch (e) { last = ''; }
  const note = (inv) => (inv.incomplete === 1 ? '<span class="badge b-partial">未完成のため送りません</span>' : needsCheck(inv) ? '<span class="badge warn">備考の確認がまだのため送りません</span>' : (String(inv.client_email || '').trim() === '' ? '<span class="badge b-partial">メールアドレスがないため送りません</span>' : ''));
  const sendable = list.filter((inv) => inv.incomplete !== 1 && !needsCheck(inv) && String(inv.client_email || '').trim() !== '').length;

  const html = `
<p class="crumb"><a href="#list">請求書の一覧</a> ›</p>
<h1>請求書をまとめてメールで送る</h1>
<p class="muted small">次の${list.length}件を、それぞれの取引先のメールアドレスへ送ります。送る内容は、設定のメールの文面です。</p>
${staff.length ? `<label style="max-width:420px;margin-bottom:12px">差し出し人（担当者）<select id="bulkFrom">${staff.map((x) => `<option value="${h(x.email)}"${x.email === last ? ' selected' : ''}>${h((x.name ? x.name + ' ' : '') + '<' + x.email + '>')}</option>`).join('')}</select></label>`
    : '<div class="flash warn">差し出し人にする担当者が未登録です。<a href="#settings">設定</a>の「メール送信」で登録してください。</div>'}
<div class="table-wrap">
<table class="list">
  <thead><tr><th>請求書番号</th><th>取引先</th><th>送付先</th><th class="r">金額</th><th>状態</th></tr></thead>
  ${list.map((inv) => `
    <tr style="cursor:default">
      <td>${h(inv.number)}</td>
      <td>${h(inv.client_name)}</td>
      <td class="small">${h(inv.client_email || '（未登録）')}${(inv.client_cc || '') !== '' ? '<br>CC: ' + h(inv.client_cc) : ''}</td>
      <td class="r">${yen(inv.total)}</td>
      <td class="small">${note(inv)}</td>
    </tr>`).join('')}
</table>
</div>
<div class="actions">
  <span class="muted small">送れるのは${sendable}件です。</span>
  <a class="btn" href="#list">やめる</a>
  <button class="btn primary" id="bulkGo"${staff.length && sendable ? '' : ' disabled'}>送る</button>
</div>`;

  return {
    title: '請求書をまとめてメールで送る', active: 'list', html,
    mount(root) {
      root.querySelector('#bulkGo').addEventListener('click', async (e) => {
        const from = root.querySelector('#bulkFrom').value;
        if (!(await confirmBox(sendable + '件を送ります。よろしいですか？', '送る'))) return;
        e.target.disabled = true;
        try { localStorage.setItem('grow-mgt-sender', from); } catch (err) { /* 覚えられなくても送れる */ }
        let ok = 0, simulated = false; const skip = [];
        for (const inv of list) {
          const to = String(inv.client_email || '').trim(), cc = String(inv.client_cc || '').trim();
          if (inv.incomplete === 1) { skip.push(inv.number + '（未完成）'); continue; }
          if (needsCheck(inv)) { skip.push(inv.number + '（備考の確認がまだ）'); continue; }
          if (to === '') { skip.push(inv.number + '（メールアドレスなし）'); continue; }
          try {
            const r = await sendMail({ from, to, cc, subject: fillTemplate(store.setting('mail_subject'), inv), body: fillTemplate(store.setting('mail_body'), inv), invoice: inv });
            simulated = simulated || !!r.simulated;
            const raw = store.invoice(inv.id);
            raw.sent_at = nowUtc(); if (raw.status === 'draft') raw.status = 'sent';
            store.logEvent(raw, 'send', (r.simulated ? '（プレビュー：実際には送っていません）' : '') + 'まとめてメール送信：' + to + (cc ? '（CC ' + cc + '）' : '') + '／差し出し人 ' + from);
            await store.saveInvoice(raw);
            ok++;
          } catch (err) { skip.push(inv.number + '（送信できず：' + err.message + '）'); }
        }
        flash((simulated ? 'プレビューのため実際には送っていません。送ったときと同じく、' + ok + '件を「送付済」にしました。' : ok + '件をメールで送りました。') + (skip.length ? '送れなかった請求書：' + skip.join('、') : ''), skip.length || simulated ? 'warn' : 'ok');
        go('list');
      });
    },
  };
}
