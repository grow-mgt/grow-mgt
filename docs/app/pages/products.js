// 商品・単価（今までの products.php と同じ画面）
import { store } from '../store.js';
import { go, state } from '../nav.js';
import { h, nf, toIntOrNull, nowUtc } from '../util.js';
import { priceInfo } from '../logic.js';
import { flash, confirmBox } from '../ui.js';

const RATES = [[10, '10%'], [8, '8%'], [0, '対象外']];
const head = (view) => `
<div class="head-row">
  <h1>商品・単価</h1>
  <div class="btns">
    <a class="chip${view === 'matrix' ? ' on' : ''}" href="#matrix">販売単価</a>
    <a class="chip${view === 'list' ? ' on' : ''}" href="#products">仕入単価</a>
  </div>
</div>`;

/* ---------- 商品の一覧（まとめて編集） ---------- */
export function productsPage() {
  const products = [...store.db.products].sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name, 'ja'));
  const special = (p) => store.db.clientPrices.filter((x) => x.product_id === p.id).length;
  const html = head('list') + `
<p class="muted">商品と、シービーエムからの仕入単価の一覧です。取引先に請求する単価は「販売単価」で、取引先ごとに入れます（グループの親会社だけ、仕入単価のまま請求します）。</p>
<form id="prodForm">
  <div class="table-wrap">
  <table class="list edit">
    <thead><tr><th>商品名</th><th class="small">メーカー・包装</th><th class="w-unit">単位</th><th class="w-price r">標準単価(税抜)</th><th class="w-price r">仕入単価</th><th class="r">粗利率</th><th class="w-rate">税率</th><th class="r">個別単価</th><th>使う</th><th></th></tr></thead>
    <tbody>
    ${products.map((p) => {
      const margin = (p.price && p.cost != null) ? (Math.round((p.price - p.cost) / p.price * 1000) / 10) + '%' : '';
      const sp = special(p);
      return `<tr class="${p.active ? '' : 'off'}" data-id="${p.id}">
        <td><input class="pname" value="${h(p.name)}"></td>
        <td class="small muted">${h(p.maker || '')}${p.pack_size > 1 ? ' ／ ' + p.pack_size + '入' : ''}</td>
        <td><input class="punit" value="${h(p.unit || '')}"></td>
        <td><input class="r pprice" value="${h(p.price ?? '')}" inputmode="numeric" placeholder="未設定"></td>
        <td><input class="r pcost" value="${h(p.cost ?? '')}" inputmode="numeric"></td>
        <td class="r small">${margin}</td>
        <td><select class="prate">${RATES.map(([v, l]) => `<option value="${v}"${Number(p.tax_rate) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
        <td class="r small">${sp ? sp + '社' : ''}</td>
        <td><input type="checkbox" class="pactive"${p.active ? ' checked' : ''}></td>
        <td><button type="button" class="icon pdel" title="削除">×</button></td>
      </tr>`;
    }).join('')}
    ${[0, 1, 2].map(() => `<tr class="new">
        <td><input class="pname" placeholder="新しい商品名"></td><td></td>
        <td><input class="punit" placeholder="個"></td>
        <td><input class="r pprice" inputmode="numeric"></td>
        <td><input class="r pcost" inputmode="numeric"></td><td></td>
        <td><select class="prate"><option value="10">10%</option><option value="8">8%</option><option value="0">対象外</option></select></td>
        <td colspan="3"></td>
      </tr>`).join('')}
    </tbody>
  </table>
  </div>
  <div class="actions"><button class="btn primary">保存</button></div>
