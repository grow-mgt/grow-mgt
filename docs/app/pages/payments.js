// 入金照合（今までの payments.php と同じ画面）：銀行の入出金明細CSVを読み、請求書と突き合わせて消し込む
import { store } from '../store.js';
import { state, go } from '../nav.js';
import { refreshPaymentStatus } from '../logic.js';
import { h, yen, nf, today, nowUtc, slashDate } from '../util.js';
import { flash, showFlash } from '../ui.js';
import { decodeBytes, parseCsv } from '../csv.js';

// 読み込み中のCSV（消し込みが終わるまで覚えておく）
const work = { rows: null, biz: 0, name: '', step: 'upload', matches: null };
const reset = () => Object.assign(work, { rows: null, biz: 0, name: '', step: 'upload', matches: null });

/* ---------- 便利関数 ---------- */
const toHalf = (s) => String(s).replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
const pad = (n, w = 2) => String(n).padStart(w, '0');

const parseAmount = (s) => parseInt(toHalf(s).replace(/[^\d-]/g, ''), 10) || 0;
function parseDateJp(s) {
  s = toHalf(s).trim(); let m;
  if ((m = /^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})/.exec(s))) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = /^(?:令和|R)\s*(\d{1,2})[/\-.年](\d{1,2})[/\-.月](\d{1,2})/u.exec(s))) return `${2018 + Number(m[1])}-${pad(m[2])}-${pad(m[3])}`;
  if ((m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s)) && Number(m[1]) < 30) return `${2018 + Number(m[1])}-${pad(m[2])}-${pad(m[3])}`; // 和暦の年だけ（例 08.10.31）
  return null;
}
// 通帳のカナ名義を比べやすい形にそろえる
const SMALL = { 'ァ': 'ア', 'ィ': 'イ', 'ゥ': 'ウ', 'ェ': 'エ', 'ォ': 'オ', 'ッ': 'ツ', 'ャ': 'ヤ', 'ュ': 'ユ', 'ョ': 'ヨ', 'ヮ': 'ワ', 'ー': '-' };
const DROP = ['カブシキガイシヤ', 'ユウゲンガイシヤ', 'ゴウドウガイシヤ', 'イリヨウホウジン', 'カ)', '(カ', 'ユ)', '(ユ', 'ド)', '(ド', 'イ)', '(イ', 'シヤ)', '(シヤ', 'ザイ)', '(ザイ'];
function normKana(s) {
  s = toHalf(s).replace(/[｡-ﾟ]+/g, (m) => m.normalize('NFKC'))           // 半角カナ → 全角カナ
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)) // ひらがな → カタカナ
    .toUpperCase().replace(/[ァィゥェォッャュョヮー]/g, (c) => SMALL[c]);
  for (const w of DROP) s = s.split(w).join('');
  return s.replace(/[\s().\-,、。・/「」]/gu, '');
}
const guessCol = (header, words) => { for (let i = 0; i < header.length; i++) for (const w of words) if (header[i].includes(w)) return String(i); return ''; };
async function sha1(text) {
  const d = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}
const cut = (s, n) => { const a = [...String(s)]; return a.length > n ? a.slice(0, n).join('') + '…' : a.join(''); };

