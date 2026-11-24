// invoyで発行した請求書（invoyの「請求書CSV」）を取り込む。今までの invoy_import.php と同じ画面
// CSVには明細がないので、件名と請求額（税込）で1行の請求書として入れる。ステータスはinvoyのまま。
import { store } from '../store.js';
import { go, setBiz } from '../nav.js';
import { normName, similarPct } from '../cbm-logic.js';
import { decodeBytes, parseCsv } from '../csv.js';
import { h, yen, nf, today, nowUtc, slashDate, randomToken } from '../util.js';
import { flash, showFlash } from '../ui.js';

// invoyのステータス → アプリのステータス
const INVOY_STATUS = {
  '下書き': 'draft', '未請求': 'draft', '未送付': 'draft',
  '請求済': 'sent', '送付済': 'sent', '送付済み': 'sent', '発行済': 'sent', '送信済': 'sent',
  '開封済': 'opened', '開封済み': 'opened', '閲覧済': 'opened', '閲覧済み': 'opened', '既読': 'opened',
  '入金済': 'paid', '入金済み': 'paid', '支払済': 'paid', '消込済': 'paid',
};
const work = { rows: null, from: '2026-04-01', to: '2027-03-31' };
const json = (key) => { try { return JSON.parse(store.setting(key) || '{}') || {}; } catch (e) { return {}; } };
const len = (s) => [...s].length;

function parse(text) {
  const all = parseCsv(text);
  const head = all[0];
  for (const n of ['請求書番号', '件名', '請求先', '請求額', 'ステータス', 'お支払い期限']) if (!head.includes(n)) throw new Error('invoyの請求書CSVではないようです（「' + n + '」の列がありません）。');
  const ix = (n) => head.indexOf(n);
  const rows = [];
  for (const r of all.slice(1)) {
    if (String(r[0] ?? '').trim() === '') continue;
    const num = String(r[ix('請求書番号')] ?? '').trim();
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(num);
    rows.push({ number: num, issue: m ? `${m[1]}-${m[2]}-${m[3]}` : '', title: String(r[ix('件名')] ?? '').replace(/\s+/gu, ' ').trim(), to: String(r[ix('請求先')] ?? '').trim(),
      total: parseInt(String(r[ix('請求額')] ?? '').replace(/,/g, ''), 10) || 0, status: String(r[ix('ステータス')] ?? '').trim(), due: String(r[ix('お支払い期限')] ?? '').trim(),
      notes: ix('備考') >= 0 ? String(r[ix('備考')] ?? '').trim() : '' });
  }
  return rows;
}

// 「〇〇薬局 / 株式会社△△」「〇〇薬局　代表 □□」などを、取引先名と法人名で照合する
function match(to, clients, map) {
  if (Object.prototype.hasOwnProperty.call(map, to)) return [map[to] === 'new' ? null : Number(map[to]), 'manual'];
  const parts = to.split(/\s*[/／]\s*|　+|\s{2,}/u).map((p) => p.trim()).filter((p) => p !== '' && !/^代表/u.test(p));
  const cands = [...new Set([to, parts.join(' '), ...parts])];
  for (const c of cands) { // 完全一致（取引先名・法人名）
    const n = normName(c);
    for (const cl of clients) if (n !== '' && (n === normName(cl.name) || ((cl.corp_name || '') !== '' && n === normName(cl.corp_name)))) return [cl.id, 'exact'];
  }
  for (const c of cands) { // 一部一致（ひとつに決まるときだけ）
    const n = normName(c);
    if (len(n) < 3) continue;
    const hits = new Set();
    for (const cl of clients) for (const x of [cl.name, cl.corp_name || '']) { const xn = normName(x); if (xn !== '' && (xn.includes(n) || n.includes(xn))) { hits.add(cl.id); break; } }
    if (hits.size === 1) return [[...hits][0], 'partial'];
  }
  let best = null, bp = 0, second = 0; // 似ている名前
  for (const c of cands) for (const cl of clients) {
    const p = similarPct(normName(c), normName(cl.name));
    if (p > bp) { second = Math.max(second, bp); bp = p; best = cl.id; } else if (p > second && cl.id !== best) second = p;
  }
  if (best && bp >= 80 && bp - second >= 8) return [best, 'guess'];
  return [null, 'none'];
}

