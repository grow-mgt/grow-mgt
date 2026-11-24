// シービーエムの明細 → 請求書の下書き（今までの cbm_sync.php / source_sync.php の照合と同じ結果になるように移したもの）
import { store } from './store.js';
import { calcInvoice, nextNumber, priceInfo } from './logic.js';
import { today, nowUtc, endOfNextMonth, randomToken, toIntOrNull } from './util.js';

/* ---------- 文字のそろえ方 ---------- */
// 全角の英数字・記号・空白を半角に
const toHalfAscii = (s) => s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');
// 半角カナを全角カナに（濁点もまとめる）
const kanaToFull = (s) => s.replace(/[｡-ﾟ]+/g, (m) => m.normalize('NFKC'));
// カタカナをひらがなに
const kataToHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

export function normName(s) {
  s = kataToHira(kanaToFull(toHalfAscii(String(s)))).toLowerCase();
  s = s.replace(/[/／].*$/u, ''); // 「〇〇薬局/△△」の「/△△」など
  return s.replace(/[\s　・.\-－‐()（）]/gu, '');
}
export function normProduct(s) {
  return kanaToFull(toHalfAscii(String(s))).toLowerCase().replace(/[\s　]/gu, '');
}
export function productCode(s) {
  const m = /([A-Z0-9]{2,}-[A-Z0-9][A-Z0-9-]*)/.exec(toHalfAscii(String(s)).toUpperCase());
  return m ? m[1] : '';
}
// 「〇〇薬局様」「△△薬局様（〇〇薬局）」→ 様を外す
export function stripSama(s) {
  return String(s).trim().replace(/様(?=[（(])/gu, '').replace(/様$/u, '');
}

// 2つの名前がどのくらい似ているか（％）。今までと同じ数え方（文字コードの並びで比べる）
const enc = new TextEncoder();
function simCount(a, b) {
  if (!a.length || !b.length) return 0;
  let max = 0, pa = 0, pb = 0;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    let k = 0;
    while (i + k < a.length && j + k < b.length && a[i + k] === b[j + k]) k++;
    if (k > max) { max = k; pa = i; pb = j; }
  }
  if (!max) return 0;
  return max + simCount(a.subarray(0, pa), b.subarray(0, pb)) + simCount(a.subarray(pa + max), b.subarray(pb + max));
}
export function similarPct(s1, s2) {
  const a = enc.encode(s1), b = enc.encode(s2);
  if (a.length + b.length === 0) return 0;
  return simCount(a, b) * 2 * 100 / (a.length + b.length);
}

/* ---------- 対応表 ---------- */
const json = (key) => { try { return JSON.parse(store.setting(key) || '{}') || {}; } catch (e) { return {}; } };
export const storeMap = () => json('cbm_store_map');
export const productAlias = () => json('cbm_product_alias');
const isIntLike = (v) => typeof v === 'number' || /^\d+$/.test(String(v));
const clientIdByName = (name) => { const c = store.db.clients.find((x) => x.name === name); return c ? c.id : null; };

// 名前から取引先を探す：同じ名前 → 片方がもう片方を含む（1件だけ）→ よく似ている（要確認）
function matchClient(name) {
  const n = normName(name);
  const list = store.db.clients;
  for (const c of list) if (normName(c.name) === n) return [c.id, 'exact'];
  const hits = list.filter((c) => { const cn = normName(c.name); return n !== '' && (cn.includes(n) || n.includes(cn)); });
  if (hits.length === 1) return [hits[0].id, 'partial'];
  let best = null, bestPct = 0, second = 0;
  for (const c of list) {
    const pct = similarPct(n, normName(c.name));
    if (pct > bestPct) { second = bestPct; bestPct = pct; best = c.id; } else if (pct > second) second = pct;
  }
  if (best !== null && bestPct >= 80 && bestPct - second >= 8) return [best, 'guess'];
  return [null, 'none'];
}

/** 卸先 → [取引先のid | 'skip' | null, 判定] */
export function matchStore(storeName, map) {
  if (Object.prototype.hasOwnProperty.call(map, storeName)) {
    const v = map[storeName];
    if (v === 'skip') return ['skip', 'manual'];
    const r = isIntLike(v) ? (store.client(Number(v)) ? Number(v) : null) : clientIdByName(String(v).replace(/^name:/, ''));
    if (r) return [r, 'map'];
    // 対応表に名前がある（取引先が見つからない）場合は、似た名前への自動照合をしない（別の店を誤って結び付けないため）
    return [null, 'none'];
  }
  return matchClient(storeName);
}

