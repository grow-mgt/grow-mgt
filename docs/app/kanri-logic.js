// 卸先別の年間管理表（シービーエムからの仕入れを、卸先×月で並べる）。今までのスプレッドシート「卸先別_年間管理表」と同じ形
//  - 明細（控え）のある月：明細の 数量×単価 を卸先ごとに足す（自動）
//  - 明細のない月：手で入れた金額（スプレッドシートから貼り付けて取り込める）
import { store } from './store.js';
import { normName, similarPct, storeMap, productAlias, matchStore, matchProduct } from './cbm-logic.js';

export const DEFAULT_GROUP = 'その他グループ薬局';
const json = (key, fb) => { try { const v = JSON.parse(store.setting(key) || ''); return v == null ? fb : v; } catch (e) { return fb; } };
export const kanriRows = () => { const a = json('kanri_rows', []); return Array.isArray(a) ? a.filter((r) => r && r.name) : []; };
export const kanriAlias = () => json('kanri_alias', {});
export const kanriManual = () => json('kanri_manual', {});

const pad = (n) => String(n).padStart(2, '0');
export const tabYm = (tab) => { const m = /(\d{4})年(\d{1,2})月/u.exec(tab); return m ? `${m[1]}-${pad(m[2])}` : ''; };
export const ymLabel = (ym) => `${Number(ym.slice(0, 4))}年${Number(ym.slice(5))}月`;
export const fyMonths = (fy) => [...Array(12).keys()].map((i) => { const mo = 3 + i; return `${fy + Math.floor(mo / 12)}-${pad((mo % 12) + 1)}`; });
export const inTax = (v) => Math.round(v * 1.1);
// 名前を比べるときのそろえ方（空白・かっこ・長音の書き方のちがいを無視する）
const nk = (s) => normName(String(s).replace(/[（(].*?[）)]/gu, '')).replace(/[ー―ｰ]/gu, '');

/** 明細の卸先名 → 管理表の行の名前。[名前 | null, 判定]（判定：alias＝対応表, exact, same＝書き方ちがい, part＝一部一致, guess＝似ている, none） */
export function canonOf(storeName, rows, alias) {
  if (alias[storeName]) return [alias[storeName], 'alias'];
  if (rows.some((r) => r.name === storeName)) return [storeName, 'exact'];
  const n = nk(storeName);
  const same = rows.filter((r) => nk(r.name) === n);
  if (same.length === 1) return [same[0].name, 'same'];
  const part = rows.filter((r) => { const rn = nk(r.name); return n !== '' && rn !== '' && (rn.includes(n) || n.includes(rn)); });
  if (part.length === 1) return [part[0].name, 'part'];
  let best = null, bestPct = 0, second = 0;
  for (const r of rows) { const p = similarPct(n, nk(r.name)); if (p > bestPct) { second = bestPct; bestPct = p; best = r.name; } else if (p > second) second = p; }
  if (best && bestPct >= 85 && bestPct - second >= 8) return [best, 'guess'];
  return [null, 'none'];
}

/** その年度の管理表を組み立てる */
export function buildKanri(fy) {
  const months = fyMonths(fy), inFy = new Set(months);
  const rows = kanriRows().map((r) => ({ name: r.name, group: r.group || DEFAULT_GROUP }));
  const alias = kanriAlias(), manual = kanriManual();
  const auto = {};            // ym → { 行の名前: 金額 }
  const names = new Map();    // 明細の卸先名 → { to, how }
  for (const l of store.db.cbmLines) {
    const ym = tabYm(l.tab); if (!ym) continue;
    if (!names.has(l.store)) { const [to, how] = canonOf(l.store, rows, alias); names.set(l.store, { to, how, inFy: false }); }
    const info = names.get(l.store);
    if (!inFy.has(ym)) continue;
    info.inFy = true;
    const key = info.to || l.store;
    (auto[ym] = auto[ym] || {})[key] = ((auto[ym] || {})[key] || 0) + Math.round(Number(l.qty) * (Number(l.cost) || 0));
  }
  // 対応する行のない卸先は、新しい行として下に足して見せる
  const extra = [...names.entries()].filter(([, v]) => v.inFy && !v.to).map(([name]) => name);
  const noRows = !rows.length; // まだ行を決めていないとき（最初）は、明細の卸先名をそのまま行にする
  for (const name of extra) if (!rows.some((r) => r.name === name)) rows.push({ name, group: DEFAULT_GROUP, isNew: !noRows });
  const autoMonths = new Set(Object.keys(auto));
  const val = (name, ym) => (autoMonths.has(ym) ? (auto[ym][name] || 0) : Number((manual[ym] || {})[name] || 0));
  const groups = [];
  for (const r of rows) { let g = groups.find((x) => x.name === r.group); if (!g) groups.push(g = { name: r.group, rows: [] }); g.rows.push({ ...r, vals: months.map((ym) => val(r.name, ym)) }); }
  const sumCols = (list) => months.map((_, i) => list.reduce((a, r) => a + r.vals[i], 0));
  const sumTax = (list) => months.map((_, i) => list.reduce((a, r) => a + inTax(r.vals[i]), 0));
  for (const g of groups) { g.sub = sumCols(g.rows); g.subTax = sumTax(g.rows); }
  const all = groups.flatMap((g) => g.rows);
  const pending = noRows ? [] : [...names.entries()].filter(([, v]) => v.inFy && (v.how === 'none' || v.how === 'guess')).map(([name, v]) => ({ name, to: v.to, how: v.how }));
  return { fy, months, groups, autoMonths, noRows, total: sumCols(all), totalTax: sumTax(all), pending, rowNames: kanriRows().map((r) => r.name) };
}

