// シービーエムの明細から作る（今までの cbm_import.php と同じ画面）
import { store } from '../store.js';
import { state, go, setBiz, setFilter } from '../nav.js';
import * as cbm from '../cbm-logic.js';
import { parseCbmPdfs } from '../cbm-pdf.js';
import { h, yen, nf, today, endOfNextMonth, toIntOrNull } from '../util.js';
import { flash, showFlash, confirmBox } from '../ui.js';

// 読み込み中の明細（画面を移動しても、作り終えるまで覚えておく）
const work = { tab: '', lines: null, over: {} };
const qtyText = (q) => Number(q).toLocaleString('en-US', { maximumFractionDigits: 2 });
const toDrafts = () => { setBiz(1); setFilter('draft', ''); go('list'); };
// 作り直す前に、何が起きるかを件数で確かめてもらう
async function confirmRebuild(tab) {
  const p = cbm.rebuildPreview(tab);
  if (!p.redo && !p.fresh && !p.unknownStores) { showFlash('作り直すものはありません（未完成の下書きも、新しい取引先もありません）。', 'warn'); return false; }
  const parts = [];
  if (p.redo) parts.push(`未完成の下書き ${p.redo}件を、今の価格で作り直します。`);
  if (p.fresh) parts.push(`まだ下書きのない取引先 ${p.fresh}件は、新しく下書きを作ります。`);
  if (p.unknownStores) parts.push(`取引先に登録のない卸先 ${p.unknownStores}件は、取引先を作って下書きにします。`);
  return confirmBox(`「${tab}」の控えから作り直します。\n\n${parts.join('\n')}\n\nよろしいですか？`, '作り直す');
}

export function cbmPage() {
  cbm.fixStoreMap(); // 名前で覚えている対応を、取引先の番号に直しておく（取引先の名前を変えても切れないように）
  if (!work.lines) return loadPage();
  return planPage();
}

