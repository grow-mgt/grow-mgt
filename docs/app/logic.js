// 計算とルール（今までのアプリの lib.php と同じ結果になるように移したもの）
import { store } from './store.js';
import { h, yen, nf, jdate, today, nowUtc } from './util.js';

export const STATUS_LABELS = { draft: '下書き', sent: '送付済', opened: '開封済', partial: '一部入金', paid: '入金済', overdue: '期限超過', reminded: '督促済' };
export const isReconcile = (b) => (b && b.kind) === 'reconcile';

/* ---------- 計算（インボイス制度：税率ごとに1回端数処理） ---------- */
// mode: 'exclude'（外税：金額は税抜、税を足す）／'include'（内税：金額は税込、税を取り出す）
export function calcInvoice(items, withholding, mode = 'exclude') {
  const incl = mode === 'include';
  const byRate = {};
  for (const it of items) {
    const amount = Math.round(Number(it.qty) * Math.trunc(Number(it.price) || 0));
    const rate = Number(it.tax_rate) || 0;
    byRate[rate] = (byRate[rate] || 0) + amount;
  }
  let subtotal = 0, tax = 0;
  const breakdown = {};
  const rates = Object.keys(byRate).map(Number).sort((a, b) => b - a);
  for (const rate of rates) {
    const sum = byRate[rate];
    let t, base;
    if (incl && rate > 0) { t = Math.floor(sum * rate / (100 + rate)); base = sum - t; }
    else { t = Math.floor(sum * rate / 100); base = sum; }
    subtotal += base; tax += t;
    breakdown[rate] = { base, tax: t };
  }
  // 源泉徴収税（税抜金額に対して。100万円以下10.21%、超える部分20.42%）
  let wh = 0;
  if (withholding) wh = subtotal <= 1000000 ? Math.floor(subtotal * 0.1021) : Math.floor(1000000 * 0.1021 + (subtotal - 1000000) * 0.2042);
  return { subtotal, tax, withholding_amount: wh, total: subtotal + tax - wh, breakdown, rates };
}

/* ---------- ステータス ---------- */
export function statusOf(inv) {
  const s = inv.status;
  if (s !== 'paid' && s !== 'draft' && inv.due_date < today()) return inv.reminded_at ? 'reminded' : 'overdue'; // 督促済は、期限超過のあいだだけ出る
  return s;
}
export function statusLabel(inv, s) {
  if (isReconcile(store.bizOf(inv.business_id)) && (s === 'sent' || s === 'opened')) return '入金待ち';
  return STATUS_LABELS[s] || s;
}
export function statusBadge(inv) {
  const s = statusOf(inv);
  const label = s === 'overdue' ? '期限超過' : s === 'reminded' ? '督促済' : statusLabel(inv, s);
  const extra = s === 'overdue' ? `<span class="sub">${h(statusLabel(inv, inv.status))}</span>` : s === 'reminded' ? `<span class="sub">期限超過・${h(String(inv.reminded_at).slice(5).replace('-', '/'))} 督促</span>` : '';
  return `<span class="badge b-${h(s)}">${h(label)}</span>${extra}`;
}

// 入金の記録から、入金済・一部入金などを決め直す
export function refreshPaymentStatus(inv) {
  const pays = inv.payments || [];
  const paid = pays.reduce((a, p) => a + Number(p.amount), 0);
  const lastDate = pays.map((p) => p.paid_date).sort().pop() || null;
  if (paid >= inv.total && paid > 0) { inv.status = 'paid'; inv.paid_at = lastDate; }
  else if (paid > 0) { inv.status = 'partial'; inv.paid_at = null; }
  else { inv.status = inv.opened_at ? 'opened' : (inv.sent_at ? 'sent' : 'draft'); inv.paid_at = null; }
  inv.paid_amount = paid;
}

// いまのステータスから選べるステータス。開封済になったら、入金済にしか進めない（戻せない）
export function allowedStatuses(inv) {
  const s = inv.status, so = statusOf(inv);
  if (so === 'reminded') return ['overdue', 'paid'];              // 督促済からは、入金済にだけ進める
  if (so === 'overdue') return ['reminded', 'paid'];   // 期限超過からは、督促済か入金済にだけ進める
  if (s === 'paid') return ['paid'];
  if (s === 'partial') return ['paid'];
  if (s === 'opened') return ['opened', 'paid'];
  return ['draft', 'sent', 'opened', 'paid'];
}