/** 書き出す表（スプレッドシートの年間管理表と同じ並び） */
export function kanriTable(k) {
  const s = (a) => a.reduce((x, y) => x + y, 0);
  const pair = (vals, taxes) => vals.flatMap((v, i) => [v, taxes[i]]);
  const out = [['卸先グループ', '卸先名', ...k.months.flatMap((ym) => [ymLabel(ym) + ' 税抜', ymLabel(ym) + ' 税込']), '年間合計 税抜', '年間合計 税込']];
  for (const g of k.groups) {
    for (const r of g.rows) { const t = r.vals.map(inTax); out.push([g.name, r.name, ...pair(r.vals, t), s(r.vals), s(t)]); }
    out.push([g.name + ' 小計', '', ...pair(g.sub, g.subTax), s(g.sub), s(g.subTax)]);
  }
  out.push(['総合計', '', ...pair(k.total, k.totalTax), s(k.total), s(k.totalTax)]);
  return out;
}

/** その月の明細の表（スプレッドシートの「◯月_明細」と同じ並び） */
export function linesTable(tab) {
  const out = [['卸先名', 'ご注文日', '摘要', '数量', '単価', '金額(税抜)']];
  for (const l of store.db.cbmLines.filter((x) => x.tab === tab).sort((a, b) => (a.sort - b.sort) || (a.id - b.id))) {
    out.push([l.store, l.date || '', l.name, Number(l.qty), l.cost == null ? '' : Number(l.cost), Math.round(Number(l.qty) * (Number(l.cost) || 0))]);
  }
  return out;
}

/** スプレッドシートの「年間管理表」を貼り付けた文字から、行（卸先・グループ）と月ごとの税抜金額を読む */
export function parseAnnual(text) {
  const rows = String(text).replace(/\r\n?/g, '\n').split('\n').map((l) => l.split('\t').map((c) => c.trim()));
  const hi = rows.findIndex((r) => r.includes('卸先名'));
  if (hi < 0) throw new Error('「卸先名」の見出しが見つかりません。年間管理表を、見出しの行も含めてコピーしてください。');
  const head = rows[hi], nameCol = head.indexOf('卸先名'), groupCol = head.indexOf('卸先グループ');
  const cols = [];
  head.forEach((c, i) => { const m = /^(\d{4})年(\d{1,2})月$/u.exec(c); if (m) cols.push([i, `${m[1]}-${pad(m[2])}`]); });
  if (!cols.length) throw new Error('「2026年4月」のような月の見出しが見つかりません。');
  const outRows = [], manual = {};
  for (const r of rows.slice(hi + 1)) {
    const name = r[nameCol] || '', group = groupCol >= 0 ? (r[groupCol] || '') : '';
    if (name === '' || name === '税抜' || /(小計|合計)/u.test(group) || /(小計|合計)/u.test(name)) continue;
    outRows.push({ name, group: group || DEFAULT_GROUP });
    for (const [i, ym] of cols) {
      const raw = String(r[i] ?? '').replace(/[,¥￥円\s]/g, '');
      if (raw === '' || !/^-?\d+(\.\d+)?$/.test(raw)) continue;
      (manual[ym] = manual[ym] || {})[name] = Math.round(Number(raw));
    }
  }
  if (!outRows.length) throw new Error('卸先の行がありませんでした。');
  return { rows: outRows, manual };
}

/** 貼り付けて読んだ内容を保存する（今ある行はそのまま、新しい卸先は下に足す。金額は読んだ月だけ置き換える） */
export async function importAnnual(parsed) {
  const rows = kanriRows();
  let added = 0;
  for (const r of parsed.rows) {
    const cur = rows.find((x) => x.name === r.name);
    if (cur) cur.group = r.group; else { rows.push({ name: r.name, group: r.group }); added++; }
  }
  const manual = kanriManual();
  for (const [ym, vals] of Object.entries(parsed.manual)) manual[ym] = { ...(manual[ym] || {}), ...vals };
  await store.saveSettings({ kanri_rows: JSON.stringify(rows), kanri_manual: JSON.stringify(manual) });
  return { rows: parsed.rows.length, added, months: Object.keys(parsed.manual).length };
}

export async function setManual(ym, name, amount) {
  const manual = kanriManual();
  manual[ym] = manual[ym] || {};
  if (amount) manual[ym][name] = amount; else delete manual[ym][name];
  await store.saveSetting('kanri_manual', JSON.stringify(manual));
}

