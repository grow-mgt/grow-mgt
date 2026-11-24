// 取引先（今までの clients.php と同じ画面）
import { store } from '../store.js';
import { state, once, go } from '../nav.js';
import { isReconcile, priceInfo } from '../logic.js';
import { h, yen, nf, toIntOrNull, isEmail, nowUtc } from '../util.js';
import { flash, showFlash, confirmBox } from '../ui.js';
import { exportCsv, mailCsv } from '../export.js';

const FIELDS = ['name', 'corp_name', 'group_name', 'honorific', 'contact', 'representative', 'email', 'cc', 'postal', 'address', 'payer_kana', 'memo'];
// 参照元スプレッドシートで管理する項目（スプレッドシートから来た取引先では、アプリでは変えない）
const SHEET_FIELDS = ['name', 'corp_name', 'contact', 'representative', 'email', 'postal', 'address'];
const RATES = [[10, '10%'], [8, '8%'], [0, '対象外']];
const qtyStr = (q) => { const s = String(q == null || q === '' ? 1 : q); return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') || '1' : s; };

function ruleLabel(c) {
  if (c.price_rule === 'cost') return '価格表にない商品は原価';
  if (c.price_rule === 'cost_plus') return '価格表にない商品は原価＋' + nf(c.price_rule_amount) + '円';
  if (c.price_rule === 'cost_all') return 'すべての商品を原価（仕入値そのまま）';
  return '';
}

/* ---------- 一覧 ---------- */
export function clientsPage() {
  const bid = state.biz;
  const rows = store.db.clients.filter((c) => !bid || c.business_id === bid)
    .sort((a, b) => (a.business_id - b.business_id) || String(a.group_name || '').localeCompare(String(b.group_name || ''), 'ja') || a.name.localeCompare(b.name, 'ja'));
  const stat = (c) => {
    const invs = store.db.invoices.filter((v) => v.client_id === c.id);
    return { cnt: invs.length, unpaid: invs.filter((v) => v.status !== 'paid' && v.status !== 'draft').reduce((a, v) => a + v.total - v.paid_amount, 0) };
  };
  const html = `
<div class="head-row">
  <h1>取引先 <span class="muted small">${bid ? h(store.bizOf(bid).name) : 'GROW全体'}</span></h1>
  <div class="btns">
    <button class="btn small" id="cCsv"${rows.length ? '' : ' disabled'}>${store.isPreview ? '顧客情報をコピーする' : '顧客情報をCSVで書き出す'}</button>
    <button class="btn small" id="cPriceCsv"${rows.length ? '' : ' disabled'}>${store.isPreview ? '単価表をコピーする' : '単価表をCSVで書き出す'}</button>
    <button class="btn small" id="cMail"${rows.length ? '' : ' disabled'}>CSVをメールで送る</button>
    <a class="btn primary" href="#client-new">＋ 取引先を登録</a>
  </div>
</div>
${!rows.length ? '<div class="empty">取引先はまだありません。</div>' : `
<div class="table-wrap">
<table class="list">
  <thead><tr><th>取引先名</th>${!bid ? '<th>事業</th>' : ''}<th>グループ</th><th>ご担当者</th><th>メール</th><th>振込名義</th><th class="r">請求書</th><th class="r">未入金</th></tr></thead>
  <tbody id="clientRows">
  ${rows.map((r) => { const s = stat(r); return `
    <tr data-id="${r.id}">
      <td><a href="#client-${r.id}">${h(r.name)}</a> <span class="muted small">${h(r.honorific)}</span>${r.corp_name ? `<br><span class="muted small">${h(r.corp_name)}</span>` : ''}</td>
      ${!bid ? `<td class="small muted">${h(store.bizOf(r.business_id).name)}</td>` : ''}
      <td class="small muted">${h(r.group_name)}</td>
      <td>${h(r.contact)}</td>
      <td class="small">${h(r.email)}</td>
      <td class="small mono">${h(r.payer_kana)}</td>
      <td class="r">${s.cnt}</td>
      <td class="r">${s.unpaid ? yen(s.unpaid) : ''}</td>
    </tr>`; }).join('')}
  </tbody>
</table>
</div>`}`;
  return {
    title: '取引先', active: 'clients', html,
    mount(root) {
      const tb = root.querySelector('#clientRows');
      if (tb) tb.addEventListener('click', (e) => { if (e.target.closest('a')) return; const tr = e.target.closest('tr'); if (tr) go('client-' + tr.dataset.id); });
      // 顧客情報・単価表をCSVにする
      const bizName = (id) => (store.bizOf(id) || {}).name || '';
      const infoTable = () => [['事業', '取引先名', '敬称', '法人名', 'グループ', 'ご担当者', '代表者', 'メール', 'CC', '郵便番号', '住所', '振込名義（カナ）', '請求方法', '単価の決め方', '月額固定', 'メモ']].concat(rows.map((c) => [
        bizName(c.business_id), c.name, c.honorific || '', c.corp_name || '', c.group_name || '', c.contact || '', c.representative || '', c.email || '', c.cc || '', c.postal || '', c.address || '', c.payer_kana || '',
        c.billing_method || '', ruleLabel(c) || '標準単価', store.db.recurring.filter((x) => x.client_id === c.id).map((x) => x.name + ' ' + nf(x.price) + '円').join('／'), c.memo || '']));
      const priceTable = () => {
        const out = [['取引先名', '商品', '単位', 'この取引先の単価（税抜）', '標準単価', '仕入単価']];
        for (const c of rows) for (const x of store.db.clientPrices.filter((v) => v.client_id === c.id)) {
          const p = store.product(x.product_id); if (!p) continue;
          out.push([c.name, p.name, p.unit || '', x.price, p.price == null ? '' : p.price, p.cost == null ? '' : p.cost]);
        }
        return out;
      };
      const scope = bid ? store.bizOf(bid).name : 'GROW全体';
      const on = (id, fn) => { const el = root.querySelector(id); if (el) el.addEventListener('click', fn); };
      on('#cCsv', () => exportCsv(infoTable(), `顧客情報_${scope}.csv`));
      on('#cPriceCsv', () => exportCsv(priceTable(), `顧客別単価表_${scope}.csv`));
      on('#cMail', () => mailCsv({ title: '顧客情報をメールで送る', files: [{ name: `顧客情報_${scope}.csv`, table: infoTable() }, { name: `顧客別単価表_${scope}.csv`, table: priceTable() }],
        subject: `【${store.setting('company') || 'GROW'}】顧客情報（${scope}）`, body: `お疲れさまです。\n\n顧客情報と顧客別の単価表（${scope}）をCSVでお送りします。\nご確認をお願いいたします。` }));
    },
  };
}

/* ---------- 登録・編集 ---------- */
function recRow(r) {
  return `<tr>
    <td><input class="rname" value="${h(r.name)}" placeholder="例：経営コンサルティングフィー"></td>
    <td><input class="r rqty" value="${h(qtyStr(r.qty))}"></td>
    <td><input class="runit" value="${h(r.unit)}" placeholder="式"></td>
    <td><input class="r rprice" value="${h(r.price)}" inputmode="numeric"></td>
    <td><select class="rrate">${RATES.map(([v, l]) => `<option value="${v}"${Number(r.tax_rate) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
  </tr>`;
}
const BLANK_REC = { name: '', qty: 1, unit: '', price: '', tax_rate: 10 };

export function clientEditPage(arg) {
  const isNew = arg === 'new';
  const back = once.backToNew; once.backToNew = false; // 請求書の作成画面から来たときは、保存後にそこへ戻る
  let c = { id: 0, honorific: '御中', business_id: state.biz || store.businesses()[0].id, source: 'app', sheet_note: '', price_rule: '', price_rule_amount: 0 };
  for (const f of FIELDS) if (!(f in c)) c[f] = '';
  if (!isNew) { const found = store.client(Number(arg)); if (!found) return null; c = found; }
  const lk = false; // 顧客情報はアプリで管理する（スプレッドシートから読み込んだ取引先も、アプリで直せる）
  const ro = lk ? ' readonly class="locked"' : '';
  const crec = isReconcile(store.bizOf(c.business_id));
  const groups = [...new Set(store.db.clients.map((x) => x.group_name).filter(Boolean))];
  const rec = c.id ? store.db.recurring.filter((r) => r.client_id === c.id).sort((a, b) => (a.sort - b.sort) || (a.id - b.id)) : [];
  const mine = new Map(store.db.clientPrices.filter((x) => x.client_id === c.id).map((x) => [x.product_id, x]));
  // 価格表に載っている商品を上に
  const prods = store.db.products.filter((p) => p.active === 1).sort((a, b) => (mine.has(b.id) - mine.has(a.id)) || a.name.localeCompare(b.name, 'ja'));

  const html = `
<h1>${c.id ? '取引先を編集' : '取引先を登録'}</h1>
<form class="card form" id="clientForm">
  <div class="grid2">
    ${lk ? `<div class="span2 src-note">この取引先は「顧客情報」スプレッドシートの契約先から読み込んでいます。薬局名・法人・担当・代表・メール・住所は、スプレッドシートで直してください（アプリでは変えられません）。${c.sheet_note ? '<br>スプレッドシートのメモ：' + h(c.sheet_note) : ''}</div>` : ''}
    <label class="span2">取引先名（薬局名） <em>必須</em><input name="name" value="${h(c.name)}" required placeholder="〇〇薬局"${ro}></label>
    <label>法人名<input name="corp_name" value="${h(c.corp_name || '')}" placeholder="株式会社〇〇"${ro}><small>請求書の宛名で薬局名の上に入ります</small></label>
    <label>グループ<input name="group_name" value="${h(c.group_name || '')}" list="groups" placeholder="例：〇〇薬局グループ">
      <datalist id="groups">${groups.map((g) => `<option value="${h(g)}">`).join('')}</datalist></label>
    <label>事業<select name="business_id">${store.businesses().map((b) => `<option value="${b.id}"${c.business_id === b.id ? ' selected' : ''}>${h(b.name)}</option>`).join('')}</select></label>
    <label>敬称<select name="honorific">${['御中', '様', '殿'].map((o) => `<option${c.honorific === o ? ' selected' : ''}>${o}</option>`).join('')}</select></label>
    <label>ご担当者名<input name="contact" value="${h(c.contact)}" placeholder="山田 太郎"${ro}></label>
    <label>代表者<input name="representative" value="${h(c.representative || '')}"${ro}></label>
    <label>送付先メール<input type="email" name="email" value="${h(c.email)}"${ro}></label>
    <label>CC（カンマ区切り）<input name="cc" value="${h(c.cc)}"></label>
    <label>郵便番号<input name="postal" value="${h(c.postal)}" placeholder="123-4567"${ro}></label>
    <label>住所<input name="address" value="${h(c.address)}"${ro}></label>
    <label class="span2">振込名義（カナ）
      <input name="payer_kana" value="${h(c.payer_kana)}" placeholder="カ）マルマルヤツキヨク">
      <small>通帳に表示される名義です。入金照合で使います。複数ある場合はカンマ区切り。</small>
    </label>
    <label class="span2">メモ<textarea name="memo" rows="2">${h(c.memo)}</textarea></label>
  </div>

  <h2>${crec ? '毎月の入金（家賃など）' : '月額固定の請求'}</h2>
  <p class="small muted">${crec ? '毎月決まって入金されるもの。「毎月の入金予定をまとめて作る」で、この金額の入金予定が毎月作られます。' : 'コンサルティングフィーなど毎月同じ金額のもの。この取引先の請求書を作るとき、ボタン1つで明細に入ります。'}</p>
  <div class="table-wrap">
  <table class="items" id="rec">
    <thead><tr><th>品名・内容</th><th class="w-qty">数量</th><th class="w-unit">単位</th><th class="w-price">単価（税抜）</th><th class="w-rate">税率</th></tr></thead>
    <tbody>${[...rec, BLANK_REC].map(recRow).join('')}</tbody>
  </table>
  </div>
  <button type="button" class="btn small" id="addRec">＋ 行を追加</button>

  ${prods.length && !crec ? `
  <h2>この取引先の単価</h2>
  <p class="small muted">空欄の商品は、下の「価格表にない商品」のルールか標準単価になります。</p>
  <label>価格表にない商品の単価
    ${lk ? `<input value="${h(ruleLabel(c) || '標準単価')}（価格表で設定）" readonly class="locked">` : `
    <span class="rule-row">
      <select name="price_rule">
        <option value=""${!c.price_rule ? ' selected' : ''}>標準単価</option>
        <option value="cost"${c.price_rule === 'cost' ? ' selected' : ''}>原価（仕入単価）</option>
        <option value="cost_plus"${c.price_rule === 'cost_plus' ? ' selected' : ''}>原価＋金額</option>
        <option value="cost_all"${c.price_rule === 'cost_all' ? ' selected' : ''}>すべての商品を原価（仕入値そのまま）</option>
      </select>
      <input name="price_rule_amount" value="${Number(c.price_rule_amount) || ''}" class="r" placeholder="200" inputmode="numeric"> 円
    </span>`}
  </label>
  <div class="table-wrap">
  <table class="list small cp">
    <thead><tr><th>商品</th><th class="r">標準単価</th><th class="r">仕入単価</th><th class="r w-price">この取引先の単価</th></tr></thead>
    ${prods.map((p) => {
      const m = mine.get(p.id); const fromSheet = false;
      const ph = c.id ? priceInfo(c.id, p.id) : { price: p.price, from: '' };
      return `<tr><td>${h(p.name)}</td><td class="r muted">${p.price != null ? nf(p.price) : '未設定'}</td><td class="r muted">${p.cost != null ? nf(p.cost) : ''}</td>
        <td><input data-pid="${p.id}" value="${m ? h(m.price) : ''}" class="r cpin${fromSheet ? ' sheet' : (m ? ' set' : '')}"${fromSheet ? ' readonly title="価格表から読み込んだ単価"' : ''} inputmode="numeric" placeholder="${ph.price != null ? nf(ph.price) + '（' + h(ph.from) + '）' : ''}"></td></tr>`;
    }).join('')}
  </table>
  </div>` : ''}

  <div class="actions">
    <a class="btn" href="#clients">戻る</a>
    <button class="btn primary">保存</button>
  </div>
</form>
${c.id ? '<div class="danger-zone"><button class="btn danger small" id="delClient">取引先を削除</button></div>' : ''}`;

  return {
    title: '取引先', active: 'clients', html,
    mount(root) {
      const form = root.querySelector('#clientForm');
      root.querySelector('#addRec').onclick = () => root.querySelector('#rec tbody').insertAdjacentHTML('beforeend', recRow(BLANK_REC));

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = {};
        for (const f of FIELDS) v[f] = (lk && SHEET_FIELDS.includes(f)) ? String(c[f] || '') : String(form[f].value || '').trim();
        const nb = Number(form.business_id.value);
        v.business_id = store.db.businesses.some((b) => b.id === nb) ? nb : (state.biz || store.businesses()[0].id);
        if (v.name === '') { showFlash('取引先名を入力してください。', 'err'); return; }
        if (v.email !== '' && !isEmail(v.email)) { showFlash('メールアドレスの形式が正しくありません。', 'err'); return; }
        const rule = form.price_rule ? form.price_rule.value : (c.price_rule || '');

        const target = c.id ? Object.assign(store.client(c.id), v) : { id: store.newId(), ...v, created_at: nowUtc(), sheet_note: '', source: 'app', price_rule: '', price_rule_amount: 0 };
        if (!lk && form.price_rule) {
          target.price_rule = ['', 'cost', 'cost_plus', 'cost_all'].includes(rule) ? rule : '';
          target.price_rule_amount = rule === 'cost_plus' ? (toIntOrNull(form.price_rule_amount.value) || 0) : 0;
        }
        await store.saveClient(target);
        // 「すべて原価」は価格表より優先するので、名前で覚えておく（価格表を読み直しても消えないように）
        if (form.price_rule) {
          let modes = {};
          try { modes = JSON.parse(store.setting('client_price_mode') || '{}') || {}; } catch (err) { modes = {}; }
          const had = modes[v.name] === 'cost_all';
          if (rule === 'cost_all') modes[v.name] = 'cost_all'; else delete modes[v.name];
          if (had !== (rule === 'cost_all')) await store.saveSetting('client_price_mode', JSON.stringify(modes));
        }
        // この取引先の単価（空欄は標準単価）。価格表から来た単価はここでは変えない
        for (const inp of root.querySelectorAll('.cpin')) {
          const pid = Number(inp.dataset.pid), m = mine.get(pid);
          const val = toIntOrNull(inp.value);
          if ((m ? m.price : null) !== val) await store.setClientPrice(target.id, pid, val);
        }
        // 月額固定の明細（変わったときだけ入れ替える）
        const recNew = [];
        for (const tr of root.querySelectorAll('#rec tbody tr')) {
          const nm = tr.querySelector('.rname').value.trim(); if (nm === '') continue;
          const rate = Number(tr.querySelector('.rrate').value);
          recNew.push({ name: nm, qty: parseFloat(tr.querySelector('.rqty').value) || 1, unit: tr.querySelector('.runit').value.trim(), price: toIntOrNull(tr.querySelector('.rprice').value) || 0, tax_rate: [10, 8, 0].includes(rate) ? rate : 10 });
        }
        const pick = (r) => JSON.stringify([r.name, Number(r.qty), r.unit, Number(r.price), Number(r.tax_rate)]);
        if (rec.map(pick).join('|') !== recNew.map(pick).join('|')) await store.replaceRecurring(target.id, recNew);

        flash('取引先を保存しました。');
        if (back) { once.newClient = target.id; go('new'); } else go('clients');
      });

      const del = root.querySelector('#delClient');
      if (del) del.addEventListener('click', async () => {
        if (!(await confirmBox('この取引先を削除しますか？', '削除する'))) return;
        if (store.db.invoices.some((v) => v.client_id === c.id)) { flash('請求書がある取引先は削除できません。', 'err'); go('clients'); return; }
        await store.deleteClient(c.id);
        flash('取引先を削除しました。'); go('clients');
      });
    },
  };
}
