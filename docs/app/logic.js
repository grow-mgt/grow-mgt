// 計算とルール（今までのアプリの lib.php と同じ結果になるように移したもの）
import { store } from './store.js';
import { h, yen, nf, jdate, today, nowUtc } from './util.js';

export const STATUS_LABELS = { draft: '下書き', sent: '送付済み', opened: '開封済み', partial: '一部入金', paid: '入金済み' };
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
  if (s !== 'paid' && s !== 'draft' && inv.due_date < today()) return 'overdue';
  return s;
}
export function statusLabel(inv, s) {
  if (isReconcile(store.bizOf(inv.business_id)) && (s === 'sent' || s === 'opened')) return '入金待ち';
  return STATUS_LABELS[s] || s;
}
export function statusBadge(inv) {
  const s = statusOf(inv);
  const label = s === 'overdue' ? '期限超過' : statusLabel(inv, s);
  const extra = s === 'overdue' ? `<span class="sub">${h(statusLabel(inv, inv.status))}</span>` : '';
  return `<span class="badge b-${h(s)}">${h(label)}</span>${extra}`;
}

// 入金の記録から、入金済み・一部入金などを決め直す
export function refreshPaymentStatus(inv) {
  const pays = inv.payments || [];
  const paid = pays.reduce((a, p) => a + Number(p.amount), 0);
  const lastDate = pays.map((p) => p.paid_date).sort().pop() || null;
  if (paid >= inv.total && paid > 0) { inv.status = 'paid'; inv.paid_at = lastDate; }
  else if (paid > 0) { inv.status = 'partial'; inv.paid_at = null; }
  else { inv.status = inv.opened_at ? 'opened' : (inv.sent_at ? 'sent' : 'draft'); inv.paid_at = null; }
  inv.paid_amount = paid;
}

// ステータスを手で変える
export function setInvoiceStatus(inv, status, paidDate = null) {
  if (!inv || !STATUS_LABELS[status] || status === 'partial') return;
  const now = nowUtc();
  if (status !== 'paid' && (inv.status === 'paid' || inv.status === 'partial')) {
    inv.payments = []; inv.paid_amount = 0; inv.paid_at = null; // 入金済みから戻すときは、入金の記録を消す
  }
  if (status === 'draft') { inv.status = 'draft'; inv.sent_at = null; inv.opened_at = null; inv.open_count = 0; }
  else if (status === 'sent') { inv.status = 'sent'; inv.sent_at = inv.sent_at || now; inv.opened_at = null; inv.open_count = 0; }
  else if (status === 'opened') { inv.status = 'opened'; inv.sent_at = inv.sent_at || now; inv.opened_at = inv.opened_at || now; inv.open_count = Math.max(Number(inv.open_count) || 0, 1); }
  else if (status === 'paid') {
    const remain = Number(inv.total) - Number(inv.paid_amount || 0);
    if (remain > 0) {
      inv.payments = inv.payments || [];
      inv.payments.push({ id: store.newId(), paid_date: paidDate || today(), amount: remain, payer: '手動で入金済みに変更', source: 'manual', created_at: now });
    }
    inv.sent_at = inv.sent_at || now;
    refreshPaymentStatus(inv);
  }
  store.logEvent(inv, 'status', 'ステータスを手で「' + STATUS_LABELS[status] + '」に変更' + (status === 'paid' && paidDate ? '（入金日 ' + paidDate + '）' : ''));
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
  const c = store.client(clientId) || { price_rule: '', price_rule_amount: 0 };
  const prod = store.product(productId);
  // 「すべて原価」の取引先は、価格表の単価より原価を優先する
  if (c.price_rule === 'cost_all' && prod && prod.cost != null) return { price: Number(prod.cost), from: '原価' };
  if (cp) return { price: Number(cp.price), from: 'この取引先の単価' };
  if (!prod) return { price: null, from: '' };
  if (c.price_rule && prod.cost != null) {
    const amt = c.price_rule === 'cost_plus' ? Number(c.price_rule_amount) || 0 : 0;
    return { price: Number(prod.cost) + amt, from: amt ? '原価+' + nf(amt) + '円' : '原価' };
  }
  if (prod.price != null) return { price: Number(prod.price), from: '標準単価' };
  return { price: null, from: '' };
}

/* ---------- メールの文面 ---------- */
export function publicUrl(inv) {
  const base = store.isPreview ? 'https://grow-mgt.web.app' : location.origin;
  return base + '/view.html?t=' + inv.token;
}
export function fillTemplate(tpl, inv) {
  const s = store.settings();
  const contact = String(inv.contact || '').trim();
  const map = {
    '{client}': (inv.corp_name ? inv.corp_name + '\n' : '') + inv.client_name + ' ' + inv.honorific,
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