/* ---------- 明細を読み込む ---------- */
function loadPage() {
  const tabs = cbm.storedTabs().reverse();
  const td = today();
  const html = `
<p class="crumb"><a href="#list">請求書</a> ›</p>
<h1>シービーエムの明細から作る</h1>
<p class="muted">シービーエムの請求書の明細を読み込んで、請求先ごとに請求書の下書きを作ります。単価は、それぞれの取引先の販売単価になります。</p>

<form class="card form narrow-wide" id="pdfForm">
  <h2>請求書のPDFから読み込む</h2>
  <p class="small muted">シービーエムから届いた請求書のPDFを選んでください。2枚目・3枚目に分かれているときは、まとめて選びます（順番は自動でそろえます）。読み取った明細の合計が、請求書の小計と合うかを確かめてから取り込みます。</p>
  <label>PDFファイル<input type="file" name="files" accept="application/pdf,.pdf" multiple required></label>
  <p class="small" id="pdfMsg"></p>
  <div class="actions"><button class="btn primary">PDFを読み込む</button></div>
</form>

<details class="card narrow-wide"><summary><b>貼り付けて読み込む</b> <span class="small muted">PDFに文字データがない月など</span></summary>
<form class="form" id="pasteForm" style="margin-top:12px">
  <h2 hidden>新しい月の明細を読み込む</h2>
  <p class="small muted">管理表の「◯月_明細」タブを開き、見出しの行（卸先名・取引日・摘要・数量・単価）から最後の行までを選んでコピーし、下に貼り付けてください。</p>
  <label>何月分の明細ですか<input type="month" name="month" value="${td.slice(0, 7)}" required style="width:auto"></label>
  <label>明細（貼り付け）<textarea name="text" rows="6" class="code" placeholder="卸先名	取引日	摘要	数量	単価 …" required></textarea></label>
  <div class="actions"><button class="btn primary">読み込む</button></div>
</form>
</details>

${tabs.length ? `
<div class="card narrow-wide">
  <h2>前に読み込んだ明細（控え）を使う</h2>
  <p class="small muted">取引先や価格をあとから入れたときは、「未完成を作り直す」で、価格が未設定だった下書きを作り直せます。</p>
  <table class="mini">${tabs.map((t) => `<tr><td><b>${h(t)}</b> <span class="muted small">${cbm.storedLines(t).length}行</span></td>
    <td class="r"><button class="btn small" data-open="${h(t)}">開く</button>${cbm.rebuildPreview(t).redo ? ` <button class="btn small" data-rebuild="${h(t)}">未完成を作り直す</button>` : ''}</td></tr>`).join('')}</table>
</div>` : ''}`;
  return {
    title: 'シービーエムの明細から作る', active: 'list', html,
    mount(root) {
      root.querySelector('#pdfForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target, msg = root.querySelector('#pdfMsg'), btn = f.querySelector('button');
        const picked = [...f.files.files];
        if (!picked.length) return;
        btn.disabled = true; msg.textContent = 'PDFを読んでいます…';
        let res;
        try { res = await parseCbmPdfs(await Promise.all(picked.map(async (x) => ({ name: x.name, buf: await x.arrayBuffer() })))); }
        catch (err) { btn.disabled = false; msg.textContent = ''; showFlash(err.message, 'err'); return; }
        btn.disabled = false; msg.textContent = '';
        if (!res.month) { showFlash('請求日を読み取れませんでした。請求書の1枚目（請求日が書いてあるページ）も一緒に選んでください。', 'err'); return; }
        const tab = `${Number(res.month.slice(0, 4))}年${Number(res.month.slice(5))}月_明細`;
        // 検算：明細の合計と、請求書の小計
        const problems = res.warnings.slice(0, 5);
        if (res.subtotal == null) problems.unshift('請求書の「小計」が見つかりませんでした（最後のページが入っていないかもしれません）。');
        else if (res.subtotal !== res.sum) problems.unshift(`読み取った明細の合計（${nf(res.sum)}円）が、請求書の小計（${nf(res.subtotal)}円）と合いません。ページが足りないか、読み取れない行があります。`);
        if (problems.length && !(await confirmBox('確認が必要な点があります。\n\n・' + problems.join('\n・') + '\n\nこのまま取り込みますか？', 'このまま取り込む'))) return;
        if (cbm.storedTabs().includes(tab) && !(await confirmBox(`「${tab}」の控えがすでにあります（${cbm.storedLines(tab).length}行）。PDFの内容（${res.lines.length}行）で入れ替えますか？`, '入れ替える'))) return;
        const added = await cbm.prepareProducts(res.lines);
        await store.saveCbmLines(tab, res.lines);
        await cbm.saveGeneralRemarks(tab, res.general);
        const flagged = await cbm.flagExisting(tab); // 作成済みの請求書にも、備考の「要確認」を付ける
        Object.assign(work, { tab, lines: cbm.storedLines(tab), over: {} });
        flash(`「${tab}」をPDFから読み込みました（${res.lines.length}行・税抜 ${nf(res.sum)}円${res.subtotal === res.sum ? '・請求書の小計と一致' : ''}）。`
          + (res.notes.length || res.general.length ? ' 請求書に備考があります。下の黄色の枠を確認してください。' : '')
          + (flagged ? ` 作成済みの請求書${flagged}件に「備考あり・要確認」の印を付けました。` : '') + (added ? ` 明細にしかない商品を${added}件、商品に足しました。` : ''), problems.length || res.notes.length || res.general.length ? 'warn' : 'ok');
        go('cbm');
      });
      root.querySelector('#pasteForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target, m = /^(\d{4})-(\d{2})$/.exec(f.month.value);
        if (!m) { showFlash('何月分かを選んでください。', 'err'); return; }
        const tab = `${m[1]}年${Number(m[2])}月_明細`;
        let lines;
        try { lines = cbm.parseLines(f.text.value); } catch (err) { showFlash(err.message, 'err'); return; }
        if (cbm.storedTabs().includes(tab) && !(await confirmBox(`「${tab}」の控えがすでにあります。貼り付けた内容で入れ替えますか？`, '入れ替える'))) return;
        const added = await cbm.prepareProducts(lines);
        await store.saveCbmLines(tab, lines); // 後から作り直せるように控えを残す
        await cbm.saveGeneralRemarks(tab, []);
        Object.assign(work, { tab, lines, over: {} });
        flash(`「${tab}」を読み込みました（${lines.length}行）。` + (added ? `明細にしかない商品を${added}件、商品に足しました。` : '')); go('cbm');
      });
      root.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', async () => {
        const tab = b.dataset.open, lines = cbm.storedLines(tab);
        await cbm.prepareProducts(lines);
        Object.assign(work, { tab, lines, over: {} }); go('cbm');
      }));
      root.querySelectorAll('[data-rebuild]').forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmRebuild(b.dataset.rebuild))) return;
        const res = await cbm.rebuild(b.dataset.rebuild);
        flash(res.msg, res.ids.length ? 'ok' : 'warn'); toDrafts();
      }));
    },
  };
}

