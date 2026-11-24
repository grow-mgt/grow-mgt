// 開発中の保存先：このプレビュー（アーティファクト）に付いているデータベース。
// 入力したものはブラウザを閉じても残り、同じアカウントなら別の端末からも同じデータが見える。
// 本番（Firestore）へは、ここに入っているデータをそのまま移す。
const ROOT = 'gm/main';
const COLLECTIONS = ['businesses', 'clients', 'products', 'clientPrices', 'recurring', 'invoices', 'catalog'];
const CHUNK = 100; // 明細の控え（cbmLines）は100行ずつ1つにまとめて置く
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (o) => JSON.parse(JSON.stringify(o));
const priceKey = (r) => r.client_id + '_' + r.product_id;

// 一時的な失敗（混雑など）は、少し待ってやり直す
async function retry(fn) {
  let wait = 600;
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      const code = e && e.code;
      if (i >= 5 || !(code === 'unavailable' || code === 'resource_exhausted')) throw e;
      await sleep(wait + Math.random() * 300); wait *= 2;
    }
  }
}
function withTimeout(p, ms, msg) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);
}

export class ArtifactBackend {
  constructor(db) { this.db = db; this.kind = 'artifact-db'; this.onProgress = null; }
  ref(col, id) { return this.db.doc(`${ROOT}/${col}/${id}`); }

  async load() {
    const meta = await withTimeout(retry(() => this.db.doc(ROOT).get()), 15000, '保存先に接続できませんでした。少し待ってから、画面を読み込み直してください。');
    if (!meta.exists || !meta.data().seeded) await this.importSeed();
    const out = { settings: {} };
    for (const col of COLLECTIONS) {
      const snap = await retry(() => this.db.collection(`${ROOT}/${col}`).limit(1000).get());
      out[col] = snap.docs.map((d) => plain(d.data()));
    }
    const st = await retry(() => this.ref('settings', 'main').get());
    if (st.exists) out.settings = plain(st.data()).values || {};
    const packs = await retry(() => this.db.collection(`${ROOT}/cbmPacks`).limit(1000).get());
    this.packCount = packs.docs.length;
    out.cbmLines = packs.docs.map((d) => d.data()).sort((a, b) => a.n - b.n).flatMap((p) => plain(p.lines || []));
    return out;
  }

  // 最初の1回だけ：今までのアプリのデータを保存先に入れる
  async importSeed() {
    const seed = await (await fetch('data/seed.json')).json();
    const jobs = [];
    for (const col of COLLECTIONS) for (const row of seed[col] || []) jobs.push([col, col === 'clientPrices' ? priceKey(row) : row.id, row]);
    jobs.push(['settings', 'main', { values: seed.settings || {} }]);
    const lines = seed.cbmLines || [];
    for (let i = 0; i * CHUNK < lines.length; i++) jobs.push(['cbmPacks', 'p' + i, { n: i, lines: lines.slice(i * CHUNK, (i + 1) * CHUNK) }]);
    let done = 0;
    for (const [col, id, data] of jobs) {
      await retry(() => this.ref(col, id).set(plain(data)));
      done++;
      if (this.onProgress) this.onProgress(done, jobs.length);
    }
    await retry(() => this.db.doc(ROOT).set({ seeded: true, seedVersion: seed.version, seededAt: new Date().toISOString() }));
  }

  async put(db, col, id, data) {
    if (col === 'settings') { await retry(() => this.ref('settings', 'main').set({ values: plain(db.settings) })); return; }
    if (col === 'cbmLines') { // 明細の控えは、100行ずつにまとめて置き直す
      const lines = db.cbmLines; let n = 0;
      for (; n * CHUNK < lines.length; n++) await retry(() => this.ref('cbmPacks', 'p' + n).set(plain({ n, lines: lines.slice(n * CHUNK, (n + 1) * CHUNK) })));
      for (let k = n; k < (this.packCount || 0); k++) await retry(() => this.ref('cbmPacks', 'p' + k).delete());
      this.packCount = n; return;
    }
    await retry(() => this.ref(col, id).set(plain(data)));
  }
  async remove(db, col, id) { await retry(() => this.ref(col, id).delete()); }
}

// このプレビューにデータベースが付いていれば、それを使う
export async function artifactBackendOrNull() {
  if (!(window.claude && typeof window.claude.use === 'function')) return null;
  try {
    const db = await window.claude.use('db');
    return db ? new ArtifactBackend(db) : null;
  } catch (e) { return null; }
}