</form>`;

  return {
    title: '仕入単価 | 商品・単価', active: 'products', html,
    mount(root) {
      const form = root.querySelector('#prodForm');
      const read = (tr) => ({ name: tr.querySelector('.pname').value.trim(), unit: tr.querySelector('.punit').value.trim(),
        price: toIntOrNull(tr.querySelector('.pprice').value), cost: toIntOrNull(tr.querySelector('.pcost').value), tax_rate: Number(tr.querySelector('.prate').value) });

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        // 先に、同じ名前がないか全部確かめる（途中まで保存して止まらないように）
        const names = new Map();
        const edits = [], adds = [];
        for (const tr of form.querySelectorAll('tbody tr')) {
          const v = read(tr);
          if (v.name === '') continue;
          if (tr.classList.contains('new')) adds.push(v);
          else { const p = store.product(Number(tr.dataset.id)); edits.push([p, { ...v, active: tr.querySelector('.pactive').checked ? 1 : 0 }]); names.set(v.name, p.id); }
        }
        const editedIds = new Set(edits.map(([p]) => p.id));
        for (const p of store.db.products) if (!editedIds.has(p.id)) names.set(p.name, p.id);
        const seen = new Set();
        for (const [, v] of edits) { if (seen.has(v.name)) { flash('同じ名前の商品があります：' + v.name, 'err'); go('products'); return; } seen.add(v.name); }
        for (const [p, v] of edits) {
          const same = p.name === v.name && (p.unit || '') === v.unit && (p.price ?? null) === v.price && (p.cost ?? null) === v.cost && Number(p.tax_rate) === v.tax_rate && Number(p.active) === v.active;
          if (same) continue; // 変わっていない行は書かない
          await store.saveProduct(Object.assign(p, v));
        }
        for (const v of adds) {
          if (names.has(v.name)) continue; // 同じ名前がすでにあれば足さない（今までと同じ）
          const p = { id: store.newId(), ...v, active: 1, created_at: nowUtc(), maker: '', pack_size: null, source: 'app' };
          names.set(v.name, p.id);
          await store.saveProduct(p);
        }
        flash('商品を保存しました。'); go('products');
      });

      form.querySelectorAll('.pdel').forEach((b) => b.addEventListener('click', async () => {
        const p = store.product(Number(b.closest('tr').dataset.id));
        if (!(await confirmBox('「' + p.name + '」を削除しますか？', '削除する'))) return;
        const used = store.db.invoices.some((v) => (v.items || []).some((it) => it.product_id === p.id));
        if (used) { p.active = 0; await store.saveProduct(p); flash('請求書で使われている商品なので、削除せず「使わない」にしました。'); }
        else { await store.deleteProduct(p.id); flash('商品を削除しました。'); }
        go('products');
      }));
    },
  };
}

/* ---------- 販売単価（取引先を選ぶと、商品と単価が縦に並ぶ） ---------- */
const pick = { client: 0, onlySet: false };
export function matrixPage() {
  // いま開いている事業（CBMなど）の取引先だけを出す
  const bid = state.biz;
  const clients = store.db.clients.filter((x) => !bid || Number(x.business_id || 1) === bid).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  if (!clients.some((c) => c.id === pick.client)) pick.client = 0;
  const c = pick.client ? store.client(pick.client) : null;
  const mine = new Map(store.db.clientPrices.filter((x) => c && x.client_id === c.id).map((x) => [x.product_id, x]));
  let products = store.db.products.filter((p) => p.active === 1 || mine.has(p.id))
    .sort((a, b) => (mine.has(b.id) - mine.has(a.id)) || a.name.localeCompare(b.name, 'ja'));
  if (pick.onlySet) products = products.filter((p) => mine.has(p.id));
  const costAll = !!c && c.price_rule === 'cost_all';

  const html = head('matrix') + `
<p class="muted">取引先を選ぶと、その取引先に請求する単価（販売単価）が、商品ごとに縦に並びます。金額はすべて税抜です。${bid ? `選べるのは「${h(store.bizOf(bid).name)}」の取引先だけです。` : ''}</p>
<div class="card form">
  <div class="pick" id="pickBox">
    <span class="small muted">取引先</span>
    <button type="button" class="pick-btn" id="pickBtn" aria-haspopup="listbox" aria-expanded="false"><span>${c ? h(c.name) + (c.corp_name ? `<small>（${h(c.corp_name)}）</small>` : '') : '取引先を選んでください…'}</span><i>▾</i></button>
    <div class="pick-list" id="pickList" role="listbox" hidden>
      ${clients.length > 8 ? '<input type="search" id="pickSearch" placeholder="名前でさがす" autocomplete="off">' : ''}
      <div class="pick-items">${clients.map((x) => `<button type="button" role="option" class="pick-item${c && x.id === c.id ? ' on' : ''}" data-pick="${x.id}" data-key="${h((x.name + ' ' + (x.corp_name || '')).toLowerCase())}">${h(x.name)}${x.corp_name ? `<small>${h(x.corp_name)}</small>` : ''}</button>`).join('') || '<div class="muted small" style="padding:10px">この事業の取引先がありません。</div>'}</div>
    </div>
  </div>
  ${c ? `<p class="small muted" style="margin:12px 0 0">${costAll ? '<b>グループの親会社なので、仕入単価で請求します。</b>販売単価を入れた商品だけ、その金額で請求します（入れた商品：' + mine.size + '件）。' : '販売単価を入れた商品：' + mine.size + '件'}　<a href="#client-${c.id}">この取引先の画面を開く</a></p>` : ''}
