// データの置き場所。画面はここだけを通してデータを読み書きする。
//  - プレビュー：今までのアプリから書き出したデータ（data/seed.json）を読み、変更はこのブラウザの中だけに保存
//  - 本番：Firestore（backend-firestore.js。Firebaseのプロジェクトができてからつなぐ）
import { nowUtc } from './util.js';

const LS_KEY = 'grow-mgt-preview-db';

// 設定の初期値（今までのアプリの default_settings と同じ）
export const DEFAULT_SETTINGS = {
  company: '', representative: '', postal: '', address: '', tel: '', fax: '', seal_image: '',
  number_style: 'date', email: '', reg_no: '', bank: '',
  mail_from: '', mail_from_name: '', mail_bcc_self: '1', due_days: '30', number_prefix: 'INV',
  mail_subject: '{item}の請求書送付のご案内',
  mail_body: '{client}\n\nいつもお世話になっております。\n{title}の請求書をお送りいたしますのでご査収の程よろしくお願いいたします。\n下記のリンクよりご確認ください。\n\n■請求書番号：{number}\n■ご請求金額：{amount}\n■お支払期限：{due}\n\n{url}\n\nお手数ですが、期限までにお振込みくださいますようお願い申し上げます。\n\n――――――――――\n{issuer}\n{issuer_tel}',
  // シービーエムの請求書の品名 → 価格表の商品名（最初の値）
  cbm_product_alias: "{\"リフィルリボン(黒)詰替用YRR-5840-BL\": \"リフィルリボン黒 YRR-5840-BL\", \"ハーフリフィルリボン(黒)詰替用YRR-3040-BL\": \"ハーフリフィルリボン黒 YRR-3040-BL\", \"感熱紙(カンサナロー、DTAヨウ)\": \"感熱紙(監査ナロー、DTA用)\", \"GC31KHブラック\": \"トナー GC31 ブラック\", \"GC31YHイエロー\": \"トナー GC31 ブラック以外\", \"GC31CHシアン\": \"トナー GC31 ブラック以外\", \"GC31MHマゼンタ\": \"トナー GC31 ブラック以外\", \"GC42KHブラック\": \"トナー GC42 ブラック\", \"ペン本体(黒)KY-012362-3\": \"マーキングペン(黒)KY-012362-3\", \"替芯(18本)+補充インキ(黒18本)KR-ND\": \"替芯(18本)+補充インキ(18本)\", \"替芯(18本)+補充インキ(赤18本)KR-ND\": \"替芯(18本)+補充インキ(18本)\", \"替芯(18本)+補充インキ(青18本)KR-ND\": \"替芯(18本)+補充インキ(18本)\", \"替芯(18本)+補充インキ(緑18本)KR-ND\": \"替芯(18本)+補充インキ(18本)\", \"替芯(18本)+補充インキ(黄土色18本)KR-ND\": \"替芯(18本)+補充インキ(18本)\"}",
  cbm_store_map: '{}',
  cbm_remarks: '{}', // 請求書PDFの備考のうち、明細に結び付かないもの（月ごと）
  staff: '[]', // 担当者（メールの差し出し人）
  // 卸先別の年間管理表：行（卸先・グループ）の並び、明細の卸先名→行の対応、明細のない月に手で入れた金額
  kanri_rows: '[]', kanri_alias: '{}', kanri_manual: '{}',
  // 取引先ごとの単価の決め方を、価格表より優先して決めておく（「すべて原価」の取引先など）
  client_price_mode: '{}',
};

class LocalBackend {
  constructor() { this.kind = 'preview'; }
  async load() {
    const seed = await (await fetch('data/seed.json')).json();
    try {
      const saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (saved && saved.version === seed.version) return saved;
    } catch (e) { /* 保存が読めないときは最初のデータから */ }
    return seed;
  }
  persist(db) { try { localStorage.setItem(LS_KEY, JSON.stringify(db)); } catch (e) { /* 保存できなくても画面は動かす */ } }
  async put(db) { this.persist(db); }
  async remove(db) { this.persist(db); }
  reset() { try { localStorage.removeItem(LS_KEY); } catch (e) { /* 何もしない */ } }
}

