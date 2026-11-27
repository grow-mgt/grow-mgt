// 請求書の一覧（今までの index.php と同じ画面）
import { store } from '../store.js';
import { state, go, setFilter, once } from '../nav.js';
import { needsCheck, isReconcile, statusOf, statusBadge, setInvoiceStatus, allowedStatuses, STATUS_LABELS } from '../logic.js';
import { h, yen, today, slashDate, isYmd } from '../util.js';
import { flash, showFlash, confirmBox, askDate } from '../ui.js';

// ステータスを選ぶ小さなメニュー（画面のどこかを押したら閉じる）
let menu = null;
const close = () => { if (menu) { menu.remove(); menu = null; } };
document.addEventListener('click', close);
window.addEventListener('hashchange', close);

export function listPage() {
  const bid = state.biz;
  const B = bid ? store.bizOf(bid) : null;
  const rec = B && isReconcile(B);
  const word = rec ? '入金予定' : '請求書';
  const filter = state.filter === 'reminded' ? 'overdue' : state.filter, q = state.q.trim(); // 「督促済」の絞り込みはやめたので、覚えていたら期限超過として扱う
  const td = today(), ym = td.slice(0, 7);
  const clientName = (v) => (store.client(v.client_id) || {}).name || '（取引先なし）';

  const all = [...store.db.invoices].sort((a, b) => (a.issue_date < b.issue_date ? 1 : a.issue_date > b.issue_date ? -1 : b.id - a.id));
  let rows = bid ? all.filter((r) => r.business_id === bid) : all;

  // GROW全体：事業ごとの集計
  const byBiz = {};
  for (const b of store.businesses()) byBiz[b.id] = { unpaid: 0, overdue: 0, paid_month: 0, count_unpaid: 0, fy: 0 };
  const fyYear = Number(td.slice(5, 7)) >= 4 ? Number(td.slice(0, 4)) : Number(td.slice(0, 4)) - 1;
  const fyStart = fyYear + '-04-01';
  for (const r of all) {
    const k = byBiz[r.business_id]; if (!k) continue;
    const st = statusOf(r);
    if (r.status !== 'paid' && r.status !== 'draft') { k.unpaid += r.total - r.paid_amount; k.count_unpaid++; }
    if (st === 'overdue' || st === 'reminded') k.overdue += r.total - r.paid_amount;
    if (r.status === 'paid' && String(r.paid_at || '').slice(0, 7) === ym) k.paid_month += r.total;
    if (r.status !== 'draft' && r.issue_date >= fyStart) k.fy += r.total;
  }
  const sum = { unpaid: 0, overdue: 0, paid_month: 0, unopened: 0 };
  for (const r of rows) {
    const st = statusOf(r);
    if (r.status !== 'paid' && r.status !== 'draft') sum.unpaid += r.total - r.paid_amount;
    if (st === 'overdue' || st === 'reminded') sum.overdue += r.total - r.paid_amount;
    if (r.status === 'paid' && String(r.paid_at || '').slice(0, 7) === ym) sum.paid_month += r.total;
    if (r.status === 'sent' && r.source_ref !== 'invoy') sum.unopened++;
  }
  rows = rows.filter((r) => {
    const st = statusOf(r);
    if (filter === 'unpaid' && (r.status === 'paid' || r.status === 'draft')) return false;
    if (filter === 'overdue' && st !== 'overdue' && st !== 'reminded') return false;
    if (filter === 'reminded' && st !== 'reminded') return false;
    if (filter === 'draft' && r.status !== 'draft') return false;
    if (filter === 'paid' && r.status !== 'paid') return false;
    if (filter === 'sent' && !(r.status === 'sent' || r.status === 'opened')) return false;
    if (q !== '' && !(clientName(r) + ' ' + r.number + ' ' + r.title).toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  let html = '';
  if (bid === 0) {
    const tot = { unpaid: 0, overdue: 0, paid_month: 0, fy: 0 };
    for (const v of Object.values(byBiz)) for (const k of Object.keys(tot)) tot[k] += v[k];
    html += `<h1>GROW全体</h1>
    <div class="stats">
      <div class="stat"><span>未入金（全事業）</span><b>${yen(tot.unpaid)}</b></div>
      <div class="stat warn"><span>期限超過（全事業）</span><b>${yen(tot.overdue)}</b></div>
      <div class="stat ok"><span>今月の入金（全事業）</span><b>${yen(tot.paid_month)}</b></div>
      <div class="stat"><span>今年度の請求・入金予定（${fyYear}年度）</span><b>${yen(tot.fy)}</b></div>
    </div>
    <div class="biz-cards">${store.businesses().map((b) => { const v = byBiz[b.id]; return `
      <a class="card biz-card" href="#list" data-biz="${b.id}">
        <div class="bc-head"><b>${h(b.name)}</b><span class="badge ${isReconcile(b) ? 'b-opened' : 'b-sent'}">${isReconcile(b) ? '入金消込' : '請求書'}</span></div>
        <dl>
          <div><dt>未入金</dt><dd>${yen(v.unpaid)} <small>（${v.count_unpaid}件）</small></dd></div>
          <div><dt>期限超過</dt><dd class="${v.overdue ? 'warn' : ''}">${yen(v.overdue)}</dd></div>
          <div><dt>今月の入金</dt><dd>${yen(v.paid_month)}</dd></div>
          <div><dt>今年度</dt><dd>${yen(v.fy)}</dd></div>
        </dl>
        ${String(b.bank || '').trim() === '' ? '<p class="small warn-text">振込先の口座が未設定です</p>' : ''}
      </a>`; }).join('')}</div>
    <h2>全事業の${filter === 'overdue' ? '期限超過' : '請求書・入金予定'}</h2>`;
  } else {
    html += `<div class="head-row">
      <h1>${h(B.name)} <span class="muted small">の${word}</span></h1>
      <div class="btns">
        ${bid === 1 ? `<a class="btn" href="#cbm">CBMの請求書から作る</a>` : ''}
        ${rec ? `<a class="btn" href="#expect">毎月の入金予定をまとめて作る</a>` : `<a class="btn" href="#fixed">毎月の固定の請求をまとめて作る</a>`}
        <a class="btn primary" href="#new">＋ ${word}を作る</a>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><span>未入金</span><b>${yen(sum.unpaid)}</b></div>
      <div class="stat warn"><span>期限超過</span><b>${yen(sum.overdue)}</b></div>
      <div class="stat ok"><span>今月の入金</span><b>${yen(sum.paid_month)}</b></div>
      ${rec ? `<div class="stat"><span>今年度の入金予定</span><b>${yen(byBiz[bid].fy)}</b></div>` : `<div class="stat"><span>未開封</span><b>${sum.unopened}件</b></div>`}
    </div>`;
  }

  // 検索欄の候補：いま見ている事業で、請求書がある取引先（名前順）
  const qIds = new Set((bid ? all.filter((r) => r.business_id === bid) : all).map((r) => r.client_id));
  const qClients = store.db.clients.filter((c) => qIds.has(c.id)).sort((x, y) => x.name.localeCompare(y.name, 'ja'));
  const chips = rec ? { all: 'すべて', unpaid: '入金待ち', overdue: '期限超過', paid: '入金済' }
    : { all: 'すべて', unpaid: '未入金', overdue: '期限超過', draft: '下書き', sent: '送付済・開封済', paid: '入金済' };
  html += `<form class="filters" id="filters">
    ${Object.entries(chips).map(([k, label]) => `<a href="#list" data-f="${k}" class="chip${filter === k ? ' on' : ''}">${label}</a>`).join('')}
    <span class="q-wrap">
      <input type="search" name="q" value="${h(q)}" placeholder="取引先・番号で検索" autocomplete="off">
      <div class="pick-list q-list" id="qList" hidden><div class="pick-items">${qClients.map((c) => `<button type="button" class="pick-item${c.name === q ? ' on' : ''}" data-name="${h(c.name)}" data-key="${h((c.name + ' ' + (c.corp_name || '')).toLowerCase())}">${h(c.name)}${c.corp_name ? `<small>${h(c.corp_name)}</small>` : ''}</button>`).join('')}</div></div>
    </span>
  </form>`;

  if (!rows.length) {
    html += `<div class="empty">${bid ? word : '請求書・入金予定'}はまだありません。${bid && filter === 'all' && q === '' ? `<br><a href="#clients">取引先を登録</a>してから${word}を作りましょう。` : ''}</div>`;
  } else {
    html += `<form id="bulk">
    <div class="bulk-bar" hidden>
      <b><span class="n">0</span>件を</b>
      <select name="status">
        <option value="">ステータスを選ぶ</option><option value="draft">下書き</option><option value="sent">送付済</option><option value="opened">開封済</option><option value="reminded">督促済（期限超過のみ）</option><option value="paid">入金済</option>
      </select>
      <label id="bulkPd" hidden>入金日 <input type="date" name="paid_date" value="${td}"></label>
      <button class="btn primary small">まとめて変える</button>
      <button type="button" class="btn small" id="bulkPdf">選んだ請求書をPDFで保存</button>
      <button type="button" class="btn small" id="bulkMail">選んだ請求書をまとめてメール</button>
    </div>
    <div class="table-wrap">
    <table class="list">
      <thead><tr><th class="ck"><input type="checkbox" id="ckAll" title="すべて選ぶ"></th><th>ステータス</th>${!bid ? '<th>事業</th>' : ''}<th>取引先</th><th>件名</th><th class="r sortable" data-key="num" title="クリックで並べ替え">金額</th><th class="sortable" data-key="date" title="クリックで並べ替え">発行日</th><th>期限</th><th>${rec ? '番号' : '請求書番号'}</th></tr></thead>
      <tbody id="invRows">
      ${rows.map((r) => `
        <tr class="${r.incomplete === 1 ? 'row-incomplete' : ''}" data-id="${r.id}">
          <td class="ck"><input type="checkbox" name="ids" value="${r.id}"></td>
          <td><span class="st-pick" data-id="${r.id}" data-st="${h(r.status)}" title="クリックしてステータスを変える">${statusBadge(r)}</span>${r.incomplete === 1 ? '<br><span class="badge b-partial">未完成：価格未設定</span>' : ''}${needsCheck(r) ? '<br><span class="badge warn">備考あり・要確認</span>' : ''}</td>
          ${!bid ? `<td class="small muted">${h(store.bizOf(r.business_id).name)}</td>` : ''}
          <td>${h(clientName(r))}</td>
          <td class="muted ttl" title="${h(r.title)}">${h(r.title)}</td>
          <td class="r" data-v="${r.total}">${yen(r.total)}</td>
          <td data-v="${h(r.issue_date)}">${h(slashDate(r.issue_date))}</td>
          <td>${h(slashDate(r.due_date))}</td>
          <td class="mono"><a href="#invoice-${r.id}">${h(r.number)}</a></td>
        </tr>`).join('')}
      </tbody>
    </table>
    </div>
    </form>`;
  }

  return {
    title: bid ? word : 'GROW全体', active: 'list', html,
    mount(root) {
      // 絞り込み・検索
      // 絞り込みを変えても、画面の位置が動かないようにする（ボタンの高さを覚えておく）
      const hold = () => { const el = root.querySelector('#filters'); once.keepTop = el ? el.getBoundingClientRect().top : null; };
      root.querySelectorAll('[data-f]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); hold(); setFilter(a.dataset.f, state.q); go('list'); }));
      const ff = root.querySelector('#filters');
      ff.addEventListener('submit', (e) => { e.preventDefault(); hold(); setFilter(state.filter, ff.q.value); go('list'); });
      ff.q.addEventListener('search', () => { hold(); setFilter(state.filter, ff.q.value); go('list'); });
      // 検索欄：自由に打てる＋取引先の一覧から選べる
      const ql = root.querySelector('#qList');
      if (ql) {
        const narrow = () => { const k = ff.q.value.trim().toLowerCase(); let n = 0; ql.querySelectorAll('.pick-item').forEach((b) => { b.hidden = k !== '' && !b.dataset.key.includes(k) && b.dataset.name !== ff.q.value; if (!b.hidden) n++; }); return n; };
        const open = (on) => { ql.hidden = !on || narrow() === 0; };
        ff.q.addEventListener('focus', () => { ql.querySelectorAll('.pick-item').forEach((b) => { b.hidden = false; }); ql.hidden = false; });
        ff.q.addEventListener('input', () => open(true));
        ff.q.addEventListener('keydown', (e) => { if (e.key === 'Escape') open(false); });
        ql.addEventListener('mousedown', (e) => e.preventDefault()); // 一覧を押しても入力欄からフォーカスを外さない
        ql.addEventListener('click', (e) => { const b = e.target.closest('.pick-item'); if (!b) return; hold(); setFilter(state.filter, b.dataset.name); go('list'); });
        ff.q.addEventListener('blur', () => setTimeout(() => open(false), 120));
      }

      const tb = root.querySelector('#invRows'); if (!tb) return;
      // 行をクリックで詳細へ（チェック欄とステータスは除く）
      tb.addEventListener('click', (e) => {
        if (e.target.closest('.ck') || e.target.closest('.st-pick') || e.target.closest('a')) return;
        const tr = e.target.closest('tr'); if (tr) go('invoice-' + tr.dataset.id);
      });
      // 金額・発行日の見出しを押すと、その列で並べ替え（もう一度押すと逆順）
      root.querySelectorAll('th.sortable').forEach((th) => th.addEventListener('click', () => {
        const idx = [...th.parentNode.children].indexOf(th);
        const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
        root.querySelectorAll('th.sortable').forEach((x) => { delete x.dataset.dir; });
        th.dataset.dir = dir;
        const isNum = th.dataset.key === 'num';
        const trs = [...tb.querySelectorAll('tr')];
        trs.sort((a, b) => {
          let va = a.children[idx].dataset.v || '', vb = b.children[idx].dataset.v || '';
          if (isNum) { va = Number(va); vb = Number(vb); }
          const r = va > vb ? 1 : (va < vb ? -1 : 0);
          return dir === 'asc' ? r : -r;
        });
        trs.forEach((r) => tb.appendChild(r));
      }));

      // まとめて操作
      const f = root.querySelector('#bulk'), bar = f.querySelector('.bulk-bar'), allCk = root.querySelector('#ckAll');
      const checked = () => [...f.querySelectorAll('input[name="ids"]:checked')].map((c) => Number(c.value));
      const upd = () => { const n = checked().length; bar.hidden = !n; bar.querySelector('.n').textContent = n; };
      f.addEventListener('change', upd);
      f.status.addEventListener('change', () => { root.querySelector('#bulkPd').hidden = f.status.value !== 'paid'; });
      allCk.addEventListener('change', () => { f.querySelectorAll('input[name="ids"]').forEach((c) => { c.checked = allCk.checked; }); upd(); });
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const ids = checked(), st = f.status.value, pd = f.paid_date.value;
        if (!ids.length || !STATUS_LABELS[st]) { showFlash('請求書とステータスを選んでください。', 'err'); return; }
        if (st === 'paid' && !(await confirmBox('選んだ請求書を入金済にしますか？'))) return;
        let done = 0, skip = 0;
        for (const id of ids) { const inv = store.invoice(id); if (inv.status !== st && setInvoiceStatus(inv, st, isYmd(pd) ? pd : null)) { await store.saveInvoice(inv); done++; } else if (inv.status !== st) skip++; }
        flash(done + '件のステータスを「' + STATUS_LABELS[st] + '」に変えました。' + (skip ? (st === 'reminded' ? ` ${skip}件は、期限超過ではない（または督促済）ので、そのままにしました。` : ` ${skip}件は、開封済・入金済のため戻せないので、そのままにしました。`) : ''), skip ? 'warn' : 'ok'); hold(); go('list');
      });
      root.querySelector('#bulkPdf').addEventListener('click', () => { const ids = checked(); if (ids.length) go('print-' + ids.join('-')); });
      root.querySelector('#bulkMail').addEventListener('click', () => { const ids = checked(); if (ids.length) go('bulkmail-' + ids.join('-')); });

      // ステータスの表示をクリックすると、選び直せる
      const names = { draft: '下書き', sent: '送付済', opened: '開封済', overdue: '期限超過', reminded: '督促済', paid: '入金済' };
      root.querySelectorAll('.st-pick').forEach((el) => el.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault(); close();
        menu = document.createElement('div');
        menu.style.cssText = 'position:absolute;background:#fff;border:1px solid #ccc;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.15);padding:4px;z-index:50;font-size:13px';
        const r = el.getBoundingClientRect();
        menu.style.left = (window.scrollX + r.left) + 'px'; menu.style.top = (window.scrollY + r.bottom + 4) + 'px';
        menu.addEventListener('click', (ev) => ev.stopPropagation());
        const invNow = store.invoice(Number(el.dataset.id)), okSt = allowedStatuses(invNow);
        const so = statusOf(invNow), curSt = so === 'reminded' || so === 'overdue' ? so : invNow.status;
        for (const st of Object.keys(names).filter((k) => okSt.includes(k) || k === curSt)) {
          const b = document.createElement('button');
          b.type = 'button'; b.textContent = names[st] + (st === curSt ? '（現在）' : '');
          b.style.cssText = 'display:block;width:100%;text-align:left;border:0;background:none;padding:6px 10px;cursor:pointer;font:inherit';
          b.addEventListener('click', async () => {
            close();
            let pd = null;
            if (st === 'paid') { pd = await askDate('入金日', today()); if (!pd) return; }
            const inv = store.invoice(Number(el.dataset.id));
            if (st === curSt) return;
            if (!setInvoiceStatus(inv, st, pd)) { showFlash('このステータスには変えられません。', 'err'); return; }
            await store.saveInvoice(inv);
            flash('1件のステータスを「' + names[st] + '」に変えました。'); hold(); go('list');
          });
          menu.appendChild(b);
        }
        document.body.appendChild(menu);
      }));
    },
  };
}