</div>
${!c ? '<div class="empty">上のリストから取引先を選んでください。</div>' : `
<form id="matrixForm">
  <p class="small" style="margin:14px 0 8px"><label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" id="onlySet" style="width:auto;margin:0"${pick.onlySet ? ' checked' : ''}> 単価を入れた商品だけ表示</label></p>
  <div class="table-wrap">
  <table class="list edit">
    <thead><tr><th>商品名</th><th class="r">仕入単価</th><th class="w-price r">販売単価</th><th class="r">粗利</th><th class="r">粗利率</th></tr></thead>
    <tbody>
    ${products.map((p) => {
      const m = mine.get(p.id), info = priceInfo(c.id, p.id);
      const gp = info.price != null && p.cost != null ? info.price - Number(p.cost) : null;
      const rate = gp != null && info.price ? (Math.round(gp / info.price * 1000) / 10).toFixed(1) + '%' : '';
      return `<tr class="${p.active ? '' : 'off'}">
        <td>${h(p.name)}</td>
        <td class="r">${p.cost != null ? nf(p.cost) : '<span class="muted">-</span>'}</td>
        <td><input data-p="${p.id}" value="${m ? h(m.price) : ''}" class="r${m ? ' set' : ''}" inputmode="numeric" placeholder="${costAll ? (p.cost != null ? nf(p.cost) : '未設定') : '未設定'}"></td>
        <td class="r">${gp != null ? nf(gp) : ''}</td>
        <td class="r small">${rate}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" class="muted">表示する商品がありません。</td></tr>'}
    </tbody>
  </table>
  </div>
  <p class="small muted">「販売単価」に入れた金額が、そのまま請求する単価になります。空欄（未設定）の商品は、請求書を作るときに単価を入れる必要があります。</p>
  <div class="actions"><button class="btn primary">保存</button></div>
</form>`}`;

  return {
    title: '販売単価 | 商品・単価', active: 'products', html,
    mount(root) {
      // 取引先のリスト（押すとすぐ開く、アプリの中のリスト）
      const pb = root.querySelector('#pickBtn'), pl = root.querySelector('#pickList'), ps = root.querySelector('#pickSearch');
      const openList = (on) => { pl.hidden = !on; pb.setAttribute('aria-expanded', on ? 'true' : 'false'); if (on) { const cur = pl.querySelector('.pick-item.on'); if (cur) cur.scrollIntoView({ block: 'nearest' }); } };
      pb.addEventListener('click', (e) => { e.stopPropagation(); openList(pl.hidden); });
      pl.addEventListener('click', (e) => e.stopPropagation());
      document.addEventListener('click', function shut() { if (!document.body.contains(pl)) { document.removeEventListener('click', shut); return; } openList(false); });
      if (ps) ps.addEventListener('input', () => { const q = ps.value.trim().toLowerCase(); pl.querySelectorAll('.pick-item').forEach((b) => { b.hidden = q !== '' && !b.dataset.key.includes(q); }); });
      root.querySelectorAll('[data-pick]').forEach((a) => a.addEventListener('click', () => { pick.client = Number(a.dataset.pick); go('matrix'); }));
      const os = root.querySelector('#onlySet'); if (os) os.addEventListener('change', () => { pick.onlySet = os.checked; go('matrix'); });
      const form = root.querySelector('#matrixForm'); if (!form) return;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        let n = 0;
        for (const inp of form.querySelectorAll('input[data-p]')) {
          const pid = Number(inp.dataset.p), m = mine.get(pid), val = toIntOrNull(inp.value);
          if ((m ? Number(m.price) : null) !== val) { await store.setClientPrice(c.id, pid, val); n++; }
        }
        flash(n ? `「${c.name}」の販売単価を保存しました（${n}件）。` : '変更はありません。'); go('matrix');
      });
    },
  };
}