/** 品名 → [商品のid | null, 判定] */
export function matchProduct(name, alias, products) {
  const byName = new Map(products.map((p) => [p.name, p.id]));
  if (alias[name] && byName.has(alias[name])) return [byName.get(alias[name]), 'alias'];
  if (byName.has(name)) return [byName.get(name), 'exact'];
  const n = normProduct(name);
  for (const p of products) if (normProduct(p.name) === n) return [p.id, 'exact'];
  const code = productCode(name);
  if (code !== '') {
    const hits = products.filter((p) => productCode(p.name) === code);
    if (hits.length === 1) return [hits[0].id, 'code'];
  }
  return [null, 'none'];
}

/* ---------- 明細を読む ---------- */
function splitRows(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const tsv = lines.some((l) => l.includes('\t'));
  return lines.map((l) => {
    if (tsv) return l.split('\t');
    const out = []; let cur = '', q = false; // CSV（"…" で囲んだカンマに対応）
    for (let i = 0; i < l.length; i++) {
      const ch = l[i];
      if (q) { if (ch === '"') { if (l[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
      else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur); return out;
  });
}
const normDate = (s) => { const m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : s; };

/** 管理表の明細（貼り付けた文字）を行にする：[{store, date, name, qty, cost}] */
export function parseLines(text) {
  const rows = splitRows(text);
  const hi = rows.findIndex((r) => r.map((c) => c.trim()).includes('卸先名'));
  if (hi < 0) throw new Error('「卸先名」の見出しが見つかりません。管理表の明細を、見出しの行も含めてコピーしてください。');
  const head = rows[hi].map((c) => c.trim());
  const col = (names) => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return null; };
  const c = { store: col(['卸先名']), date: col(['取引日', 'ご注文日', '注文日', '納品日']), name: col(['摘要', '品名', '商品名']), qty: col(['数量']), cost: col(['単価']) };
  if (c.name === null || c.qty === null) throw new Error('「摘要」「数量」の見出しが見つかりません。');
  const out = [];
  for (const row of rows.slice(hi + 1)) {
    const st = String(row[c.store] ?? '').trim(), name = String(row[c.name] ?? '').trim();
    if (st === '' || name === '' || /(小計|合計)/u.test(st)) continue;
    const qty = parseFloat(toHalfAscii(String(row[c.qty] ?? '')).replace(/,/g, '')) || 0;
    if (qty <= 0) continue;
    out.push({ store: stripSama(st), date: c.date !== null ? normDate(String(row[c.date] ?? '').trim()) : '', name, qty, cost: c.cost !== null ? toIntOrNull(row[c.cost]) : null });
  }
  if (!out.length) throw new Error('明細の行がありませんでした。');
  return out;
}

/* ---------- 控え ---------- */
const tabKey = (t) => { const m = /(\d{4})年(\d{1,2})月/u.exec(t); return m ? Number(m[1]) * 100 + Number(m[2]) : 0; };
// 控えのある月（古い順）
export const storedTabs = () => [...new Set(store.db.cbmLines.map((l) => l.tab))].sort((a, b) => tabKey(a) - tabKey(b));
export function storedLines(tab) {
  return store.db.cbmLines.filter((l) => l.tab === tab).sort((a, b) => (a.sort - b.sort) || (a.id - b.id))
    .map((r) => ({ store: r.store, date: r.date || '', name: r.name, qty: Number(r.qty), cost: r.cost == null ? null : Number(r.cost) }));
}

/** 品名の対応表にない商品を足す（原価はシービーエムの単価）。足した数を返す */
export async function prepareProducts(lines) {
  const alias = productAlias();
  let added = 0; const seen = new Set();
  for (const l of lines) {
    if (seen.has(l.name)) continue; seen.add(l.name);
    const [pid] = matchProduct(l.name, alias, store.db.products);
    if (pid || store.db.products.some((p) => p.name === l.name)) continue;
    await store.saveProduct({ id: store.newId() + added, name: l.name, unit: '個', price: null, cost: l.cost, tax_rate: 10, active: 1, created_at: nowUtc(), maker: '', pack_size: null, source: 'cbm' });
    added++;
  }
  return added;
}

/** 取引先に登録されていない卸先は、取引先を作って店名の対応表に入れる（価格はまだ未設定）。作った数を返す */
export async function ensureClients(lines) {
  const map = storeMap();
  let made = 0, changed = false; const seen = new Set();
  for (const l of lines) {
    const st = l.store;
    if (seen.has(st)) continue; seen.add(st);
    const [cid] = matchStore(st, map);
    if (cid) continue; // 'skip' もここで抜ける
    // 対応表に名前がある場合はその名前、なければ卸先名で取引先を作る
    const mv = map[st];
    const name = (typeof mv === 'string' && mv !== '') ? mv.replace(/^name:/, '') : st;
    if (!clientIdByName(name)) {
      await store.saveClient({ id: store.newId() + made, name, honorific: '御中', contact: '', email: '', cc: '', postal: '', address: '', payer_kana: '', memo: '', created_at: nowUtc(),
        group_name: '', corp_name: '', representative: '', billing_method: '', sheet_note: '', source: 'app', price_rule: '', price_rule_amount: 0, business_id: 1 });
      made++;
    }
    if (map[st] !== name) { map[st] = name; changed = true; }
  }
  if (changed) await store.saveSetting('cbm_store_map', JSON.stringify(map));
  return made;
}

/** 請求先ごとにまとめた下書きの案 */
export function plan(lines, overrides = {}) {
  const alias = productAlias(), map = storeMap();
  const products = store.db.products;
  const out = { invoices: new Map(), stores: new Map(), items: new Map() };
  lines.forEach((l, i) => {
    if (!out.stores.has(l.store)) { const [cid, how] = matchStore(l.store, map); out.stores.set(l.store, { client_id: cid, how, lines: 0 }); }
    out.stores.get(l.store).lines++;
    if (!out.items.has(l.name)) { const [pid, how] = matchProduct(l.name, alias, products); out.items.set(l.name, { product_id: pid, how, cost: l.cost }); }
    const cid = out.stores.get(l.store).client_id;
    if (!cid || cid === 'skip') return;
    const pid = out.items.get(l.name).product_id;
    const client = store.client(cid);
    let info;
    if (client.price_rule === 'cost_all' && l.cost != null) info = { price: Number(l.cost), from: '原価（明細の単価）' };
    else info = pid ? priceInfo(cid, pid) : { price: null, from: '' };
    const key = 'r' + i;
    const over = Object.prototype.hasOwnProperty.call(overrides, key);
    if (!out.invoices.has(cid)) out.invoices.set(cid, { client_id: cid, client_name: client.name, lines: [], stores: new Set() });
    const inv = out.invoices.get(cid);
    inv.stores.add(l.store);
    inv.lines.push({ key, store: l.store, date: l.date, raw: l.name, qty: l.qty, cbm_cost: l.cost, product_id: pid, product_name: pid ? store.product(pid).name : '',
      price: over ? overrides[key] : info.price, from: over ? '手入力' : info.from });
  });
  for (const inv of out.invoices.values()) {
    inv.show_ship = inv.stores.size > 1; // 納品先が2店以上あるときだけ、納品先を明細に出す
    let sum = 0, cost = 0, missing = 0;
    for (const l of inv.lines) {
      if (l.price == null) { missing++; continue; }
      sum += Math.round(l.qty * l.price); cost += Math.round(l.qty * (l.cbm_cost || 0));
    }
    inv.subtotal = sum; inv.cost = cost; inv.missing = missing;
  }
  return out;
}

export const refOf = (tab, cid) => 'cbm:' + tab + ':' + cid;

/** 下書きを作る。戻り値：作った請求書のidの配列 */
export async function create(tab, pl, opt) {
  const created = [];
  for (const [cid, inv] of pl.invoices) {
    if (!opt.clients.includes(cid)) continue;
    const ref = refOf(tab, cid);
    const existing = store.db.invoices.find((v) => v.source_ref === ref);
    if (existing && !opt.again) continue;
    const items = [];
    for (const l of inv.lines) {
      let tax = 10, unit = '個';
      const pr = l.product_id ? store.product(l.product_id) : null;
      if (pr) { tax = Number(pr.tax_rate); unit = pr.unit ? pr.unit : '個'; }
      items.push({ name: l.product_name || l.raw, qty: l.qty, unit, price: Math.trunc(l.price || 0), tax_rate: tax, product_id: l.product_id, item_date: l.date, ship_to: inv.show_ship ? l.store : '' });
      if (opt.remember && l.from === '手入力' && l.product_id && l.price != null) await store.setClientPrice(cid, l.product_id, Math.trunc(l.price));
    }
    // 月額固定（コンサルティングフィーなど）を「その他」に足す
    if (opt.recurring) {
      for (const r of store.db.recurring.filter((x) => x.client_id === cid).sort((a, b) => (a.sort - b.sort) || (a.id - b.id))) {
        items.push({ name: r.name, qty: Number(r.qty), unit: r.unit ? r.unit : '式', price: Number(r.price), tax_rate: Number(r.tax_rate), product_id: null, item_date: '', ship_to: '' });
      }
    }
    const calc = calcInvoice(items, false);
    const incomplete = inv.missing > 0 ? 1 : 0; // 価格が未設定の行があれば、未完成の下書きにする（価格は0のまま入る）
    const base = store.newId();
    const withIds = items.map((it, i) => ({ id: base + i, ...it, amount: Math.round(it.qty * it.price) }));
    let target;
    if (existing) {
      target = Object.assign(existing, { client_id: cid, subtotal: calc.subtotal, tax: calc.tax, total: calc.total, incomplete, items: withIds });
    } else {
      target = { id: base + 900, number: nextNumber(opt.issue), client_id: cid, title: opt.title, issue_date: opt.issue, due_date: opt.due, notes: opt.notes, withholding: 0,
        subtotal: calc.subtotal, tax: calc.tax, withholding_amount: 0, total: calc.total, token: randomToken(), status: 'draft', sent_at: null, opened_at: null, open_count: 0,
        paid_at: null, paid_amount: 0, created_at: nowUtc(), source_ref: ref, business_id: 1, tax_mode: 'exclude', incomplete, items: withIds, payments: [], events: [] };
    }
    store.logEvent(target, existing ? 'edit' : 'create', (existing ? '「' + tab + '」から作り直し' : '「' + tab + '」から下書きを作成') + (incomplete ? '（価格未設定あり・未完成）' : ''));
    await store.saveInvoice(target);
    created.push(target.id);
  }
  return created;
}

export function monthLabel(tab) {
  const m = /(\d{4})年(\d{1,2})月/u.exec(tab);
  return m ? '令和' + (Number(m[1]) - 2018) + '年' + m[2] + '月分' : '';
}

// 作り直しの対象：未完成の下書きがある取引先（redo）と、まだ下書きのない取引先（fresh）
function rebuildTargets(tab, pl) {
  const drafts = new Map();
  for (const v of store.db.invoices) if (String(v.source_ref || '').startsWith('cbm:' + tab + ':')) drafts.set(v.client_id, v);
  const redo = [], fresh = [];
  for (const cid of pl.invoices.keys()) { const d = drafts.get(cid); if (!d) fresh.push(cid); else if (d.status === 'draft' && d.incomplete === 1) redo.push(cid); }
  return { drafts, redo, fresh };
}
/** 作り直すと何件になるかを、先に数える（何も変えない） */
export function rebuildPreview(tab) {
  const lines = storedLines(tab);
  if (!lines.length) return { redo: 0, fresh: 0, unknownStores: 0 };
  const pl = plan(lines, {});
  const t = rebuildTargets(tab, pl);
  return { redo: t.redo.length, fresh: t.fresh.length, unknownStores: [...pl.stores.values()].filter((x) => !x.client_id).length };
}

/** 控えの明細から、未完成の下書き（価格未設定）と、まだ無い取引先の下書きを作り直す */
export async function rebuild(tab) {
  const lines = storedLines(tab);
  if (!lines.length) return { ids: [], msg: '控えの明細がありません。明細を読み込み直してください。' };
  await ensureClients(lines);
  const pl = plan(lines, {});
  const { drafts, redo, fresh } = rebuildTargets(tab, pl);
  const targets = redo.concat(fresh);
  if (!targets.length) return { ids: [], msg: '作り直すものはありません（未完成の下書きも、新しい取引先もありません）。' };
  const base = drafts.size ? drafts.values().next().value : null;
  const ml = monthLabel(tab);
  const td = today();
  const ids = await create(tab, pl, { clients: targets, again: true, recurring: true, remember: false,
    title: base ? base.title : ('薬局消耗品 ' + ml), issue: base ? base.issue_date : td, due: base ? base.due_date : endOfNextMonth(td), notes: base ? base.notes : '' });
  return { ids, msg: ids.length + '件の下書きを作り直しました。' };
}
