// 画面共通の部品：お知らせ（flash）と確認の小窓
import { h } from './util.js';

let pendingFlash = null;
export function flash(msg, type = 'ok') { pendingFlash = [msg, type]; }
export function takeFlash() { const f = pendingFlash; pendingFlash = null; return f; }
// 今の画面にすぐ出す
export function showFlash(msg, type = 'ok') {
  const main = document.querySelector('main'); if (!main) return;
  main.querySelectorAll(':scope > .flash.now').forEach((x) => x.remove());
  const d = document.createElement('div');
  d.className = 'flash now ' + type; d.textContent = msg;
  main.prepend(d);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function dialog(html) {
  let dlg = document.getElementById('appDialog');
  if (!dlg) {
    dlg = document.createElement('dialog'); dlg.id = 'appDialog';
    dlg.style.cssText = 'border:0;border-radius:10px;padding:20px 22px;width:min(440px,92vw);box-shadow:0 10px 30px rgba(0,0,0,.25)';
    document.body.appendChild(dlg);
  }
  dlg.innerHTML = html;
  dlg.showModal();
  return dlg;
}

// 確認（はい／キャンセル）。はい＝true
export function confirmBox(message, okLabel = 'はい') {
  return new Promise((resolve) => {
    const dlg = dialog(`<p style="margin:0 0 16px;white-space:pre-wrap">${h(message)}</p>
      <div class="actions" style="margin:0"><button class="btn" data-v="0">キャンセル</button><button class="btn primary" data-v="1">${h(okLabel)}</button></div>`);
    const done = (v) => { dlg.close(); resolve(v); };
    dlg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => done(b.dataset.v === '1')));
    dlg.addEventListener('cancel', () => resolve(false), { once: true });
  });
}

// 日付を1つ聞く。キャンセル＝null
export function askDate(message, value) {
  return new Promise((resolve) => {
    const dlg = dialog(`<label>${h(message)}<input type="date" value="${h(value)}"></label>
      <div class="actions"><button class="btn" data-v="0">キャンセル</button><button class="btn primary" data-v="1">決定</button></div>`);
    const done = (v) => { dlg.close(); resolve(v); };
    dlg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => done(b.dataset.v === '1' ? dlg.querySelector('input').value || null : null)));
    dlg.addEventListener('cancel', () => resolve(null), { once: true });
  });
}
