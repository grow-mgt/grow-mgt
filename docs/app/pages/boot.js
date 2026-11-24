// 本番（Firebase）で最初に出る画面：ログインと、最初の1回だけのデータの取り込み
import { h } from '../util.js';

const shell = (inner) => `<div style="min-height:100vh;display:grid;place-items:center;padding:16px"><div class="card form" style="width:100%;max-width:${inner.wide ? 640 : 380}px;margin:0">${inner.html}</div></div>`;
const AUTH_MSG = {
  'auth/invalid-credential': 'メールアドレスかパスワードが違います。',
  'auth/wrong-password': 'メールアドレスかパスワードが違います。',
  'auth/user-not-found': 'メールアドレスかパスワードが違います。',
  'auth/invalid-email': 'メールアドレスの形式が正しくありません。',
  'auth/too-many-requests': '何度も間違えたため、しばらくログインできません。時間をおいて試してください。',
  'auth/user-disabled': 'このアカウントは止められています。管理者に確認してください。',
  'auth/network-request-failed': '通信できませんでした。インターネットの接続を確かめてください。',
};

// ログインの画面を出し、ログインできたら終わる
export function loginScreen(app, backend) {
  return new Promise((resolve) => {
    app.innerHTML = shell({ html: `
      <h1 style="font-size:18px">GROW 請求・入金管理</h1>
      <form id="loginForm">
        <label>メールアドレス<input type="email" name="email" autocomplete="username" required></label>
        <label>パスワード<input type="password" name="password" autocomplete="current-password" required></label>
        <p class="small" id="loginMsg" style="color:var(--danger);min-height:18px;margin:0 0 8px"></p>
        <button class="btn primary wide">ログイン</button>
      </form>
      <p class="small muted" style="margin:12px 0 0"><a href="#" id="resetPw">パスワードを忘れたとき</a></p>` });
    const f = app.querySelector('#loginForm'), msg = app.querySelector('#loginMsg');
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = ''; f.querySelector('button').disabled = true;
      try { await backend.signIn(f.email.value.trim(), f.password.value); resolve(); }
      catch (err) { msg.textContent = AUTH_MSG[err.code] || 'ログインできませんでした。（' + (err.code || err.message) + '）'; f.querySelector('button').disabled = false; }
    });
    app.querySelector('#resetPw').addEventListener('click', async (e) => {
      e.preventDefault();
      const email = f.email.value.trim();
      if (email === '') { msg.textContent = '上の欄にメールアドレスを入れてから、もう一度押してください。'; return; }
      try { await backend.resetPassword(email); msg.style.color = 'var(--ok)'; msg.textContent = 'パスワードを決め直すためのメールを送りました。届いたメールの案内に沿ってください。'; }
      catch (err) { msg.style.color = 'var(--danger)'; msg.textContent = AUTH_MSG[err.code] || 'メールを送れませんでした。（' + (err.code || err.message) + '）'; }
    });
  });
}

const NEED = ['businesses', 'clients', 'products', 'invoices'];
// 最初の1回だけ：プレビューから書き出したデータを取り込む
export function importScreen(app, backend) {
  return new Promise((resolve) => {
    app.innerHTML = shell({ wide: true, html: `
      <h1 style="font-size:18px">最初のデータを取り込む</h1>
      <p class="small muted">保存先がまだ空です。開発中のプレビューの「設定」→「本番へ移すデータを書き出す」でコピーしたデータを、下に貼り付けてください。最初の1回だけ行います。</p>
      <form id="importForm">
        <label>書き出したデータ（貼り付け）<textarea name="text" rows="8" class="code" placeholder='{"settings":{…},"businesses":[…], …}'></textarea></label>
        <label>または、保存したファイルを選ぶ<input type="file" name="file" accept=".json,.txt,application/json"></label>
        <p class="small" id="importMsg" style="min-height:18px;margin:0 0 8px"></p>
        <div class="actions" style="margin:0"><button type="button" class="btn" id="importOut">ログアウト</button><button class="btn primary">取り込む</button></div>
      </form>` });
    const f = app.querySelector('#importForm'), msg = app.querySelector('#importMsg');
    const say = (t, err) => { msg.style.color = err ? 'var(--danger)' : 'var(--ink)'; msg.textContent = t; };
    app.querySelector('#importOut').addEventListener('click', async () => { await backend.signOut(); location.reload(); });
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      let text = f.text.value.trim();
      if (text === '' && f.file.files[0]) text = (await f.file.files[0].text()).trim();
      if (text === '') { say('データを貼り付けるか、ファイルを選んでください。', true); return; }
      let data;
      try { data = JSON.parse(text); } catch (err) { say('データを読み取れませんでした。書き出したものを、最初から最後までそのまま貼り付けてください。', true); return; }
      if (!data || NEED.some((k) => !Array.isArray(data[k]))) { say('このアプリのデータではないようです。', true); return; }
      const btn = f.querySelector('button.primary'); btn.disabled = true;
      try {
        const n = await backend.importAll(data, (done, total) => say(`取り込んでいます…（${done} / ${total}）`));
        say(`${n}件を取り込みました。`);
        resolve();
      } catch (err) { btn.disabled = false; say('取り込めませんでした。（' + h(err.code || err.message) + '）', true); }
    });
  });
}
