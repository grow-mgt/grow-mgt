// 入口：データを読み、画面（ページ）を切り替える
import { store } from './store.js';
import { isReconcile } from './logic.js';
import { h } from './util.js';
import { takeFlash, showFlash, confirmBox } from './ui.js';
import { listPage } from './pages/list.js';
import { detailPage } from './pages/detail.js';
import { editPage } from './pages/edit.js';
import { printPage } from './pages/print.js';
import { clientsPage, clientEditPage } from './pages/clients.js';
import { productsPage, matrixPage } from './pages/products.js';
import { cbmPage } from './pages/cbm.js';
import { kanriPage } from './pages/kanri.js';
import { fixedPage } from './pages/fixed.js';
import { paymentsPage } from './pages/payments.js';
import { reportPage } from './pages/report.js';
import { settingsPage } from './pages/settings.js';
import { catalogPage, catalogEditPage } from './pages/catalog.js';
import { expectPage, bulkMailPage } from './pages/batch.js';
import { artifactBackendOrNull } from './backend-artifact.js';

import { state, go, setBiz, once } from './nav.js';

function header(active, bizTabs) {
  const bid = state.biz;
  const cur = bid ? store.bizOf(bid) : null;
  const rec = cur && isReconcile(cur);
  // 上のメニューは、どの事業を開いていても同じ並びにする（押すたびに項目が増えたり減ったりしないように）
  const nav = [['list', '請求書'], ['clients', '取引先'], ['products', '商品・単価'], ['payments', '入金照合'], ['report', '月次集計'], ['kanri', '年次集計'], ['catalog', '商品データ格納庫'], ['settings', '設定']];
  let html = `<header class="top"><a class="brand" href="#list">GROW 請求・入金管理</a><nav>`;
  for (const [k, label] of nav) html += `<a href="#${k === 'products' ? 'matrix' : k}"${k === active ? ' class="on"' : ''}>${label}</a>`; // 「商品・単価」は、販売単価の画面から開く
  if (store.backend.kind === 'firestore') html += `<a href="#" class="logout" id="logoutLink" title="${h(store.backend.userEmail())}">ログアウト</a>`;
  html += `</nav></header>`;
  if (bizTabs) {
    html += `<div class="biz-tabs"><div class="biz-in"><a href="#list" data-biz="0"${bid === 0 ? ' class="on"' : ''}>GROW全体</a>`;
    for (const b of store.businesses()) html += `<a href="#list" data-biz="${b.id}"${bid === b.id ? ' class="on"' : ''}>${h(b.name)}${isReconcile(b) ? '<small>入金消込</small>' : ''}</a>`;
    html += `</div></div>`;
  }
  return html;
}

function previewBar() {
  if (!store.canEdit()) return `<div class="no-print" style="background:#eef4ff;border-bottom:1px solid #2f6fde;font-size:12px;padding:5px 24px"><b>閲覧専用</b>：このアカウントは、内容を見ることだけができます。登録・変更などが必要なときは、権限を変えられる人に頼んでください。</div>`;
  if (!store.isPreview) return '';
  if (store.durable) {
    return `<div class="no-print" style="background:#e8f5ee;border-bottom:1px solid #1f8a5b;font-size:12px;padding:5px 24px">
      <b>開発中のプレビュー</b>：入力したデータは保存されます（ブラウザを閉じても残ります）。メールは実際には送りません。</div>`;
  }
  return `<div class="no-print" style="background:#fff8e6;border-bottom:1px solid #eda100;font-size:12px;padding:5px 24px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
    <span><b>保存先につながっていません</b>：変更はこのブラウザの中だけに仮に保存されます。大事なデータは入力しないでください。</span>
    <button class="btn small" id="resetPreview" style="margin-left:auto">データを最初の状態に戻す</button></div>`;
}

