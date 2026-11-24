// 商品・単価（今までの products.php と同じ画面）
import { store } from '../store.js';
import { once, go } from '../nav.js';
import { h, nf, toIntOrNull, nowUtc } from '../util.js';
import { flash, confirmBox } from '../ui.js';

const RATES = [[10, '10%'], [8, '8%'], [0, '対象外']];
const head = (view) => `
<div class="head-row">
  <h1>商品・単価</h1>
  <div class="btns">
    <a class="chip${view === 'list' ? ' on' : ''}" href="#products">商品の一覧</a>
    <a class="chip${view === 'matrix' ? ' on' : ''}" href="#matrix">取引先ごとの単価表</a>
  </div>
</div>`;

/* ---------- 商品の一覧（まとめて編集） ---------- */
export function productsPage() {
  const products = [...store.db.products].sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name, 'ja'));
  const special = (p) => store.db.clientPrices.filter((x) => x.product_id === p.id).length;
  const html = head('list') + `
<p class="muted">請求書の明細で商品名を選ぶと、<b>その取引先の単価 → その取引先のルール（原価／原価＋◯円）→ 標準単価</b>の順で自動で入ります。取引先ごとの単価は「取引先ごとの単価表」か、各取引先の画面で入れます。</p>
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
    title: '商品・単価', active: 'products', html,
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

/* ---------- 取引先ごとの単価表 ---------- */
export function matrixPage() {
  const g = once.matrixGroup, all = once.matrixAll;
  const groups = [...new Set(store.db.clients.map((c) => c.group_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ja'));
  const clients = store.db.clients.filter((c) => g === '' || c.group_name === g)
    .sort((a, b) => String(a.group_name || '').localeCompare(String(b.group_name || ''), 'ja') || a.name.localeCompare(b.name, 'ja'));
  const cp = new Map(store.db.clientPrices.map((x) => [x.client_id + '_' + x.product_id, x]));
  const used = new Set(store.db.clientPrices.map((x) => x.product_id));
  let active = store.db.products.filter((p) => p.active === 1).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  // 単価が入っている商品だけ列に出す（多すぎると見づらいため）
  if (!all) active = active.filter((p) => used.has(p.id) || p.price != null);

  const html = head('matrix') + `
<p class="muted">青い欄は「価格表」スプレッドシートから読み込んだ単価です（変えるときはスプレッドシートで）。緑の欄はアプリで入れた単価、空欄は「価格表にない商品」のルールか標準単価を使います。${!all ? '<a href="#matrix" id="showAll">すべての商品を表示</a>' : ''}</p>
${groups.length ? `<div class="filters"><a class="chip${g === '' ? ' on' : ''}" href="#matrix" data-g="">すべて</a>${groups.map((gr) => `<a class="chip${g === gr ? ' on' : ''}" href="#matrix" data-g="${h(gr)}">${h(gr)}</a>`).join('')}</div>` : ''}
${!clients.length || !active.length ? '<div class="empty">取引先と商品を登録すると、ここで取引先ごとの単価を一覧で入れられます。</div>' : `
<form id="matrixForm">
  <div class="table-wrap matrix-wrap">
  <table class="list matrix">
    <thead><tr><th class="sticky">取引先</th>${active.map((p) => `<th class="r">${h(p.name)}<br><span class="muted small">標準 ${p.price != null ? nf(p.price) : '未設定'}</span></th>`).join('')}</tr></thead>
    <tbody>
    ${clients.map((c) => `<tr><th class="sticky">${h(c.name)}</th>${active.map((p) => {
      const m = cp.get(c.id + '_' + p.id); const isS = m && m.source === 'sheet';
      return `<td><input data-c="${c.id}" data-p="${p.id}" value="${m ? h(m.price) : ''}" class="r${isS ? ' sheet' : (m ? ' set' : '')}"${isS ? ' readonly title="価格表スプレッドシートの単価"' : ''} inputmode="numeric" placeholder="${p.price != null ? nf(p.price) : ''}"></td>`;
    }).join('')}</tr>`).join('')}
    </tbody>
  </table>
  </div>
  <div class="actions"><button class="btn primary">保存</button></div>
</form>`}`;

  return {
    title: '商品・単価', active: 'products', html,
    mount(root) {
      root.querySelectorAll('[data-g]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); once.matrixGroup = a.dataset.g; go('matrix'); }));
      const sa = root.querySelector('#showAll'); if (sa) sa.addEventListener('click', (e) => { e.preventDefault(); once.matrixAll = true; go('matrix'); });
      const form = root.querySelector('#matrixForm'); if (!form) return;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        for (const inp of form.querySelectorAll('input[data-c]')) {
          const cid = Number(inp.dataset.c), pid = Number(inp.dataset.p), m = cp.get(cid + '_' + pid);
          if (m && m.source === 'sheet') continue; // 価格表スプレッドシートの単価はここでは変えない
          const val = toIntOrNull(inp.value);
          if ((m ? m.price : null) !== val) await store.setClientPrice(cid, pid, val);
        }
        flash('顧客別の単価を保存しました。'); go('matrix');
      });
    },
  };
}