/* ---------- 突き合わせ ---------- */
// 同じ銀行口座を使っている事業（例：CBM・コンサル・その他）。口座が同じなら、まとめて請求書を探す
const bankKey = (b) => toHalf(String((b && b.bank) || '')).replace(/\s+/gu, '');
export function sameAccount(PB) {
  const k = bankKey(PB);
  return store.businesses().filter((b) => b.id === PB.id || (k !== '' && bankKey(b) === k));
}
async function buildMatches(PB) {
  const bizIds = new Set(sameAccount(PB).map((b) => b.id));
  const dc = Number(PB.csv_date_col) || 0, ac = Number(PB.csv_amount_col) || 0, nc = Number(PB.csv_name_col) || 0;
  const unpaid = store.db.invoices.filter((v) => v.status !== 'paid' && bizIds.has(v.business_id))
    .map((v) => { const c = store.client(v.client_id) || {}; return { ...v, client_name: c.name || '', payer_kana: c.payer_kana || '' }; })
    .sort((a, b) => (a.due_date > b.due_date ? 1 : a.due_date < b.due_date ? -1 : 0));
  const doneSet = new Set(store.db.invoices.flatMap((v) => (v.payments || []).map((p) => p.row_hash).filter(Boolean)));
  const matches = [], usedInv = new Set(), seen = new Map();
  const body = work.rows.slice(Math.max(0, parseInt(PB.csv_skip_rows, 10) || 0));
  for (let lineNo = 0; lineNo < body.length; lineNo++) {
    const r = body[lineNo];
    const amount = parseAmount(r[ac] ?? '');
    if (amount <= 0) continue;
    const date = parseDateJp(r[dc] ?? '') ?? today();
    const name = r[nc] ?? '';
    // 同じ明細を2回取り込まないための印（期間を変えて落としたCSVでも同じ値になるように）
    const rowKey = r.join('|');
    seen.set(rowKey, (seen.get(rowKey) || 0) + 1);
    const hash = await sha1(rowKey + '#' + seen.get(rowKey));
    const nName = normKana(name);
    const cands = [];
    for (const inv of unpaid) {
      const remain = inv.total - inv.paid_amount;
      const keys = String(inv.payer_kana).split(',').concat([inv.client_name]).map(normKana).filter((k) => [...k].length >= 2);
      const nameHit = nName !== '' && keys.some((k) => nName.includes(k) || k.includes(nName));
      const diff = remain - amount;
      let score = 0; const why = [];
      if (diff === 0) { score += 60; why.push('金額一致'); }
      else if (diff > 0 && diff <= 990) { score += 35; why.push('手数料差引？（差額' + yen(diff) + '）'); }
      else if (inv.total === amount) { score += 40; why.push('請求額と一致'); }
      if (nameHit) { score += 40; why.push('名義一致'); } else if (score > 0) why.push('名義は不一致');
      if (score >= 40) cands.push({ inv, score, why, fee: diff > 0 && diff <= 990 });
    }
    // 2通分をまとめて振り込まれたとき（同じ取引先・名義一致・合計がぴったり）
    if (!cands.some((c) => c.score >= 75)) {
      const mine = unpaid.filter((inv) => { const keys = String(inv.payer_kana).split(',').concat([inv.client_name]).map(normKana).filter((k) => [...k].length >= 2); return nName !== '' && keys.some((k) => nName.includes(k) || k.includes(nName)); });
      for (let i = 0; i < mine.length; i++) for (let j = i + 1; j < mine.length; j++) {
        const a = mine[i], b = mine[j];
        if (a.client_id === b.client_id && (a.total - a.paid_amount) + (b.total - b.paid_amount) === amount) cands.push({ inv: a, inv2: b, score: 95, why: ['2通まとめて入金（合計一致）', '名義一致'], fee: false });
      }
    }
    cands.sort((a, b) => b.score - a.score);
    const best = cands[0] || null;
    const done = doneSet.has(hash);
    // 金額（または手数料差引の金額）と名義の両方が合うときだけ最初からチェック。名義違いは候補を選んだ状態で手で確認
    let auto = false;
    if (best && !done) { auto = best.score >= 75 && !usedInv.has(best.inv.id) && !(best.inv2 && usedInv.has(best.inv2.id)); if (auto) { usedInv.add(best.inv.id); if (best.inv2) usedInv.add(best.inv2.id); } }
    matches.push({ key: 'r' + lineNo, date, amount, name, hash, cands, best, auto, done });
  }
  return { matches, unpaid };
}

