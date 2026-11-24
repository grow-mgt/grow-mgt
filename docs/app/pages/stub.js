// まだFirebase版に移していない画面の案内
import { h } from '../util.js';

export function stubPage(route, label) {
  const top = ['clients', 'products', 'payments', 'report', 'settings'].includes(route) ? route : 'list';
  return {
    title: label, active: top,
    html: `<h1>${h(label)}</h1>
      <div class="empty">スプレッドシートへのバックアップは、Firebaseにつないだあとに使えるようになります。<br>
      <span class="small">今は、入力したデータをこのプレビューの保存先に置いています。</span><br>
      <a class="btn" href="#list">一覧に戻る</a></div>`,
  };
}
