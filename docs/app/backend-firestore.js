// 本番の保存先：Firebase（Firestore）。ログインした担当者だけが読み書きできる。
// 置き方：コレクション（invoices, clients, …）の下に、idを名前にした文書を1件ずつ。設定は settings/main、明細の控えは cbmPacks/p0, p1, …
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail, setPersistence, browserLocalPersistence }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import { getFirestore, collection, doc, getDoc, getDocs, setDoc, deleteDoc, writeBatch }
  from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js';
import { firebaseConfig } from './firebase-config.js';

const COLLECTIONS = ['businesses', 'clients', 'products', 'clientPrices', 'recurring', 'invoices', 'catalog'];
const CHUNK = 100; // 明細の控え（cbmLines）は100行ずつ1つにまとめて置く
const plain = (o) => JSON.parse(JSON.stringify(o)); // undefined を落とす（Firestoreは受け付けないため）
const priceKey = (r) => r.client_id + '_' + r.product_id;
const packs = (lines) => { const out = []; for (let n = 0; n * CHUNK < lines.length; n++) out.push({ n, lines: lines.slice(n * CHUNK, (n + 1) * CHUNK) }); return out; };

export class FirestoreBackend {
  constructor() {
    this.kind = 'firestore';
    this.app = initializeApp(firebaseConfig);
    this.auth = getAuth(this.app);
    this.fs = getFirestore(this.app);
    this.fn = getFunctions(this.app, 'asia-northeast1');
    this.packCount = 0;
  }

  /* ---- メール ---- */
  // 送るのは Cloud Functions の sendMail（差し出し人は、設定に登録した担当者だけ）
  async sendMail({ from, to, cc, subject, body, attachments }) {
    try {
      const r = await httpsCallable(this.fn, 'sendMail')({ from, to, cc: cc || '', subject, body, attachments: attachments || [] });
      return r.data;
    } catch (e) {
      if (e && e.code === 'functions/not-found') throw new Error('メール送信の仕組みが、まだFirebaseに入っていません。');
      throw new Error(e && e.message ? e.message : 'メールを送れませんでした。');
    }
  }

  /* ---- ログイン ---- */
  // 今ログインしている人（いなければ null）。最初の1回は、前回のログインが残っているかの確認を待つ
  currentUser() {
    return new Promise((resolve) => { const off = onAuthStateChanged(this.auth, (u) => { off(); resolve(u); }); });
  }
  async signIn(email, password) {
    await setPersistence(this.auth, browserLocalPersistence);
    return (await signInWithEmailAndPassword(this.auth, email, password)).user;
  }
  signOut() { return signOut(this.auth); }
  resetPassword(email) { return sendPasswordResetEmail(this.auth, email); }
  userEmail() { return this.auth.currentUser ? this.auth.currentUser.email : ''; }

  /* ---- 読む ---- */
  async load() {
    const out = { settings: {} };
    const snaps = await Promise.all(COLLECTIONS.map((c) => getDocs(collection(this.fs, c))));
    COLLECTIONS.forEach((c, i) => { out[c] = snaps[i].docs.map((d) => d.data()); });
    const st = await getDoc(doc(this.fs, 'settings', 'main'));
    if (st.exists()) out.settings = st.data().values || {};
    const ps = await getDocs(collection(this.fs, 'cbmPacks'));
    this.packCount = ps.size;
    out.cbmLines = ps.docs.map((d) => d.data()).sort((a, b) => a.n - b.n).flatMap((p) => p.lines || []);
    return out;
  }
  // まだ何も入っていないか（最初のデータの取り込みが必要か）
  async isEmpty() {
    const meta = await getDoc(doc(this.fs, 'meta', 'main'));
    return !meta.exists();
  }

  /* ---- 書く ---- */
  async put(db, col, id, data) {
    if (col === 'settings') { await setDoc(doc(this.fs, 'settings', 'main'), { values: plain(db.settings) }); return; }
    if (col === 'cbmLines') { // 明細の控えは、100行ずつにまとめて置き直す
      const list = packs(db.cbmLines);
      for (const p of list) await setDoc(doc(this.fs, 'cbmPacks', 'p' + p.n), plain(p));
      for (let k = list.length; k < this.packCount; k++) await deleteDoc(doc(this.fs, 'cbmPacks', 'p' + k));
      this.packCount = list.length; return;
    }
    await setDoc(doc(this.fs, col, String(id)), plain(data));
  }
  async remove(db, col, id) { await deleteDoc(doc(this.fs, col, String(id))); }

  // 最初の1回：プレビューから書き出したデータをまとめて入れる
  async importAll(data, onProgress) {
    const jobs = [];
    for (const col of COLLECTIONS) for (const row of data[col] || []) jobs.push([col, col === 'clientPrices' ? priceKey(row) : String(row.id), row]);
    jobs.push(['settings', 'main', { values: data.settings || {} }]);
    for (const p of packs(data.cbmLines || [])) jobs.push(['cbmPacks', 'p' + p.n, p]);
    let done = 0;
    for (let i = 0; i < jobs.length; i += 200) { // まとめて書く（1回に200件まで）
      const batch = writeBatch(this.fs);
      for (const [col, id, row] of jobs.slice(i, i + 200)) batch.set(doc(this.fs, col, id), plain(row));
      await batch.commit();
      done = Math.min(jobs.length, i + 200);
      if (onProgress) onProgress(done, jobs.length);
    }
    await setDoc(doc(this.fs, 'meta', 'main'), { importedAt: new Date().toISOString(), by: this.userEmail(), counts: Object.fromEntries(COLLECTIONS.map((c) => [c, (data[c] || []).length])) });
    return jobs.length;
  }
}