function render() {
  const name = (location.hash || '#list').slice(1);
  const m = /^([a-z]+)(?:-(.+))?$/.exec(name) || ['', 'list'];
  const route = m[1], arg = m[2] || '';
  let page;
  if (route === 'list') page = listPage();
  else if (route === 'invoice') page = detailPage(Number(arg));
  else if (route === 'edit') page = editPage({ id: Number(arg) });
  else if (route === 'copy') page = editPage({ copy: Number(arg) });
  else if (route === 'new') page = editPage({});
  else if (route === 'print') page = printPage(arg.split('-').map(Number).filter(Boolean));
  else if (route === 'clients') page = clientsPage();
  else if (route === 'client') page = clientEditPage(arg);
  else if (route === 'products') page = productsPage();
  else if (route === 'matrix') page = matrixPage();
  else if (route === 'cbm') page = cbmPage();
  else if (route === 'kanri') page = kanriPage();
  else if (route === 'fixed') page = fixedPage();
  else if (route === 'payments') page = paymentsPage();
  else if (route === 'report') page = reportPage();
  else if (route === 'settings') page = settingsPage();
  else if (route === 'expect') page = expectPage();
  else if (route === 'bulkmail') page = bulkMailPage(arg.split('-').map(Number).filter(Boolean));
  else if (route === 'catalog') page = catalogPage();
  else if (route === 'citem') page = catalogEditPage(arg);
  else page = listPage();
  if (!page) { location.hash = 'list'; return; }

  const f = takeFlash();
  const app = document.getElementById('app');
  if (page.bare) {
    app.innerHTML = previewBar() + page.html;
  } else {
    app.innerHTML = previewBar() + header(page.active || 'list', page.bizTabs !== false)
      + `<main>${f ? `<div class="flash ${h(f[1])}">${h(f[0])}</div>` : ''}${page.html}</main>`;
  }
  document.title = (page.title ? page.title + ' | ' : '') + 'GROW 請求・入金管理';
  // ふつうは画面の一番上へ。一覧の絞り込みを変えたときだけ、絞り込みボタンが同じ高さに残るようにする
  const keep = once.keepTop; once.keepTop = null;
  const fl = keep != null ? app.querySelector('#filters') : null;
  if (fl) {
    const y = Math.max(0, fl.getBoundingClientRect().top + window.scrollY - keep);
    const mainEl = app.querySelector('main'); if (mainEl) mainEl.style.minHeight = (y + window.innerHeight) + 'px'; // 件数が少なくても、位置が動かないだけの高さを確保する
    window.scrollTo(0, y);
  } else window.scrollTo(0, 0);

  // 事業タブ
  app.querySelectorAll('[data-biz]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault(); setBiz(a.dataset.biz);
    // 取引先・商品の画面では、その画面のまま事業だけ切り替える
    const keep = a.closest('.biz-tabs') && ['clients', 'payments', 'report', 'products', 'matrix'].includes(route) ? route : 'list';
    go(keep);
  }));
  const rp = document.getElementById('resetPreview');
  if (rp) rp.addEventListener('click', async () => {
    if (!(await confirmBox('プレビューで行った変更を消して、最初のデータに戻します。よろしいですか？', '戻す'))) return;
    store.resetPreview(); await store.init(); go('list'); showFlash('最初の状態に戻しました。');
  });
  const lo = document.getElementById('logoutLink');
  if (lo) lo.addEventListener('click', async (e) => { e.preventDefault(); await store.backend.signOut(); location.hash = ''; location.reload(); });
  if (page.mount) page.mount(app);
}

window.addEventListener('hashchange', render);
window.addEventListener('app:render', render);

// 保存に失敗したときは、黙って進めずに知らせる
window.addEventListener('unhandledrejection', async (e) => {
  const m = (e.reason && e.reason.message) || '';
  if (e.reason && e.reason.readOnly) { // 閲覧だけの人が変更しようとした：知らせて、画面のデータを元に戻す
    e.preventDefault();
    try { await store.init(store.backend); } catch (err) { /* 読み直せなくても、知らせは出す */ }
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    setTimeout(() => showFlash(m, 'err'), 50);
    return;
  }
  showFlash('保存できませんでした。画面を読み込み直して、もう一度お試しください。' + (m ? '（' + m + '）' : ''), 'err');
});

// どこにデータを置くかを決める
//  - Claudeのプレビューの中：プレビューに付いているデータベース
//  - 自分のパソコンでの試験（localhost）：ブラウザの中だけ
//  - それ以外（公開したアプリ）：Firebase
async function pickBackend() {
  const artifact = await artifactBackendOrNull();
  if (artifact) return artifact;
  let force = ''; try { force = localStorage.getItem('grow-mgt-backend') || ''; } catch (e) { force = ''; }
  const local = ['localhost', '127.0.0.1'].includes(location.hostname) || (window.claude && typeof window.claude.use === 'function');
  if (force !== 'firestore' && (local || force === 'local')) return null;
  const { FirestoreBackend } = await import('./backend-firestore.js');
  return new FirestoreBackend();
}

(async () => {
  const app = document.getElementById('app');
  try {
    const backend = await pickBackend();
    if (backend && backend.kind === 'artifact-db') backend.onProgress = (done, total) => {
      app.innerHTML = `<main><div class="card"><b>今までのデータを保存先に入れています…（${done} / ${total}）</b><p class="small muted">最初の1回だけ行います。終わるまで、この画面を閉じないでください。</p></div></main>`;
    };
    if (backend && backend.kind === 'firestore') {
      const { loginScreen, importScreen } = await import('./pages/boot.js');
      if (!(await backend.currentUser())) await loginScreen(app, backend);
      app.innerHTML = '<main><p class="muted">読み込み中…</p></main>';
      if (await backend.isEmpty()) await importScreen(app, backend);
      app.innerHTML = '<main><p class="muted">読み込み中…</p></main>';
    }
    await store.init(backend);
    if (state.biz !== 0 && !store.db.businesses.some((b) => b.id === state.biz)) state.biz = store.businesses()[0].id;
    render();
  } catch (e) {
    const denied = e && e.code === 'permission-denied';
    app.innerHTML = `<main><div class="flash err">${denied ? 'このアカウントには、データを見る権限がありません。管理者に確認してください。' : 'データを読み込めませんでした：' + h(e.message)}</div></main>`;
  }
})();