export const store = {
  db: null,
  backend: null,
  isPreview: true,
  durable: false,

  async init(backend) {
    this.backend = backend || new LocalBackend();
    this.isPreview = this.backend.kind !== 'firestore'; // 本番（Firestore）以外では、メールを実際には送らない
    this.durable = this.backend.kind !== 'preview';     // 入力したデータが、ブラウザを閉じても残るか
    this.db = await this.backend.load();
    for (const k of ['businesses', 'clients', 'products', 'clientPrices', 'recurring', 'cbmLines', 'invoices', 'catalog']) this.db[k] = this.db[k] || [];
    this.db.settings = this.db.settings || {};
    await this.splitCbmConsul();
    await this.arrangeBusinesses();
    // メールの件名・本文を新しい文面にそろえる（最初の1回だけ。そのあと設定で変えた文面はそのまま使う）
    if (this.setting('mail_tpl') !== '2') await this.saveSettings({ mail_subject: DEFAULT_SETTINGS.mail_subject, mail_body: DEFAULT_SETTINGS.mail_body, mail_tpl: '2' });
  },

  // 事業の並びと名前をそろえる（最初の1回だけ）：スマート介護・CBM・コンサル・不動産賃貸・節電・節水・その他
  async arrangeBusinesses() {
    if (this.setting('biz_layout') === '2' || !this.db.businesses.length) return;
    const order = ['スマート介護', 'CBM', 'コンサル', '不動産賃貸', '節電・節水', 'その他'];
    const cbm = this.db.businesses.find((b) => b.name === 'CBM');
    if (!cbm) return; // 事業の名前を変えてあるときは、何もしない
    const land = this.db.businesses.find((b) => b.name === '不動産賃貸業');
    if (land) await this.saveBusiness({ ...land, name: '不動産賃貸' });
    if (!this.db.businesses.some((b) => b.name === 'その他')) {
      await this.saveBusiness({ ...cbm, id: Math.max(...this.db.businesses.map((b) => b.id)) + 1, name: 'その他', kind: 'invoice' }); // 口座はCBMと同じ
    }
    for (const b of [...this.db.businesses]) {
      const i = order.indexOf(b.name), sort = i >= 0 ? i + 1 : order.length + 1 + (b.sort || 0);
      if (b.sort !== sort) await this.saveBusiness({ ...b, sort });
    }
    await this.saveSetting('biz_layout', '2');
  },

  // 事業「シービーエム・コンサル」を「CBM」と「コンサル」に分ける（最初の1回だけ。請求書の振り分けは、請求書の画面で事業を変えて行う）
  async splitCbmConsul() {
    const old = this.db.businesses.find((b) => b.name === 'シービーエム・コンサル');
    if (!old || this.db.businesses.some((b) => b.name === 'コンサル')) return;
    const after = this.db.businesses.filter((b) => b.id !== old.id && b.sort > old.sort);
    await this.saveBusiness({ ...old, name: 'CBM' });
    for (const b of after) await this.saveBusiness({ ...b, sort: b.sort + 1 }); // 「コンサル」をCBMのすぐ右に並べる
    await this.saveBusiness({ ...old, id: Math.max(...this.db.businesses.map((b) => b.id)) + 1, name: 'コンサル', sort: old.sort + 1 });
  },

  /* ---- 読む ---- */
  setting(key) { const v = this.db.settings[key]; return v != null ? String(v) : String(DEFAULT_SETTINGS[key] ?? ''); },
  settings() { return { ...DEFAULT_SETTINGS, ...this.db.settings }; },
  businesses() { return [...this.db.businesses].sort((a, b) => (a.sort - b.sort) || (a.id - b.id)); },
  bizOf(id) { return this.db.businesses.find((b) => b.id === Number(id)) || this.businesses()[0]; },
  client(id) { return this.db.clients.find((c) => c.id === Number(id)) || null; },
  product(id) { return this.db.products.find((p) => p.id === Number(id)) || null; },
  invoice(id) { return this.db.invoices.find((v) => v.id === Number(id)) || null; },
  // 請求書に、取引先の情報を足したもの（今までの get_invoice と同じ項目名）
  invoiceFull(id) {
    const v = this.invoice(id); if (!v) return null;
    const c = this.client(v.client_id) || {};
    return { ...v, client_name: c.name || '（取引先なし）', honorific: c.honorific || '', contact: c.contact || '', client_email: c.email || '', client_cc: c.cc || '',
      client_postal: c.postal || '', client_address: c.address || '', payer_kana: c.payer_kana || '', corp_name: c.corp_name || '', client_rep: c.representative || '', merge_items: Number(c.merge_items) === 1 ? 1 : 0 };
  },

  /* ---- 書く ---- */
  newId() { return Date.now() * 1000 + Math.floor(Math.random() * 1000); },
  async saveInvoice(inv) {
    inv.updated_at = nowUtc();
    const i = this.db.invoices.findIndex((v) => v.id === inv.id);
    if (i >= 0) this.db.invoices[i] = inv; else this.db.invoices.push(inv);
    await this.backend.put(this.db, 'invoices', inv.id, inv);
  },
  async deleteInvoice(id) {
    this.db.invoices = this.db.invoices.filter((v) => v.id !== Number(id));
    await this.backend.remove(this.db, 'invoices', Number(id));
  },
  async saveProduct(p) {
    const i = this.db.products.findIndex((x) => x.id === p.id);
    if (i >= 0) this.db.products[i] = p; else this.db.products.push(p);
    await this.backend.put(this.db, 'products', p.id, p);
  },
  async setClientPrice(clientId, productId, price, source = 'app') {
    this.db.clientPrices = this.db.clientPrices.filter((x) => !(x.client_id === clientId && x.product_id === productId));
    const key = clientId + '_' + productId;
    if (price == null) { await this.backend.remove(this.db, 'clientPrices', key); return; }
    const row = { client_id: clientId, product_id: productId, price, source };
    this.db.clientPrices.push(row);
    await this.backend.put(this.db, 'clientPrices', key, row);
  },
  // 商品データ格納庫
  async saveCatalog(it) {
    const i = this.db.catalog.findIndex((x) => x.id === it.id);
    if (i >= 0) this.db.catalog[i] = it; else this.db.catalog.push(it);
    await this.backend.put(this.db, 'catalog', it.id, it);
  },
  async deleteCatalog(id) {
    this.db.catalog = this.db.catalog.filter((x) => x.id !== id);
    await this.backend.remove(this.db, 'catalog', id);
  },
  async saveBusiness(b) {
    const i = this.db.businesses.findIndex((x) => x.id === b.id);
    if (i >= 0) this.db.businesses[i] = b; else this.db.businesses.push(b);
    await this.backend.put(this.db, 'businesses', b.id, b);
  },
  async saveClient(c) {
    const i = this.db.clients.findIndex((x) => x.id === c.id);
    if (i >= 0) this.db.clients[i] = c; else this.db.clients.push(c);
    await this.backend.put(this.db, 'clients', c.id, c);
  },
  async deleteClient(id) {
    id = Number(id);
    this.db.clients = this.db.clients.filter((c) => c.id !== id);
    await this.backend.remove(this.db, 'clients', id);
    for (const cp of this.db.clientPrices.filter((x) => x.client_id === id)) await this.setClientPrice(id, cp.product_id, null);
    await this.replaceRecurring(id, []);
  },
  async deleteProduct(id) {
    id = Number(id);
    this.db.products = this.db.products.filter((p) => p.id !== id);
    await this.backend.remove(this.db, 'products', id);
    for (const cp of this.db.clientPrices.filter((x) => x.product_id === id)) await this.setClientPrice(cp.client_id, id, null);
  },
  // 取引先の「月額固定の明細」を入れ替える
  async replaceRecurring(clientId, rows) {
    clientId = Number(clientId);
    for (const old of this.db.recurring.filter((r) => r.client_id === clientId)) await this.backend.remove(this.db, 'recurring', old.id);
    this.db.recurring = this.db.recurring.filter((r) => r.client_id !== clientId);
    let sort = 0;
    for (const r of rows) {
      const row = { id: this.newId() + sort, client_id: clientId, sort: sort++, ...r };
      this.db.recurring.push(row);
      await this.backend.put(this.db, 'recurring', row.id, row);
    }
  },
  // 取り込んだ明細を控えとして保存する（同じ月の控えは入れ替え）。後で下書きを作り直すために使う
  async saveCbmLines(tab, lines) {
    const base = this.newId();
    this.db.cbmLines = this.db.cbmLines.filter((l) => l.tab !== tab)
      .concat(lines.map((l, i) => ({ id: base + i, tab, sort: i, store: l.store, date: l.date || '', name: l.name, qty: l.qty, cost: l.cost ?? null,
        ...(l.note ? { note: l.note } : {}), ...(l.cust_price != null ? { cust_price: l.cust_price } : {}) }))); // note・cust_price：PDFの備考（お客様価格など）
    await this.backend.put(this.db, 'cbmLines', null, null);
  },
  // 設定をまとめて保存する（変わっていなければ何も書かない）
  async saveSettings(values) {
    let changed = false;
    for (const [k, v] of Object.entries(values)) if (this.setting(k) !== String(v)) { this.db.settings[k] = String(v); changed = true; }
    if (changed) await this.backend.put(this.db, 'settings', 'main', null);
  },
  async saveSetting(key, value) {
    this.db.settings[key] = String(value);
    await this.backend.put(this.db, 'settings', 'main', null);
  },
  logEvent(inv, type, detail = '') {
    inv.events = inv.events || [];
    inv.events.push({ id: this.newId(), type, detail, created_at: nowUtc() });
  },
  resetPreview() { if (this.backend.reset) this.backend.reset(); },
};