/* ---------- 画面 ---------- */
export function paymentsPage() {
  const PB = store.bizOf(state.biz || store.businesses()[0].id);
  const group = sameAccount(PB), groupIds = new Set(group.map((b) => b.id));
  if (work.rows && !groupIds.has(work.biz)) reset(); // 口座が違う事業に変えたらやり直し
  if (!work.rows) work.step = 'upload';
  const step = work.step;

  const top = `
<h1>入金照合 <span class="muted small">${h(PB.name)}</span></h1>
${state.biz === 0 ? `<div class="flash warn">銀行口座は事業ごとに分かれているので、上のタブで事業を選んでから入金明細のCSVを読み込んでください（いまは「${h(PB.name)}」で開いています）。</div>` : ''}
${String(PB.bank || '').trim() !== '' ? `<p class="muted small">この事業の口座：${h(String(PB.bank).replace(/\s+/gu, ' '))}　（この口座の入出金明細を読み込んでください）</p>` : ''}
${group.length > 1 ? `<p class="muted small">同じ口座を使っている事業（${h(group.map((b) => b.name).join('・'))}）の請求書を、まとめて探します。</p>` : ''}
<ol class="wizard">
  <li class="${step === 'upload' ? 'on' : 'done'}">1. CSVを選ぶ</li>
  <li class="${step === 'map' ? 'on' : (step === 'match' ? 'done' : '')}">2. 列を合わせる</li>
  <li class="${step === 'match' ? 'on' : ''}">3. 確認して消し込む</li>
</ol>`;

  if (step === 'upload') {
    const recent = store.db.invoices.filter((v) => groupIds.has(v.business_id))
      .flatMap((v) => (v.payments || []).map((p) => ({ ...p, number: v.number, iid: v.id, client_name: (store.client(v.client_id) || {}).name || '' })))
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')) || (b.id - a.id)).slice(0, 15);
    return {
      title: '入金照合', active: 'payments',
      html: top + `
<form class="card form" id="csvForm">
  <p>ネットバンキングからダウンロードした入出金明細のCSVを選んでください。Shift_JISのままで大丈夫です。</p>
  <input type="file" name="csv" accept=".csv,.txt,text/csv" required>
  <div class="actions"><button class="btn primary">読み込む</button></div>
</form>
${recent.length ? `
<h2>最近の入金記録</h2>
<div class="table-wrap"><table class="list">
  <thead><tr><th>入金日</th><th>取引先</th><th>請求書</th><th class="r">金額</th><th>名義など</th><th>方法</th></tr></thead>
  ${recent.map((p) => `<tr style="cursor:default"><td>${h(slashDate(p.paid_date))}</td><td>${h(p.client_name)}</td>
    <td class="mono"><a href="#invoice-${p.iid}">${h(p.number)}</a></td><td class="r">${yen(p.amount)}</td>
    <td class="small">${h(p.payer)}</td><td class="small muted">${p.source === 'csv' ? 'CSV' : '手入力'}</td></tr>`).join('')}
</table></div>` : ''}`,
      mount(root) {
        root.querySelector('#csvForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const file = e.target.csv.files[0];
          if (!file) { showFlash('CSVファイルを選んでください。', 'err'); return; }
          try {
            const rows = parseCsv(decodeBytes(await file.arrayBuffer()));
            Object.assign(work, { rows, biz: PB.id, name: file.name, step: 'map', matches: null });
            go('payments');
          } catch (err) { showFlash(err.message, 'err'); }
        });
      },
    };
  }

  if (step === 'map') {
    const csv = work.rows, header = csv[0];
    const dateCol = PB.csv_date_col !== '' && PB.csv_date_col != null ? String(PB.csv_date_col) : guessCol(header, ['取引日', '日付', '年月日', '勘定日']);
    const amtCol = PB.csv_amount_col !== '' && PB.csv_amount_col != null ? String(PB.csv_amount_col) : guessCol(header, ['入金', 'お預', '預入', '預かり', 'お預入']);
    const nameCol = PB.csv_name_col !== '' && PB.csv_name_col != null ? String(PB.csv_name_col) : guessCol(header, ['依頼人', '摘要', '内容', 'お取引内容', '取引内容', '備考']);
    const cols = Math.max(...csv.slice(0, 10).map((r) => r.length));
    const idx = [...Array(cols).keys()];
    const pick = (name, label, val) => `<label>${label}<select name="${name}">${idx.map((i) => `<option value="${i}"${String(i) === String(val) ? ' selected' : ''}>${i + 1}列目：${h(cut(header[i] ?? '', 9))}</option>`).join('')}</select></label>`;
    return {
      title: '入金照合', active: 'payments',
      html: top + `
<form class="card form" id="mapForm">
  <p>「${h(work.name)}」を読み込みました（${csv.length}行）。どの列が何かを選んでください。次回からは同じ設定を使います。</p>
  <div class="grid4">
    ${pick('date_col', '日付の列', dateCol)}${pick('amount_col', '入金額の列', amtCol)}${pick('name_col', '振込名義・摘要の列', nameCol)}
    <label>先頭の見出し行の数<input type="number" name="skip_rows" min="0" value="${h(PB.csv_skip_rows ?? '1')}"></label>
  </div>
  <div class="table-wrap"><table class="list small">
    <thead><tr>${idx.map((i) => `<th>${i + 1}列目</th>`).join('')}</tr></thead>
    ${csv.slice(0, 8).map((r) => `<tr style="cursor:default">${idx.map((i) => `<td>${h(r[i] ?? '')}</td>`).join('')}</tr>`).join('')}
  </table></div>
  <div class="actions"><button type="button" class="btn" id="redo">やり直す</button><button class="btn primary">照合する</button></div>
</form>`,
      mount(root) {
        root.querySelector('#redo').addEventListener('click', () => { reset(); go('payments'); });
        root.querySelector('#mapForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const f = e.target;
          // 列の設定は事業（＝銀行口座）ごとに覚える
          const next = { csv_date_col: String(Number(f.date_col.value)), csv_amount_col: String(Number(f.amount_col.value)), csv_name_col: String(Number(f.name_col.value)), csv_skip_rows: String(Math.max(0, parseInt(f.skip_rows.value, 10) || 0)) };
          const b = store.bizOf(PB.id);
          if (Object.keys(next).some((k) => String(b[k] ?? '') !== next[k])) await store.saveBusiness(Object.assign(b, next));
          const res = await buildMatches(b);
          work.matches = res; work.step = 'match';
          go('payments');
        });
      },
    };
  }

  // step === 'match'
  const { matches, unpaid } = work.matches;
  const label = (u) => h(u.number + ' ' + u.client_name + ' 残' + nf(u.total - u.paid_amount));
  return {
    title: '入金照合', active: 'payments',
    html: top + (!matches.length ? `<div class="empty">入金の行が見つかりませんでした。<a href="#payments" id="backMap">列の設定</a>を見直してください。</div>` : `
<form id="applyForm">
  <p class="muted">チェックを付けた行を、選んだ請求書の入金として記録します。金額と名義が一致したものには最初からチェックが付いています。</p>
  <div class="table-wrap"><table class="list match">
    <thead><tr><th></th><th>入金日</th><th>振込名義・摘要</th><th class="r">入金額</th><th>消し込む請求書</th><th>判定</th></tr></thead>
    <tbody>
    ${matches.map((m) => `
      <tr class="${m.done ? 'done' : (m.auto ? 'hit' : '')}" data-key="${m.key}" style="cursor:default">
        <td>${m.done ? '' : `<input type="checkbox" class="use"${m.auto ? ' checked' : ''}>`}</td>
        <td>${h(slashDate(m.date))}</td>
        <td class="small">${h(m.name)}</td>
        <td class="r">${yen(m.amount)}</td>
        <td>${m.done ? '<span class="muted small">取込済</span>' : `
          <select class="inv">
            <option value="">— 選ばない —</option>
            ${m.cands.length ? `<optgroup label="候補">${m.cands.map((c, i) => `<option value="${c.inv.id}${c.inv2 ? '+' + c.inv2.id : ''}"${i === 0 ? ' selected' : ''}>${c.inv2 ? '【2通】' + label(c.inv) + ' ＋ ' + label(c.inv2) : label(c.inv)}</option>`).join('')}</optgroup>` : ''}
            <optgroup label="すべての未入金">${unpaid.map((u) => `<option value="${u.id}">${label(u)}</option>`).join('')}</optgroup>
          </select>
          ${m.best && m.best.fee ? '<label class="check small"><input type="checkbox" class="fee" checked> 差額は振込手数料として全額入金扱い</label>' : ''}`}
        </td>
        <td class="small">${m.best ? h(m.best.why.join('・')) : '<span class="muted">候補なし</span>'}</td>
      </tr>`).join('')}
    </tbody>
  </table></div>
  <div class="actions"><button type="button" class="btn" id="backMap">列の設定に戻る</button><button class="btn primary">チェックした入金を消し込む</button></div>
</form>`),
    mount(root) {
      root.querySelector('#backMap').addEventListener('click', (e) => { e.preventDefault(); work.step = 'map'; go('payments'); });
      const f = root.querySelector('#applyForm'); if (!f) return;
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const allHashes = new Set(store.db.invoices.flatMap((v) => (v.payments || []).map((p) => p.row_hash).filter(Boolean)));
        let n = 0;
        for (const tr of f.querySelectorAll('tbody tr')) {
          const use = tr.querySelector('.use'); if (!use || !use.checked) continue;
          const m = matches.find((x) => x.key === tr.dataset.key);
          const ids = String(tr.querySelector('.inv').value).split('+').map(Number);
          const inv = store.invoice(ids[0]);
          if (!m || !inv || allHashes.has(m.hash)) continue;
          if (ids.length === 2) { // 2通まとめての入金：それぞれの残額に分けて記録する
            const pair = [inv, store.invoice(ids[1])];
            if (!pair[1] || pair.reduce((a, v) => a + v.total - v.paid_amount, 0) !== m.amount) continue;
            for (const v of pair) {
              v.payments = v.payments || [];
              v.payments.push({ id: store.newId(), paid_date: m.date, amount: v.total - v.paid_amount, payer: m.name + '（2通まとめて ' + yen(m.amount) + '）', source: 'csv', row_hash: m.hash, created_at: nowUtc() });
              refreshPaymentStatus(v);
              store.logEvent(v, 'pay', '入金を照合（CSV・2通まとめて）：' + yen(m.amount) + ' ' + m.name + '（' + m.date + '）');
              await store.saveInvoice(v);
            }
            allHashes.add(m.hash); n++; continue;
          }
          let amount = m.amount, note = m.name;
          const fee = tr.querySelector('.fee');
          if (fee && fee.checked) { // 振込手数料を差し引かれた入金を全額扱いにする
            const remain = inv.total - inv.paid_amount;
            if (remain > amount) { note += '（手数料差引 ' + yen(remain - amount) + '）'; amount = remain; }
          }
          inv.payments = inv.payments || [];
          inv.payments.push({ id: store.newId(), paid_date: m.date, amount, payer: note, source: 'csv', row_hash: m.hash, created_at: nowUtc() });
          allHashes.add(m.hash);
          refreshPaymentStatus(inv);
          store.logEvent(inv, 'pay', '入金を照合（CSV）：' + yen(m.amount) + ' ' + m.name + '（' + m.date + '）');
          await store.saveInvoice(inv);
          n++;
        }
        reset();
        flash(n ? n + '件の入金を消し込みました。' : '消し込んだ入金はありません。', n ? 'ok' : 'warn'); go('payments');
      });
    },
  };
}