/* ---------- 下書きの案を確認して作る ---------- */
function planPage() {
  const { tab, lines } = work;
  const pl = cbm.plan(lines, work.over);
  const allClients = [...store.db.clients].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const allProducts = store.db.products.filter((p) => p.active === 1).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const cname = (id) => (store.client(id) || {}).name || '';
  const pname = (id) => (store.product(id) || {}).name || '';
  const needsStore = (s) => !s.client_id || s.how === 'guess' || s.how === 'none';
  const needStore = [...pl.stores.values()].filter(needsStore).length;
  const needItem = [...pl.items.values()].filter((i) => i.how === 'code' || i.how === 'none').length;
  const month = cbm.monthLabel(tab);
  const done = new Map();
  for (const v of store.db.invoices) if (String(v.source_ref || '').startsWith('cbm:' + tab + ':')) done.set(v.client_id, v);
  const placed = [...pl.invoices.values()].reduce((a, i) => a + i.lines.length, 0);
  const recOf = (cid) => store.db.recurring.filter((r) => r.client_id === cid);
  // 確認が必要：取引先が未登録（新規）の卸先、価格が未設定の取引先
  const errs = [];
  for (const [sname, s] of pl.stores) if (!s.client_id) errs.push(`「${sname}」は取引先に登録されていません（${s.lines}行）。取引先を作って、未完成の下書きにします。`);
  for (const inv of pl.invoices.values()) if (inv.missing > 0) errs.push(`「${inv.client_name}」は価格が未設定です（${inv.missing}行）。未完成の下書きにします（価格は0円）。価格を入れたら「未完成を作り直す」を押してください。`);
  const labels = { alias: '対応表', exact: '同じ名前', code: '名前は違いますが、品番が同じなので下の商品と判断しました。合っていれば何もしなくて大丈夫です。違うときだけ、左で選び直して保存してください。', none: '新しい商品' };
  const td = today();

  const html = `
<p class="crumb"><a href="#list">請求書</a> ›</p>
<h1>シービーエムの明細から作る</h1>
<div class="head-row">
  <p class="muted">「${h(tab)}」${lines.length}行 → 請求書 ${pl.invoices.size}件${placed < lines.length ? `（請求先が決まっていない行が${lines.length - placed}行あります）` : ''}</p>
  <div class="btns"><button class="btn small" id="resetCbm">別の明細を読み込む</button><button class="btn small" id="rebuildCbm">未完成を作り直す</button></div>
</div>

${(() => {
  const gen = cbm.generalRemarks(tab);
  const noted = [...pl.invoices.values()].filter((inv) => inv.lines.some((l) => l.note));
  if (!gen.length && !noted.length) return '';
  return `<section class="card remark-box">
    <h2 style="margin-top:0">請求書のPDFに備考があります <span class="badge warn">目で確認してください</span></h2>
    <p class="small">備考の内容が請求書に正しく反映されているか、下書きを作ったあとに1件ずつ確かめてください。該当の請求書には「備考あり・要確認」の印が付き、確認するまでメールの一括送信の対象から外れます。</p>
    <ul class="small">
      ${noted.flatMap((inv) => inv.lines.filter((l) => l.note).map((l) => `<li><b>${h(inv.client_name)}</b>：${h(l.product_name || l.raw)} ― ${h(l.note)}${l.from === 'PDFの備考（お客様価格）' ? `（単価を ${nf(l.price)}円 にしました）` : '（単価は自動では変えていません）'}</li>`)).join('')}
      ${gen.map((t) => `<li><b>どの明細のことか分からない備考</b>：${h(t)}（この月の請求書すべてに、確認の印を付けます）</li>`).join('')}
    </ul>
  </section>`;
})()}

<form id="mapForm">
  <details class="card"${needStore ? ' open' : ''}>
    <summary><b>店名の対応表</b> <span class="muted small">明細の卸先名 → 請求先</span>${needStore ? ` <span class="badge b-overdue">確認が必要 ${needStore}件</span>` : ''}</summary>
    <div class="table-wrap mt">
    <table class="list small map">
      <thead><tr><th>明細の卸先名</th><th class="r">行数</th><th>請求先の取引先</th><th>確認すること</th></tr></thead>
      ${[...pl.stores].map(([name, s]) => `
        <tr class="${needsStore(s) ? 'need' : ''}">
          <td>${h(name)}</td><td class="r">${s.lines}</td>
          <td><select data-store="${h(name)}">
            <option value="">${s.client_id && s.client_id !== 'skip' ? '自動：' + h(cname(s.client_id)) : '（選んでください）'}</option>
            <option value="skip"${s.client_id === 'skip' ? ' selected' : ''}>請求しない</option>
            ${allClients.map((c) => `<option value="${c.id}"${(s.how === 'map' || s.how === 'guess') && s.client_id === c.id ? ' selected' : ''}>${h(c.name)}</option>`).join('')}
          </select></td>
          <td class="small">${s.how === 'guess' ? `名前が少し違うので、似ている「${h(cname(s.client_id))}」を選んであります。<b>合っていれば、下の「対応表を保存して作り直す」を押してください</b>（次からは聞きません）。違うときは選び直してください。`
            : (!s.client_id ? '取引先に登録がありません。請求先を選んで保存してください。選ばずに進むと、この名前で取引先を新しく作ります。' : '')}</td>
        </tr>`).join('')}
    </table>
    </div>
  </details>
  <details class="card"${needItem ? ' open' : ''}>
    <summary><b>商品名の対応表</b> <span class="muted small">明細の品名 → 価格表の商品</span>${needItem ? ` <span class="badge b-partial">確認 ${needItem}件</span>` : ''}</summary>
    <div class="table-wrap mt">
    <table class="list small map">
      <thead><tr><th>明細の品名</th><th class="r">仕入単価</th><th>価格表の商品</th><th>判定</th></tr></thead>
      ${[...pl.items].map(([name, it]) => `
        <tr class="${it.how === 'code' ? 'need' : ''}">
          <td>${h(name)}</td><td class="r">${it.cost != null ? nf(it.cost) : ''}</td>
          <td><select data-item="${h(name)}">
            <option value="">自動</option>
            ${allProducts.map((p) => `<option value="${p.id}"${it.how === 'alias' && it.product_id === p.id ? ' selected' : ''}>${h(p.name)}</option>`).join('')}
          </select></td>
          <td class="small">${h(labels[it.how] || '')}${it.how !== 'alias' && it.product_id ? `<br><span class="muted">${h(pname(it.product_id))}</span>` : ''}</td>
        </tr>`).join('')}
    </table>
    </div>
    <p class="small muted">「新しい商品」は、価格表にない品名です。商品一覧に足してあり、「原価＋◯円」のような決まりがある取引先ではその金額が入ります。</p>
  </details>
  <div class="btn-row"><button class="btn small">対応表を保存して作り直す</button></div>
</form>

${errs.length ? `<div class="flash warn mt"><b>確認が必要（${errs.length}件）</b><ul>${errs.map((e) => `<li>${h(e)}</li>`).join('')}</ul></div>` : ''}

<form class="mt" id="createForm">
  <div class="card form">
    <div class="grid4">
      <label class="span2">件名（全部の請求書に入ります）<input name="title" value="${h(month ? '薬局消耗品 ' + month : '薬局消耗品')}"></label>
      <label>発行日<input type="date" name="issue_date" value="${td}"></label>
      <label>お支払期限<input type="date" name="due_date" value="${endOfNextMonth(td)}"></label>
      <label class="span2">備考<input name="notes" value="振込手数料はご負担願います。"></label>
      <label class="check span2"><input type="checkbox" name="remember" value="1"> 手で入れた単価を、その取引先の単価として覚える</label>
      <label class="check span2"><input type="checkbox" name="recurring" value="1" checked> 取引先の月額固定（コンサルティングフィーなど）も「その他」に入れる</label>
    </div>
  </div>

  ${[...pl.invoices].map(([cid, inv]) => { const d = done.get(cid); const rc = recOf(cid); return `
    <section class="card plan${inv.missing ? ' has-missing' : ''}">
      <div class="plan-head">
        <label class="check"><input type="checkbox" name="make" value="${cid}"${d && !(d.status === 'draft' && d.incomplete === 1) ? '' : ' checked'}> <b>${h(inv.client_name)}</b></label>
        <span class="muted small">${inv.lines.length}行${inv.show_ship ? '・納品先 ' + inv.stores.size + '店' : ''}</span>
        <span class="plan-total">税抜 ${yen(inv.subtotal)}${inv.cost ? ` <span class="muted small">（仕入 ${yen(inv.cost)}／粗利 ${yen(inv.subtotal - inv.cost)}）</span>` : ''}</span>
        ${rc.length ? `<span class="badge b-opened">＋月額固定 ${rc.length}行 ${yen(rc.reduce((a, r) => a + r.qty * r.price, 0))}</span>` : ''}
        ${d ? `<span class="badge b-sent">作成済み <a href="#invoice-${d.id}">${h(d.number)}</a></span>${d.status !== 'draft' ? ' <span class="small muted">送付済みのため作り直しません</span>' : (d.incomplete === 1 ? ' <span class="small muted">未完成の下書きなので、作り直します</span>' : '')}` : ''}
        ${inv.missing ? `<span class="badge b-overdue">単価が未設定 ${inv.missing}行</span>` : ''}
      </div>
      <div class="table-wrap">
      <table class="list small plan-lines">
        <thead><tr>${inv.show_ship ? '<th>納品先</th>' : ''}<th>取引日</th><th>品名</th><th class="r">数量</th><th class="r">仕入</th><th class="r w-price">単価</th><th class="r">金額</th></tr></thead>
        ${inv.lines.map((l) => `
          <tr class="${l.price == null ? 'missing' : ''}">
            ${inv.show_ship ? `<td>${h(l.store)}</td>` : ''}
            <td>${h(l.date)}</td>
            <td>${h(l.product_name || l.raw)}${l.product_name && l.product_name !== l.raw ? `<br><span class="muted">管理表：${h(l.raw)}</span>` : ''}${l.note ? `<br><span class="badge warn">備考</span> <span class="small">${h(l.note)}</span>` : ''}</td>
            <td class="r">${h(qtyText(l.qty))}</td>
            <td class="r muted">${l.cbm_cost != null ? nf(l.cbm_cost) : ''}</td>
            <td class="r"><input data-key="${l.key}" value="${h(l.price ?? '')}" class="r${l.price == null ? ' warn-input' : ''}" inputmode="numeric" placeholder="未設定"><span class="hint${l.from === '手入力' ? ' manual' : (l.from && l.from !== '標準単価' ? ' mine' : '')}">${h(l.from)}</span></td>
            <td class="r">${l.price != null ? nf(Math.round(l.qty * l.price)) : ''}</td>
          </tr>`).join('')}
      </table>
      </div>
    </section>`; }).join('')}

  ${done.size ? '<label class="check small"><input type="checkbox" name="again" value="1"> 作成済みの取引先も、もう一度作る</label>' : ''}
  <div class="actions sticky-actions">
    <span class="muted small">単価を入れた取引先と、未完成の下書きは、作成済みでも作り直します。単価が未設定の行は0円で作られます。</span>
    <button class="btn primary">チェックした請求書の下書きを作る</button>
  </div>
</form>`;

  return {
    title: 'シービーエムの明細から作る', active: 'list', html,
    mount(root) {
      // 画面に入っている手入力の単価を集める
      const typedPrices = () => { const o = {}; root.querySelectorAll('input[data-key]').forEach((i) => { const v = toIntOrNull(i.value); if (v !== null) o[i.dataset.key] = v; }); return o; };
      // 自動で入った単価と同じ金額は「手入力」にしない
      const realOverrides = () => {
        const typed = typedPrices(), auto = cbm.plan(lines, {}), out = {};
        const autoPrice = new Map(); for (const inv of auto.invoices.values()) for (const l of inv.lines) autoPrice.set(l.key, l.price);
        for (const [k, v] of Object.entries(typed)) if (autoPrice.get(k) !== v) out[k] = v;
        return out;
      };

      // 単価を手で入れたら、その取引先を作る対象にする（作成済みの下書きも作り直す）
      root.querySelectorAll('section.plan input[data-key]').forEach((i) => i.addEventListener('input', () => {
        const box = i.closest('section.plan').querySelector('input[name="make"]'); if (box && !box.disabled) box.checked = true;
      }));
      root.querySelector('#resetCbm').addEventListener('click', () => { Object.assign(work, { tab: '', lines: null, over: {} }); go('cbm'); });
      root.querySelector('#rebuildCbm').addEventListener('click', async () => {
        if (!(await confirmRebuild(tab))) return;
        const res = await cbm.rebuild(tab);
        flash(res.msg, res.ids.length ? 'ok' : 'warn'); toDrafts();
      });

      // 店名・品名の対応を保存
      root.querySelector('#mapForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const map = cbm.storeMap(), alias = cbm.productAlias();
        const before = JSON.stringify([map, alias]);
        root.querySelectorAll('select[data-store]').forEach((s) => {
          const k = s.dataset.store, v = s.value;
          if (v === '') delete map[k]; else map[k] = v === 'skip' ? 'skip' : Number(v);
        });
        root.querySelectorAll('select[data-item]').forEach((s) => {
          const k = s.dataset.item, v = s.value;
          if (v === '') delete alias[k]; else { const p = store.product(Number(v)); if (p) alias[k] = p.name; }
        });
        if (JSON.stringify([map, alias]) !== before) {
          await store.saveSetting('cbm_store_map', JSON.stringify(map));
          await store.saveSetting('cbm_product_alias', JSON.stringify(alias));
        }
        work.over = realOverrides();
        flash('対応表を保存しました。'); go('cbm');
      });

      // 下書きを作る
      root.querySelector('#createForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        const f = e.target;
        const over = realOverrides();
        await store.saveCbmLines(tab, lines);
        await cbm.ensureClients(lines); // 取引先が未登録の卸先は、取引先を作って進める
        const p2 = cbm.plan(lines, over);
        // チェックを外した取引先は作らない。取引先を作ったばかりのものは対象にする
        const unchecked = new Set([...f.querySelectorAll('input[name="make"]:not(:checked)')].map((c) => Number(c.value)));
        const skipped = [];
        const ids = await cbm.create(tab, p2, {
          skipped,
          clients: [...p2.invoices.keys()].filter((cid) => !unchecked.has(cid)),
          title: f.title.value.trim(), issue: f.issue_date.value, due: f.due_date.value, notes: f.notes.value.trim(),
          remember: f.remember.checked, again: !!(f.again && f.again.checked), recurring: f.recurring.checked,
        });
        Object.assign(work, { tab: '', lines: null, over: {} });
        flash((ids.length ? ids.length + '件の請求書の下書きを作りました（作り直しを含みます）。内容を確認して送ってください。' : '作った請求書はありません（すでに作成済みか、チェックがありません）。')
          + (skipped.length ? ' 送付済みの請求書は作り直していません：' + skipped.join('、') : ''), ids.length ? 'ok' : 'warn');
        toDrafts();
      });
    },
  };
}