// ステータスを手で変える。変えられないとき（開封済から戻す、など）は false を返して何もしない
export function setInvoiceStatus(inv, status, paidDate = null) {
  if (!inv || !STATUS_LABELS[status] || status === 'partial') return false;
  if (!allowedStatuses(inv).includes(status)) return false;
  if (status === 'overdue') { // 督促済を取り消して、期限超過に戻す
    inv.reminded_at = null;
    store.logEvent(inv, 'status', '督促済を取り消しました（期限超過に戻す）');
    return true;
  }
  if (status === 'reminded') { // 督促済：期限超過の請求書にだけ付けられる印（元のステータスはそのまま）
    inv.reminded_at = paidDate || today();
    store.logEvent(inv, 'status', '督促済にしました（督促日 ' + inv.reminded_at + '）');
    return true;
  }
  const now = nowUtc();
  if (status !== 'paid' && (inv.status === 'paid' || inv.status === 'partial')) {
    inv.payments = []; inv.paid_amount = 0; inv.paid_at = null; // 入金済から戻すときは、入金の記録を消す
  }
  if (status === 'draft') { inv.status = 'draft'; inv.sent_at = null; inv.opened_at = null; inv.open_count = 0; }
  else if (status === 'sent') { inv.status = 'sent'; inv.sent_at = inv.sent_at || now; inv.opened_at = null; inv.open_count = 0; }
  else if (status === 'opened') { inv.status = 'opened'; inv.sent_at = inv.sent_at || now; inv.opened_at = inv.opened_at || now; inv.open_count = Math.max(Number(inv.open_count) || 0, 1); }
  else if (status === 'paid') {
    const remain = Number(inv.total) - Number(inv.paid_amount || 0);
    if (remain > 0) {
      inv.payments = inv.payments || [];
      inv.payments.push({ id: store.newId(), paid_date: paidDate || today(), amount: remain, payer: '手動で入金済に変更', source: 'manual', created_at: now });
    }
    inv.sent_at = inv.sent_at || now;
    refreshPaymentStatus(inv);
  }
  store.logEvent(inv, 'status', 'ステータスを手で「' + STATUS_LABELS[status] + '」に変更' + (status === 'paid' && paidDate ? '（入金日 ' + paidDate + '）' : ''));
  return true;
}

/* ---------- 請求書番号 ---------- */
export function nextNumber(date) {
  if (store.setting('number_style') !== 'prefix') {
    const d = (date || today()).replace(/-/g, '');
    let n = 0;
    for (const v of store.db.invoices) { const m = new RegExp('^' + d + '-(\\d+)$').exec(v.number); if (m) n = Math.max(n, Number(m[1])); }
    return d + '-' + (n + 1);
  }
  const prefix = store.setting('number_prefix') || 'INV';
  const ym = today().slice(0, 7).replace('-', '');
  let n = 0;
  for (const v of store.db.invoices) { const m = new RegExp('^' + prefix + '-' + ym + '-(\\d+)$').exec(v.number); if (m) n = Math.max(n, Number(m[1])); }
  return `${prefix}-${ym}-${String(n + 1).padStart(3, '0')}`;
}

/* ---------- 顧客別の単価 ---------- */
// 単価の決め方：①取引先ごとの単価 → ②取引先のルール（原価／原価＋◯円）→ ③商品の標準単価
export function priceInfo(clientId, productId) {
  const cp = store.db.clientPrices.find((x) => x.client_id === Number(clientId) && x.product_id === Number(productId));
  const c = store.client(clientId) || { price_rule: '' };
  const prod = store.product(productId);
  // 「販売単価」に入れた金額があれば、それがそのまま請求する金額
  if (cp) return { price: Number(cp.price), from: '販売単価' };
  // 「すべて仕入単価」の取引先（グループの親会社）は、販売単価を入れていない商品を仕入単価で請求する
  if (c.price_rule === 'cost_all') return prod && prod.cost != null ? { price: Number(prod.cost), from: '仕入単価' } : { price: null, from: '' };
  if (prod && prod.price != null) return { price: Number(prod.price), from: '標準単価' };
  return { price: null, from: '' };
}

