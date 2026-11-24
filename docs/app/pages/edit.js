// 請求書を作る・編集する（今までの invoice_edit.php と同じ画面）
import { store } from '../store.js';
import { state, once, go } from '../nav.js';
import { isReconcile, calcInvoice, nextNumber, priceInfo, refreshPaymentStatus } from '../logic.js';
import { syncLinesFromInvoice } from '../kanri-logic.js';
import { h, yen, num, today, nowUtc, addDays, endOfNextMonth, isYmd, randomToken } from '../util.js';
import { flash, showFlash } from '../ui.js';

const RATES = [[10, '10%'], [8, '8%※'], [0, '対象外']];
const qtyStr = (q) => { const s = String(q == null || q === '' ? 1 : q); return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') || '1' : s; };

function rowHtml(it) {
  const sub = (it.ship_to || '') !== '' || (it.item_date || '') !== '';
  return `<tr>
    <td><input value="${h(it.name)}" placeholder="商品名を入れると単価が入ります" list="itemNames" class="iname" autocomplete="off">
      <input type="hidden" value="${h(it.product_id ?? '')}" class="pid">
      <div class="sub-fields"${sub ? '' : ' hidden'}>
        <input value="${h(it.ship_to || '')}" placeholder="納品先" class="ship">
        <input value="${h(it.item_date || '')}" placeholder="取引日" class="idate">
      </div></td>
    <td><input value="${h(qtyStr(it.qty))}" inputmode="decimal" class="r qty"></td>
    <td><input value="${h(it.unit || '')}" placeholder="個" class="unit"></td>
    <td><input value="${h(it.price ?? '')}" inputmode="numeric" class="r price"><span class="hint"></span></td>
    <td><select class="rate">${RATES.map(([v, l]) => `<option value="${v}"${Number(it.tax_rate) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
    <td class="r amt"></td>
    <td><button type="button" class="icon del" title="この行を削除">×</button></td>
  </tr>`;
}
const BLANK = { name: '', qty: 1, unit: '', price: '', tax_rate: 10, product_id: '', ship_to: '', item_date: '' };

export function editPage({ id = 0, copy = 0 }) {
  const src = id || copy;
  const found = src ? store.invoice(src) : null;
  if (src && !found) return null;

  const EB = id ? store.bizOf(found.business_id) : store.bizOf(state.biz || store.businesses()[0].id);
  const erec = isReconcile(EB);
  const eword = erec ? '入金予定' : '請求書';
  const td = today();
  const dueDays = Math.max(0, parseInt(store.setting('due_days'), 10) || 0);
  let inv = { id: 0, number: nextNumber(), client_id: 0, title: '', issue_date: td, due_date: dueDays > 0 ? addDays(td, dueDays) : endOfNextMonth(td), notes: '', withholding: 0, tax_mode: 'exclude' };
  let items = [];
  if (found) {
    items = found.items || [];
    if (id) inv = found;
    else for (const k of ['client_id', 'title', 'notes', 'withholding', 'tax_mode']) inv[k] = found[k]; // 複製：番号と日付は新しく
  }
  if (!items.length) items = [BLANK];
  if (!id && once.newClient) { inv.client_id = once.newClient; once.newClient = 0; } // 取引先を登録して戻ってきたとき

  // その事業の取引先を上に、ほかの事業の取引先は下に
  const clients = [...store.db.clients].sort((a, b) => ((b.business_id === EB.id) - (a.business_id === EB.id)) || a.name.localeCompare(b.name, 'ja'));
  const products = store.db.products.filter((p) => p.active === 1).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const freeNames = [...new Set(store.db.invoices.flatMap((v) => (v.items || []).filter((it) => !it.product_id).map((it) => it.name)))].slice(-100);
  const locked = id && (inv.status === 'paid' || inv.status === 'partial');
  const heading = id ? eword + 'を編集' : (copy ? eword + 'を複製して作る' : eword + 'を作る');

  if (!clients.length) {
    return { title: heading, active: 'list', html: `<h1>${heading}</h1><div class="empty">先に取引先を登録してください。<br><a class="btn primary" href="#client-new">取引先を登録</a></div>` };
  }

  let prevOther = false;
  const clientOptions = clients.map((c) => {
    const other = c.business_id !== EB.id;
    let sep = '';
    if (other && !prevOther) { prevOther = true; sep = '<option disabled>── ほかの事業の取引先 ──</option>'; }
    return `${sep}<option value="${c.id}"${Number(inv.client_id) === c.id ? ' selected' : ''}>${h(c.name + ' ' + (c.honorific || ''))}</option>`;
  }).join('');

  const html = `
<h1>${heading} <span class="muted small">${h(EB.name)}</span></h1>
${erec ? '<p class="muted small">入金の消し込みだけの事業なので、先方には送りません。保存すると「入金待ち」になり、入金照合で銀行の入金と突き合わせます。</p>' : ''}
${id && inv.sent_at ? '<div class="flash warn">この請求書は送付済みです。変更すると、先方がリンクを開いたときに新しい内容が表示されます。</div>' : ''}
<form class="card form" id="invForm">
  <div class="grid3">
    <label class="span2">取引先 <em>必須</em>
      <select name="client_id" required><option value="">選んでください</option>${clientOptions}</select>
      <small><a href="#client-new" id="newClientLink">＋ 新しい取引先を登録</a></small>
    </label>
    <label>請求書番号<input name="number" value="${h(inv.number)}" required class="mono"></label>
    <label class="span3">件名<input name="title" value="${h(inv.title)}" placeholder="${erec ? '例：令和8年11月分 家賃' : '例：薬局消耗品 令和8年10月分'}"></label>
    <label>発行日<input type="date" name="issue_date" value="${h(inv.issue_date)}" required></label>
    <label>お支払期限<input type="date" name="due_date" value="${h(inv.due_date)}" required></label>
  </div>

  <h2>明細</h2>
  <div class="table-wrap">
  <table class="items" id="items">
    <thead><tr><th>品名・内容</th><th class="w-qty">数量</th><th class="w-unit">単位</th><th class="w-price">単価（税抜）</th><th class="w-rate">税率</th><th class="w-amt r">金額</th><th></th></tr></thead>
    <tbody>${items.map(rowHtml).join('')}</tbody>
  </table>
  </div>
  <div class="row-btns">
    <button type="button" class="btn small" id="addRow">＋ 行を追加</button>
    <button type="button" class="btn small" id="addRec" hidden>＋ 月額固定の明細を入れる</button>
    <button type="button" class="btn small" id="showSub">納品先・取引日を入れる</button>
  </div>
  <datalist id="itemNames">${products.map((p) => `<option value="${h(p.name)}">`).join('')}${freeNames.map((n) => `<option value="${h(n)}">`).join('')}</datalist>
  <div class="learn">
    <label class="check small"><input type="checkbox" name="remember" value="1"> 単価を手で変えた商品は、その金額をこの取引先の単価として覚える<span class="muted">（価格表スプレッドシートに載っている商品は、次の読み込みで価格表の金額に戻ります。ずっと変えるなら価格表を直してください）</span></label>
    <label class="check small"><input type="checkbox" name="add_products" value="1"> 商品一覧にない品名を、新しい商品として登録する</label>
  </div>

  <div class="totals-row">
    <label class="span2">税の計算
      <select name="tax_mode" id="taxMode">
        <option value="exclude"${inv.tax_mode !== 'include' ? ' selected' : ''}>外税（金額は税抜。税を足す）</option>
        <option value="include"${inv.tax_mode === 'include' ? ' selected' : ''}>内税（金額は税込。税を取り出す）</option>
      </select></label>
    <label class="check"><input type="checkbox" name="withholding" value="1" id="wh"${inv.withholding ? ' checked' : ''}> 源泉徴収税を差し引く
      <small>（先方が法人で、こちらが個人として報酬を受け取る場合など）</small></label>
    <table class="totals" id="totals"></table>
  </div>

  <label>備考<textarea name="notes" rows="3" placeholder="振込手数料はご負担願います。など">${h(inv.notes)}</textarea></label>

  <div class="actions">
    <a class="btn" href="#${id ? 'invoice-' + id : 'list'}">キャンセル</a>
    <button class="btn primary">保存して確認へ</button>
  </div>
</form>
${locked ? '<p class="muted small">※入金記録がある請求書です。金額を変えると入金状態が再計算されます。</p>' : ''}`;

  return {
    title: heading, active: 'list', html,
    mount(root) {
      const isNew = !id;
      const byName = new Map(products.map((p) => [p.name, p]));
      const form = root.querySelector('#invForm');
      const clientSel = form.client_id;
      const tbody = root.querySelector('#items tbody');
      const recBtn = root.querySelector('#addRec');
      const recurringOf = (cid) => store.db.recurring.filter((r) => r.client_id === Number(cid)).sort((a, b) => (a.sort - b.sort) || (a.id - b.id));

      // 取引先の単価 → 取引先のルール → 標準単価
      const lookup = (pid) => { const r = priceInfo(clientSel.value, pid); return r.price == null ? null : r; };
      const hint = (tr, text, cls) => { const el = tr.querySelector('.hint'); el.textContent = text || ''; el.className = 'hint' + (cls ? ' ' + cls : ''); };
      function applyProduct(tr, force) {
        const nameEl = tr.querySelector('.iname'), pidEl = tr.querySelector('.pid'), priceEl = tr.querySelector('.price');
        const p = byName.get(nameEl.value.trim());
        if (!p) { pidEl.value = ''; hint(tr, ''); return; }
        const changed = String(pidEl.value) !== String(p.id);
        pidEl.value = p.id;
        if (changed || force) {
          if (p.unit) tr.querySelector('.unit').value = p.unit;
          tr.querySelector('.rate').value = String(p.tax_rate);
          const lp = lookup(p.id);
          if (lp) { priceEl.value = lp.price; priceEl.dataset.auto = lp.price; hint(tr, lp.from, lp.from === '標準単価' ? '' : 'mine'); }
          else { priceEl.value = ''; delete priceEl.dataset.auto; hint(tr, '単価が未設定です', 'warn'); priceEl.focus(); }
        }
      }
      function checkManual(tr) {
        const priceEl = tr.querySelector('.price'), pid = tr.querySelector('.pid').value;
        if (!pid) return;
        const lp = lookup(Number(pid));
        if (lp && num(priceEl.value) !== lp.price) hint(tr, '手入力（' + lp.from + ' ' + lp.price.toLocaleString() + '）', 'manual');
        else if (lp) hint(tr, lp.from, lp.from === '標準単価' ? '' : 'mine');
      }
      function newRow() {
        tbody.insertAdjacentHTML('beforeend', rowHtml(BLANK));
        const tr = tbody.lastElementChild;
        if ([...tbody.querySelectorAll('.sub-fields')].some((d) => !d.hidden)) tr.querySelector('.sub-fields').hidden = false;
        return tr;
      }
      const isBlank = (tr) => !tr.querySelector('.iname').value && !tr.querySelector('.price').value;
      function insertRecurring() {
        for (const r of recurringOf(clientSel.value)) {
          const tr = [...tbody.rows].find(isBlank) || newRow();
          tr.querySelector('.iname').value = r.name; tr.querySelector('.qty').value = r.qty; tr.querySelector('.unit').value = r.unit;
          tr.querySelector('.price').value = r.price; tr.querySelector('.rate').value = String(r.tax_rate);
          tr.querySelector('.pid').value = '';
          hint(tr, '月額固定', 'mine');
        }
        recalc();
      }
      function onClient() {
        const list = recurringOf(clientSel.value);
        recBtn.hidden = !list.length;
        // 取引先を変えたら、商品から入れた単価をその取引先の単価に入れ直す
        [...tbody.rows].forEach((tr) => {
          const pe = tr.querySelector('.price'), pid = tr.querySelector('.pid').value;
          if (pid && (pe.dataset.auto === undefined || String(num(pe.value)) === pe.dataset.auto)) applyProduct(tr, true);
        });
        if (isNew && list.length && [...tbody.rows].every(isBlank)) insertRecurring();
        recalc();
      }
      function readItems() {
        const out = [];
        for (const tr of tbody.rows) {
          const name = tr.querySelector('.iname').value.trim();
          if (name === '') continue;
          const rate = Number(tr.querySelector('.rate').value);
          const qtyRaw = tr.querySelector('.qty').value.replace(/,/g, '').trim();
          out.push({ name, qty: qtyRaw === '' ? 1 : (parseFloat(qtyRaw) || 0), unit: tr.querySelector('.unit').value.trim(), price: Math.trunc(num(tr.querySelector('.price').value)),
            tax_rate: [10, 8, 0].includes(rate) ? rate : 10, product_id: Number(tr.querySelector('.pid').value) || null,
            item_date: tr.querySelector('.idate').value.trim(), ship_to: tr.querySelector('.ship').value.trim() });
        }
        return out;
      }
      function recalc() {
        const incl = form.tax_mode.value === 'include';
        const all = [];
        for (const tr of tbody.rows) {
          const it = { qty: num(tr.querySelector('.qty').value), price: Math.trunc(num(tr.querySelector('.price').value)), tax_rate: Number(tr.querySelector('.rate').value) };
          const a = Math.round(it.qty * it.price);
          tr.querySelector('.amt').textContent = tr.querySelector('.iname').value || a ? yen(a) : '';
          all.push(it);
        }
        const c = calcInvoice(all, form.withholding.checked, form.tax_mode.value);
        let rows = `<tr><th>小計（税抜）</th><td>${yen(c.subtotal)}</td></tr>`;
        for (const r of c.rates) {
          const b = c.breakdown[r];
          rows += r > 0 ? `<tr class="sub"><th>${r}%対象 ${yen(b.base)}${incl ? '（税抜）' : ''}</th><td>消費税 ${yen(b.tax)}</td></tr>` : `<tr class="sub"><th>対象外 ${yen(b.base)}</th><td></td></tr>`;
        }
        if (form.withholding.checked) rows += `<tr class="sub"><th>源泉徴収税</th><td>−${yen(c.withholding_amount)}</td></tr>`;
        rows += `<tr class="grand"><th>ご請求金額</th><td>${yen(c.total)}</td></tr>`;
        root.querySelector('#totals').innerHTML = rows;
      }

      root.querySelector('#addRow').onclick = () => { newRow().querySelector('.iname').focus(); recalc(); };
      recBtn.onclick = insertRecurring;
      root.querySelector('#showSub').onclick = () => tbody.querySelectorAll('.sub-fields').forEach((d) => { d.hidden = false; });
      tbody.addEventListener('click', (e) => {
        if (!e.target.classList.contains('del')) return;
        const tr = e.target.closest('tr');
        if (tbody.rows.length > 1) tr.remove(); else { tr.outerHTML = rowHtml(BLANK); }
        recalc();
      });
      tbody.addEventListener('change', (e) => { if (e.target.classList.contains('iname')) applyProduct(e.target.closest('tr')); });
      tbody.addEventListener('input', (e) => {
        const tr = e.target.closest('tr');
        if (e.target.classList.contains('iname') && byName.has(e.target.value.trim())) applyProduct(tr);
        if (e.target.classList.contains('price')) checkManual(tr);
      });
      clientSel.addEventListener('change', onClient);
      form.addEventListener('input', recalc);
      form.addEventListener('change', recalc);

      root.querySelector('#newClientLink').addEventListener('click', () => { if (isNew) once.backToNew = true; });
      // 開いたときの表示
      if (isNew && clientSel.value && recurringOf(clientSel.value).length && [...tbody.rows].every(isBlank)) insertRecurring();
      recBtn.hidden = !recurringOf(clientSel.value).length;
      [...tbody.rows].forEach((tr) => { const pe = tr.querySelector('.price'); if (tr.querySelector('.pid').value) { pe.dataset.auto = pe.value; checkManual(tr); } });
      recalc();

      // 保存
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const clientId = Number(clientSel.value), number = form.number.value.trim();
        const issue = form.issue_date.value, due = form.due_date.value;
        const taxMode = form.tax_mode.value === 'include' ? 'include' : 'exclude';
        const wh = form.withholding.checked ? 1 : 0;
        const list = readItems();
        const errors = [];
        if (!clientId) errors.push('取引先を選んでください。');
        if (number === '') errors.push('請求書番号を入力してください。');
        if (!isYmd(issue) || !isYmd(due)) errors.push('日付を正しく入力してください。');
        if (!list.length) errors.push('明細を1行以上入力してください。');
        if (store.db.invoices.some((v) => v.number === number && v.id !== id)) errors.push('この請求書番号はすでに使われています。');
        if (errors.length) { showFlash(errors.join(' '), 'err'); return; }

        const calc = calcInvoice(list, !!wh, taxMode);
        // 価格が0円の数量のある行が残っていれば未完成のまま。全部決まったら未完成を外す
        const incomplete = list.some((it) => it.qty > 0 && it.price <= 0) ? 1 : 0;
        const withAmount = list.map((it, i) => ({ id: store.newId() + i, ...it, amount: Math.round(it.qty * it.price) }));
        const common = { number, client_id: clientId, title: form.title.value.trim(), issue_date: issue, due_date: due, notes: form.notes.value.trim(), withholding: wh,
          subtotal: calc.subtotal, tax: calc.tax, withholding_amount: calc.withholding_amount, total: calc.total, tax_mode: taxMode, incomplete, items: withAmount };
        let target;
        const oldItems = id ? (store.invoice(id).items || []).map((x) => ({ ...x })) : null; // 直す前の明細（管理表への反映に使う）
        if (id) {
          target = Object.assign(store.invoice(id), common);
          store.logEvent(target, 'edit', '内容を変更');
        } else {
          // 事業は今見ている事業（全体を見ているときは取引先の事業）
          const c = store.client(clientId);
          const newBiz = state.biz ? EB.id : ((c && c.business_id) || EB.id);
          const rec = isReconcile(store.bizOf(newBiz));
          target = { id: store.newId(), ...common, token: randomToken(), business_id: newBiz, status: rec ? 'sent' : 'draft', sent_at: rec ? nowUtc() : null,
            opened_at: null, open_count: 0, paid_at: null, paid_amount: 0, created_at: nowUtc(), source_ref: '', payments: [], events: [] };
          store.logEvent(target, 'create', '作成');
        }
        // 手で変えた単価を、この取引先の単価として覚える
        let learned = 0;
        if (form.remember.checked) {
          for (const it of list) {
            if (it.product_id && priceInfo(clientId, it.product_id).price !== it.price) { await store.setClientPrice(clientId, it.product_id, it.price); learned++; }
          }
        }
        // 新しい品名を商品として登録する
        let added = 0;
        if (form.add_products.checked) {
          for (const it of list) {
            if (it.product_id || store.db.products.some((p) => p.name === it.name)) continue;
            await store.saveProduct({ id: store.newId(), name: it.name, unit: it.unit, price: it.price, cost: null, tax_rate: it.tax_rate, active: 1, created_at: nowUtc(), maker: '', pack_size: null, source: 'app' });
            added++;
          }
        }
        refreshPaymentStatus(target);
        await store.saveInvoice(target);
        // シービーエムの明細から作った請求書を直したら、控えの明細（年間管理表）にも反映する
        const sy = id ? await syncLinesFromInvoice(oldItems, target) : null;
        const syMsg = sy && (sy.changed || sy.removed || sy.added || sy.missed)
          ? '（年間管理表にも反映：' + [sy.changed ? '変更' + sy.changed + '行' : '', sy.removed ? '削除' + sy.removed + '行' : '', sy.added ? '追加' + sy.added + '行' : '', sy.missed ? '明細に見つからず反映できなかった行' + sy.missed + '行' : ''].filter(Boolean).join('・') + '）' : '';
        flash('請求書を保存しました。' + syMsg + (learned ? `（${learned}件の単価をこの取引先の単価として保存）` : '') + (added ? `（新しい商品を${added}件登録）` : ''));
        go('invoice-' + target.id);
      });
    },
  };
}