function plan(rows) {
  const clients = store.db.clients, map = json('invoy_client_map'), bmap = json('invoy_biz_map');
  const have = new Set(store.db.invoices.map((v) => v.number));
  const out = { rows: [], names: new Map() };
  for (const r of rows) {
    if (r.issue === '' || r.issue < work.from || r.issue > work.to) continue;
    if (!out.names.has(r.to)) {
      const [cid, how] = match(r.to, clients, map);
      const cb = cid && store.client(cid) ? store.client(cid).business_id : 1;
      out.names.set(r.to, { client_id: cid, how, count: 0, sum: 0, business_id: Number(bmap[r.to] ?? cb) || 1 });
    }
    const n = out.names.get(r.to); n.count++; n.sum += r.total;
    out.rows.push({ ...r, exists: have.has(r.number) });
  }
  return out;
}

async function doImport(pl) {
  const n = { invoices: 0, clients: 0, skipped: 0 };
  const map = json('invoy_client_map');
  for (const [name, info] of pl.names) {
    if (info.client_id) continue;
    // 取引先にない請求先は、その名前で取引先を作る（法人名らしい部分は法人名に）
    const parts = name.split(/\s*[/／]\s*|　+/u).map((p) => p.trim()).filter((p) => p !== '' && !/^代表/u.test(p));
    const main = parts[0] ?? name;
    let corp = '';
    for (const p of parts) if (/(株式会社|有限会社|合同会社|医療法人)/u.test(p)) corp = p;
    // 会社・薬局でなさそうな名前（個人）は「様」
    const hon = (corp === '' && !/(薬局|会社|法人|医院|クリニック|病院|事務所|[A-Za-z]{3,})/u.test(main)) ? '様' : '御中';
    let c = store.db.clients.find((x) => x.name === main);
    if (!c) {
      c = { id: store.newId() + n.clients, name: main, honorific: hon, contact: '', email: '', cc: '', postal: '', address: '', payer_kana: '', memo: '', created_at: nowUtc(),
        group_name: '', corp_name: corp === main ? '' : corp, representative: '', billing_method: '', sheet_note: '', source: 'app', price_rule: '', price_rule_amount: 0, business_id: info.business_id };
      await store.saveClient(c);
    }
    info.client_id = c.id; map[name] = c.id; n.clients++;
  }
  for (const r of pl.rows) {
    if (r.exists) { n.skipped++; continue; }
    const info = pl.names.get(r.to);
    const status = INVOY_STATUS[r.status] || 'sent';
    const stamp = r.issue + ' 00:00:00';
    const opened = (status === 'opened' || status === 'paid') && /開封|閲覧|既読/u.test(r.status);
    const base = store.newId();
    const dueOk = /^\d{4}-\d{2}-\d{2}$/.test(r.due.replace(/\//g, '-')) ? r.due.replace(/\//g, '-') : '';
    const due = dueOk || r.issue;
    const inv = { id: base + 900, number: r.number, client_id: info.client_id, title: r.title, issue_date: r.issue, due_date: due, notes: r.notes, withholding: 0,
      subtotal: r.total, tax: 0, withholding_amount: 0, total: r.total, token: randomToken(), status, sent_at: status === 'draft' ? null : stamp,
      opened_at: opened ? stamp : null, open_count: opened ? 1 : 0, paid_at: null, paid_amount: 0, created_at: nowUtc(), source_ref: 'invoy', business_id: info.business_id, tax_mode: 'exclude', incomplete: 0,
      // 明細はinvoyにあるので、件名と税込の請求額で1行にする
      items: [{ id: base, name: (r.title || '請求金額') + '（税込・明細はinvoy）', qty: 1, unit: '式', price: r.total, tax_rate: 0, amount: r.total, product_id: null, item_date: '', ship_to: '' }],
      payments: [], events: [] };
    if (status === 'paid') {
      inv.payments.push({ id: base + 1, paid_date: due, amount: r.total, payer: 'invoyで入金済み（入金日は支払期限の日）', source: 'invoy', created_at: nowUtc() });
      inv.paid_amount = r.total; inv.paid_at = due;
    }
    store.logEvent(inv, 'create', 'invoyから取り込み（invoyのステータス：' + r.status + '）');
    await store.saveInvoice(inv);
    n.invoices++;
  }
  if (n.clients) await store.saveSetting('invoy_client_map', JSON.stringify(map));
  return n;
}

export function invoyPage() {
  if (!work.rows) {
    const y0 = Number(today().slice(0, 4));
    const years = []; for (let y = y0 + 1; y >= 2024; y--) years.push(y);
    return {
      title: 'invoyから取り込む', active: 'list',
      html: `
<p class="crumb"><a href="#list">請求書</a> ›</p>
<h1>invoyから取り込む</h1>
<form class="card form narrow-wide" id="invoyForm">
  <p>invoyの「請求書CSV」（Shift_JISのままでOK）を選んでください。明細はCSVに入っていないので、件名と請求額（税込）で1行の請求書として取り込みます。ステータスはinvoyのまま（請求済・送付済→送付済み、開封済・閲覧済→開封済み、入金済→入金済み、下書き→下書き）です。取り込んだあとも、一覧や請求書の画面でステータスを手で変えられます。</p>
  <label>取り込む年度<select name="fy">${years.map((y) => `<option value="${y}"${y === 2026 ? ' selected' : ''}>${y}年度（${y}年4月〜${y + 1}年3月に発行）</option>`).join('')}</select></label>
  <input type="file" name="csv" accept=".csv,text/csv" required>
  <div class="actions"><button class="btn primary">読み込む</button></div>
</form>`,
      mount(root) {
        root.querySelector('#invoyForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const f = e.target, file = f.csv.files[0];
          if (!file) { showFlash('CSVファイルを選んでください。', 'err'); return; }
          try {
            const rows = parse(decodeBytes(await file.arrayBuffer()));
            const fy = Number(f.fy.value) || 2026;
            Object.assign(work, { rows, from: fy + '-04-01', to: (fy + 1) + '-03-31' });
            go('invoy');
          } catch (err) { showFlash(err.message, 'err'); }
        });
      },
    };
  }

  const pl = plan(work.rows);
  const clients = [...store.db.clients].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const cn = (id) => (store.client(id) || {}).name;
  const cnt = {}; for (const r of pl.rows) cnt[r.status] = (cnt[r.status] || 0) + 1;
  const newNames = [...pl.names].filter(([, n]) => !n.client_id).map(([k]) => k);
  const sum = pl.rows.reduce((a, r) => a + r.total, 0);
  const lbl = { exact: '一致', partial: '名前の一部が一致', guess: '似ている名前（要確認）', manual: '手で設定', none: '新しい取引先として作ります' };
  const jd = (d) => { const [y, m, dd] = d.split('-').map(Number); return `${y}/${m}/${dd}`; };

  return {
    title: 'invoyから取り込む', active: 'list',
    html: `
<p class="crumb"><a href="#list">請求書</a> ›</p>
<h1>invoyから取り込む</h1>
<div class="head-row">
  <p class="muted">${jd(work.from)}〜${jd(work.to)}に発行した ${pl.rows.length}件（${Object.entries(cnt).map(([k, v]) => h(k) + ' ' + v + '件').join('　')}）合計 ${yen(sum)}</p>
  <button class="btn small" id="invoyReset">別のCSVを選ぶ</button>
</div>

<form class="card" id="invoyMap">
  <b>請求先の対応</b> <span class="muted small">invoyの請求先 → このアプリの取引先</span>
  <div class="table-wrap mt">
  <table class="list small map">
    <thead><tr><th>invoyの請求先</th><th class="r">件数</th><th class="r">合計</th><th>取引先</th><th>判定</th><th>事業</th></tr></thead>
    ${[...pl.names].map(([name, n]) => `
      <tr class="${n.how === 'guess' || n.how === 'none' ? 'need' : ''}">
        <td>${h(name)}</td><td class="r">${n.count}</td><td class="r">${nf(n.sum)}</td>
        <td><select data-map="${h(name)}">
          <option value="">${n.client_id && n.how !== 'manual' ? '自動：' + h(cn(n.client_id) || '') : (n.client_id ? '' : '（新しく作る）')}</option>
          <option value="new"${n.how === 'manual' && !n.client_id ? ' selected' : ''}>新しい取引先として作る</option>
          ${clients.map((c) => `<option value="${c.id}"${n.how === 'manual' && n.client_id === c.id ? ' selected' : ''}>${h(c.name)}</option>`).join('')}
        </select></td>
        <td class="small">${h(lbl[n.how] || '')}</td>
        <td><select data-biz-of="${h(name)}">${store.businesses().map((b) => `<option value="${b.id}"${n.business_id === b.id ? ' selected' : ''}>${h(b.name)}</option>`).join('')}</select></td>
      </tr>`).join('')}
  </table>
  </div>
  <div class="btn-row"><button class="btn small">対応を保存</button></div>
</form>

<div class="table-wrap">
<table class="list small">
  <thead><tr><th>番号</th><th>発行日</th><th>請求先</th><th>件名</th><th class="r">請求額</th><th>invoy</th><th>期限</th><th></th></tr></thead>
  ${pl.rows.map((r) => `
    <tr class="${r.exists ? 'done' : ''}" style="cursor:default${r.exists ? ';opacity:.5' : ''}">
      <td class="mono">${h(r.number)}</td><td>${h(slashDate(r.issue))}</td>
      <td>${h(cn(pl.names.get(r.to).client_id) || r.to)}</td>
      <td>${h(r.title)}</td><td class="r">${nf(r.total)}</td>
      <td>${h(r.status)}</td><td>${h(r.due)}</td>
      <td class="small muted">${r.exists ? '取込済み' : ''}</td>
    </tr>`).join('')}
</table>
</div>
<div class="actions sticky-actions">
  ${newNames.length ? `<span class="muted small">新しく作る取引先：${h(newNames.join('、'))}</span>` : ''}
  <button class="btn primary" id="invoyGo">この内容で取り込む</button>
</div>`,
    mount(root) {
      root.querySelector('#invoyReset').addEventListener('click', () => { work.rows = null; go('invoy'); });
      root.querySelector('#invoyMap').addEventListener('submit', async (e) => {
        e.preventDefault();
        const bmap = json('invoy_biz_map'), map = json('invoy_client_map');
        root.querySelectorAll('select[data-biz-of]').forEach((s) => { bmap[s.dataset.bizOf] = Number(s.value); });
        root.querySelectorAll('select[data-map]').forEach((s) => { const k = s.dataset.map, v = s.value; if (v === '') delete map[k]; else map[k] = v === 'new' ? 'new' : Number(v); });
        await store.saveSettings({ invoy_biz_map: JSON.stringify(bmap), invoy_client_map: JSON.stringify(map) });
        flash('請求先の対応を保存しました。'); go('invoy');
      });
      root.querySelector('#invoyGo').addEventListener('click', async (e) => {
        e.target.disabled = true;
        const r = await doImport(plan(work.rows));
        work.rows = null;
        flash(`invoyから${r.invoices}件の請求書を取り込みました。` + (r.clients ? `取引先を${r.clients}件新しく作りました。` : '') + (r.skipped ? `（同じ番号がある${r.skipped}件は飛ばしました）` : ''));
        setBiz(1); go('list');
      });
    },
  };
}