/* ---------- メールの文面 ---------- */
export function publicUrl(inv) {
  // 先方が請求書を見るページ（アプリと同じ場所に置く）
  const base = store.isPreview ? 'https://grow-mgt.github.io/grow-mgt/' : new URL('.', location.href).href;
  return base + 'view.html?t=' + inv.token;
}
export function fillTemplate(tpl, inv) {
  const s = store.settings();
  const contact = String(inv.contact || '').trim();
  const map = {
    // 宛名は請求書と同じ（法人名があれば法人名、なければ取引先名）
    '{client}': (String(inv.corp_name || '').trim() !== '' ? inv.corp_name : inv.client_name) + ' ' + inv.honorific,
    // 件名から「令和8年10月分」などの月の部分を外したもの（例：薬局消耗品）
    '{item}': String(inv.title || '').replace(/\s*(令和\s*\d+\s*年|20\d{2}\s*年)?\s*\d{1,2}\s*月分.*$/u, '').trim() || 'ご利用分',
    '{contact}': contact !== '' ? contact + ' 様' : '',
    '{number}': inv.number,
    '{title}': inv.title !== '' ? inv.title : 'ご利用分',
    '{amount}': yen(inv.total) + '（税込）',
    '{due}': jdate(inv.due_date),
    '{url}': publicUrl(inv),
    '{issuer}': s.company,
    '{issuer_tel}': s.tel !== '' ? 'TEL ' + s.tel : '',
    '{issuer_email}': s.email,
  };
  let out = String(tpl);
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  return out.replace(/\n{3,}/g, '\n\n');
}

/* ---------- 月次集計で、請求書の売上を事業ごとに分ける ----------
   取引先の「月額固定の請求」で「集計する事業」を選んだ品目（例：消耗品の請求書に同梱したコンサルティングフィー）は、
   その事業の売上として数える。戻り値：[{ biz, ex（税抜）, total（税込）, ratio（請求額に占める割合） }] */
export function bizShares(inv) {
  const own = inv.business_id;
  const total = Number(inv.total) || 0, subtotal = Number(inv.subtotal) || 0;
  const recs = store.db.recurring.filter((r) => r.client_id === inv.client_id && Number(r.report_biz) && Number(r.report_biz) !== own);
  if (!recs.length || !(inv.items || []).length) return [{ biz: own, ex: subtotal, total, ratio: 1 }];
  const out = new Map();
  for (const r of recs) {
    const its = inv.items.filter((it) => !it.product_id && String(it.name).trim() === String(r.name).trim());
    if (!its.length) continue;
    const b = Number(r.report_biz), cur = out.get(b) || [];
    for (const it of its) if (!cur.includes(it)) cur.push(it);
    out.set(b, cur);
  }
  if (!out.size) return [{ biz: own, ex: subtotal, total, ratio: 1 }];
  const shares = []; let restEx = subtotal, restIn = total;
  for (const [b, its] of out) {
    const c = calcInvoice(its, false, inv.tax_mode === 'include' ? 'include' : 'exclude');
    shares.push({ biz: b, ex: c.subtotal, total: c.total });
    restEx -= c.subtotal; restIn -= c.total;
  }
  shares.unshift({ biz: own, ex: restEx, total: restIn });
  for (const x of shares) x.ratio = total ? x.total / total : 0;
  return shares;
}

// PDFの備考があって、まだ担当者が確かめていない請求書か
export const needsCheck = (inv) => String(inv.check_note || '').trim() !== '' && !inv.checked_at;

// 件名の「令和8年8月分」「8月分」から対象の月を読む（なければ発行月）
const pad2 = (n) => String(n).padStart(2, '0');
export function targetMonth(r) {
  const t = String(r.title || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)), issue = String(r.issue_date).slice(0, 7);
  let m;
  if ((m = /令和\s*(\d+)\s*年\s*(\d{1,2})\s*月分/u.exec(t))) return `${2018 + Number(m[1])}-${pad2(m[2])}`;
  if ((m = /(20\d{2})\s*年\s*(\d{1,2})\s*月分/u.exec(t))) return `${m[1]}-${pad2(m[2])}`;
  if ((m = /(\d{1,2})\s*月分/u.exec(t))) {
    const y = Number(issue.slice(0, 4)), cand = `${y}-${pad2(m[1])}`;
    return cand > issue ? `${y - 1}-${pad2(m[1])}` : cand;
  }
  return issue;
}
/** その事業の売上（税込）を、対象月（件名の「◯月分」）ごとに足す。下書きは入れない。{ '2026-04': 金額 } */
export function salesByTargetMonth(bizId) {
  const out = {};
  for (const r of store.db.invoices) {
    if (r.status === 'draft') continue;
    const m = targetMonth(r);
    for (const sh of bizShares(r)) if (sh.biz === bizId) out[m] = (out[m] || 0) + sh.total;
  }
  return out;
}
/** 粗利と利益率（小数1桁）。売上か仕入のどちらかがまだない月は null */
export function profitOf(sales, cost) {
  if (!sales || !cost) return { profit: null, rate: null };
  const profit = sales - cost;
  return { profit, rate: Math.round(profit / sales * 1000) / 10 };
}