/** 明細の卸先名を、管理表のどの行に入れるかを決める（to が今ない名前なら、新しい行として足す） */
export async function setAlias(storeName, to, group) {
  const alias = kanriAlias(), rows = kanriRows();
  if (!rows.some((r) => r.name === to)) rows.push({ name: to, group: group || DEFAULT_GROUP });
  if (to === storeName) delete alias[storeName]; else alias[storeName] = to;
  await store.saveSettings({ kanri_rows: JSON.stringify(rows), kanri_alias: JSON.stringify(alias) });
}

/* ---------- 請求書を手で直したとき：控えの明細（＝管理表）にも同じ変更を入れる ---------- */
const isLineItem = (it) => !!it.product_id || !!it.item_date; // 月額固定などの行（商品なし・取引日なし）は明細ではない
const itemKey = (it) => [it.product_id || 'n:' + it.name, it.item_date || '', it.ship_to || '', Number(it.qty)].join('|');

/**
 * シービーエムの明細から作った請求書を手で直したら、控えの明細にも反映する。
 * 戻り値：null（対象外）か { changed, removed, added, missed }
 */
export async function syncLinesFromInvoice(oldItems, inv) {
  const m = /^cbm:(.+):(\d+)$/.exec(String(inv.source_ref || ''));
  if (!m) return null;
  const tab = m[1];
  const lines = store.db.cbmLines.filter((l) => l.tab === tab).sort((a, b) => (a.sort - b.sort) || (a.id - b.id)).map((l) => ({ ...l }));
  if (!lines.length) return null;
  const map = storeMap(), alias = productAlias(), products = store.db.products;
  const mine = lines.filter((l) => matchStore(l.store, map)[0] === inv.client_id);
  const pidOf = (l) => matchProduct(l.name, alias, products)[0];

  // 前と後で、なくなった行・増えた行を出す（同じ内容の行は相殺する）
  const olds = (oldItems || []).filter(isLineItem), news = (inv.items || []).filter(isLineItem);
  const count = new Map();
  for (const it of news) count.set(itemKey(it), (count.get(itemKey(it)) || 0) + 1);
  const removed = [];
  for (const it of olds) { const k = itemKey(it); if (count.get(k)) count.set(k, count.get(k) - 1); else removed.push(it); }
  const count2 = new Map();
  for (const it of olds) count2.set(itemKey(it), (count2.get(itemKey(it)) || 0) + 1);
  const added = [];
  for (const it of news) { const k = itemKey(it); if (count2.get(k)) count2.set(k, count2.get(k) - 1); else added.push(it); }
  if (!removed.length && !added.length) return { changed: 0, removed: 0, added: 0, missed: 0 };

  const used = new Set();
  const findLine = (it) => mine.find((l) => !used.has(l) && !l._gone
    && (it.product_id ? pidOf(l) === it.product_id : l.name === it.name)
    && (l.date || '') === (it.item_date || '') && Number(l.qty) === Number(it.qty)
    && (!it.ship_to || l.store === it.ship_to));
  const res = { changed: 0, removed: 0, added: 0, missed: 0 };
  const sameProd = (a, b) => (a.product_id || 'n:' + a.name) === (b.product_id || 'n:' + b.name);
  for (const r of removed) {
    const line = findLine(r);
    // 相手（直したあとの行）を探す：同じ商品・同じ納品先 → 数量や日付の変更／同じ日付・数量・納品先 → 商品の変更
    let ai = added.findIndex((a) => sameProd(a, r) && (a.ship_to || '') === (r.ship_to || ''));
    if (ai < 0) ai = added.findIndex((a) => (a.item_date || '') === (r.item_date || '') && Number(a.qty) === Number(r.qty) && (a.ship_to || '') === (r.ship_to || ''));
    const a = ai >= 0 ? added.splice(ai, 1)[0] : null;
    if (!line) { res.missed++; continue; }
    used.add(line);
    if (!a) { line._gone = true; res.removed++; continue; }
    line.qty = Number(a.qty); line.date = a.item_date || '';
    if (!sameProd(a, r)) {
      const p = a.product_id ? store.product(a.product_id) : null;
      line.name = p ? p.name : a.name;
      if (p && p.cost != null) line.cost = Number(p.cost);
    }
    if (a.ship_to && a.ship_to !== line.store) line.store = a.ship_to;
    res.changed++;
  }
  // 手で足した行（商品を選んだもの）は、明細にも足す。原価は商品の原価
  const stores = [...new Set(mine.map((l) => l.store))];
  for (const a of added) {
    if (!a.product_id) continue;
    const p = store.product(a.product_id);
    const client = store.client(inv.client_id);
    lines.push({ store: a.ship_to || stores[0] || (client ? client.name : ''), date: a.item_date || '', name: p ? p.name : a.name, qty: Number(a.qty), cost: p && p.cost != null ? Number(p.cost) : null });
    res.added++;
  }
  if (res.changed || res.removed || res.added) {
    await store.saveCbmLines(tab, lines.filter((l) => !l._gone).map((l) => ({ store: l.store, date: l.date, name: l.name, qty: l.qty, cost: l.cost })));
  }
  return res;
}
