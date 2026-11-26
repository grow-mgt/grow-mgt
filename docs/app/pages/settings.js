// 設定（今までの settings.php のうち、事業・発行元の情報・メールの文面・請求書の初期値）
import { store } from '../store.js';
import { go } from '../nav.js';
import { h, isEmail } from '../util.js';

// 権限の種類：[記号, 表の見出し, 説明]
const PERMS = [
  ['edit', '登録・<br>変更', '請求書・取引先・商品・入金の登録と変更、CBMのPDF読み込み、入金消込'],
  ['send', 'メール<br>送信', '請求書などのメールを送る'],
  ['del', '削除', '請求書・取引先・商品を消す'],
  ['settings', '設定の<br>変更', '会社情報・振込先の口座・印影・メールの文面・担当者・事業を変える'],
  ['export', 'CSVの<br>書き出し', 'CSVの書き出しと、CSVをメールで送ること'],
  ['backup', 'バック<br>アップ', 'バックアップの実行と、ファイルのダウンロード'],
  ['roles', '権限の<br>変更', 'この表を変える'],
];
// 新しく足した人の最初の状態（ふだんの担当者）
const NEW_PERSON = { name: '', edit: true, send: true, del: true, settings: true, export: false, backup: false, roles: false };
let previewPeople = { 'tantou@example.com': { ...NEW_PERSON, name: '担当者（例）' }, 'zeirishi@example.com': { name: '税理士（例）', edit: false, send: false, del: false, settings: false, export: false, backup: false, roles: false } };
import { flash, showFlash } from '../ui.js';

const KEYS = ['company', 'representative', 'postal', 'address', 'tel', 'fax', 'email', 'reg_no', 'bank', 'seal_image', 'number_style', 'due_days', 'number_prefix', 'mail_subject', 'mail_body'];
const toHalf = (s) => String(s).replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/　/g, ' ');

// 担当者（メールの差し出し人）。設定の中に [{name, email}] の形で持つ
export function staffList() {
  try { const a = JSON.parse(store.setting('staff') || '[]'); return Array.isArray(a) ? a.filter((x) => x && x.email) : []; } catch (e) { return []; }
}

const bizForm = (b) => `
  <form class="biz-form${b ? '' : ' new'}" data-biz-form="${b ? b.id : 0}">
    <div class="biz-grid">
      ${b ? `<i class="biz-dot c${(b.id - 1) % 6}" aria-hidden="true"></i>` : '<i class="biz-dot plus" aria-hidden="true">＋</i>'}
      <label><span>${b ? '事業の名前' : '新しい事業の名前'}</span><input name="biz_name" value="${b ? h(b.name) : ''}"${b ? '' : ' placeholder="新しい事業の名前"'}></label>
      <label><span>使い方</span><select name="biz_kind">
        <option value="invoice"${!b || b.kind !== 'reconcile' ? ' selected' : ''}>請求書を発行する</option>
        <option value="reconcile"${b && b.kind === 'reconcile' ? ' selected' : ''}>入金の消し込みだけ</option>
      </select></label>
      <label><span>振込先（この事業の口座）</span><input name="biz_bank" value="${b ? h(b.bank) : ''}" placeholder="〇〇銀行 〇〇支店 普通 0000000 カ）グロウ"></label>
      ${b ? '<span class="biz-end"></span>' : '<span class="biz-end"><button class="btn small">追加</button></span>'}
    </div>
  </form>`;

const staffRow = (s) => `<tr>
  <td><input class="sname" value="${h(s.name || '')}" placeholder="山田 太郎"></td>
  <td><input class="semail" type="email" value="${h(s.email || '')}" placeholder="yamada@example.co.jp"></td>
  <td><button type="button" class="icon sdel" title="この行を削除">×</button></td></tr>`;

export function settingsPage() {
  const s = store.settings();
  const staff = staffList();
  const html = `
<h1>設定</h1>
<section class="card form" id="biz">
  <h2>事業</h2>
  <p class="small muted">GROWの事業ごとに、振込先の口座と使い方を決めます。「入金の消し込みだけ」の事業は、請求書を送らずに入金予定と銀行の入金を突き合わせます。銀行CSVの列の設定は、入金照合の画面で事業ごとに覚えます。</p>
  <div class="biz-forms">
    <div class="biz-head" aria-hidden="true"><i></i><span>事業の名前</span><span>使い方</span><span>振込先（この事業の口座）</span><span></span></div>
    ${store.businesses().map(bizForm).join('')}${bizForm(null)}
  </div>
</section>

<form class="card form" id="mainForm">
  <h2>請求書に載せる発行元の情報（GROW共通）</h2>
  <div class="grid2">
    <label>会社名・屋号<input name="company" value="${h(s.company)}"></label>
    <label>代表者名・担当者名<input name="representative" value="${h(s.representative)}" placeholder="代表取締役 〇〇 〇〇"></label>
    <label>郵便番号<input name="postal" value="${h(s.postal)}"></label>
    <label>電話番号<input name="tel" value="${h(s.tel)}"></label>
    <label>FAX番号<input name="fax" value="${h(s.fax)}"></label>
    <label class="span2">住所<textarea name="address" rows="2">${h(s.address)}</textarea></label>
    <label>問い合わせ先メール<input type="email" name="email" value="${h(s.email)}"></label>
    <label>適格請求書発行事業者の登録番号<input name="reg_no" value="${h(s.reg_no)}" placeholder="T1234567890123" class="mono"></label>
    <label class="span2">お振込先（事業の口座が未設定のときに使う）<textarea name="bank" rows="2" placeholder="〇〇銀行 〇〇支店 普通 0000000 カ）〇〇">${h(s.bank)}</textarea></label>
    <div class="span2 seal-field">
      <span class="lbl">印影（請求書の右上に入るハンコの画像）</span>
      <div class="seal-row">
        <img id="sealPrev" src="${h(s.seal_image)}" alt=""${s.seal_image === '' ? ' hidden' : ''}>
        <input type="file" id="sealFile" accept="image/png,image/jpeg,image/webp">
        <button type="button" class="btn small" id="sealDel"${s.seal_image === '' ? ' hidden' : ''}>消す</button>
      </div>
      <small>背景が白か透明のハンコの画像（PNG・JPEG）。自動で小さくして保存します。</small>
      <input type="hidden" name="seal_image" id="sealData" value="${h(s.seal_image)}">
    </div>
  </div>

  <h2>メール送信</h2>
  <p class="small muted">メールは、担当者のアドレスを差し出し人にして送ります。お客様の返信も、その担当者に届きます。送るときに担当者を選びます。</p>
  <div class="table-wrap">
  <table class="items" id="staff">
    <thead><tr><th>担当者の名前</th><th>メールアドレス（差し出し人・返信先）</th><th></th></tr></thead>
    <tbody>${[...staff, {}].map(staffRow).join('')}</tbody>
  </table>
  </div>
  <button type="button" class="btn small" id="addStaff">＋ 担当者を追加</button>
  <div class="grid2 mt">
    <label class="span2">メールの件名<input name="mail_subject" value="${h(s.mail_subject)}"></label>
    <label class="span2">メールの本文<textarea name="mail_body" rows="14" class="mono">${h(s.mail_body)}</textarea>
      <small>差し込める項目：{client} 宛名（法人名＋御中）、{item} 件名から月を外したもの（例：薬局消耗品）、{contact} ご担当者、{number} 請求書番号、{title} 件名、{amount} 金額、{due} 期限、{url} 請求書リンク、{issuer} 自社名、{issuer_tel}、{issuer_email}</small></label>
  </div>

  <h2>請求書の初期値</h2>
  <div class="grid2">
    <label>請求書番号の形<select name="number_style">
      <option value="date"${s.number_style !== 'prefix' ? ' selected' : ''}>発行日＋通し番号（例：20261102-15）</option>
      <option value="prefix"${s.number_style === 'prefix' ? ' selected' : ''}>頭の文字＋年月＋番号（例：INV-202611-001）</option>
    </select></label>
    <label>番号の頭につける文字<input name="number_prefix" value="${h(s.number_prefix)}" class="mono"><small>「頭の文字＋年月＋番号」のときに使います</small></label>
    <label>お支払期限<select name="due_days">
      ${Object.entries({ 0: '翌月末', 7: '発行日から7日後', 14: '発行日から14日後', 30: '発行日から30日後', 60: '発行日から60日後' }).map(([k, l]) => `<option value="${k}"${String(s.due_days) === k ? ' selected' : ''}>${l}</option>`).join('')}
    </select><small>手で請求書を作るときの初期値です。CBMの明細と固定の請求は、いつも翌月末になります。</small></label>
  </div>
  <div class="actions"><button class="btn primary">保存</button></div>
</form>

${store.backend.kind !== 'firestore' ? `
<section class="card">
  <h2>本番へ移すデータを書き出す</h2>
  <p class="small muted">このプレビューに入っているデータ（取引先・商品・請求書・設定など）を、本番（Firebase）へ移すためにコピーします。コピーしたものは、本番のアプリを最初に開いたときの「最初のデータを取り込む」に貼り付けます。取引先の情報が入っているので、ほかの場所には貼らないでください。</p>
  <div class="btn-row"><button class="btn primary" id="exportData">データをコピーする</button><span class="small muted" id="exportMsg"></span></div>
  <textarea id="exportText" class="code" rows="4" readonly hidden></textarea>
</section>` : ''}

<section class="card form" id="admins">
  <h2>権限（人ごとに、できることを決める）</h2>
  <p class="small muted">ログインできる人のメールアドレスを登録して、できることにチェックを入れます。新しく足した人は「ふだんの担当者」の状態（登録・変更、メール送信、削除、設定の変更にチェック）で始まるので、必要なところだけ変えてください。<br>
  すべてのチェックを外すと「見るだけ」の人（税理士など）になります。ここに登録していない人も「見るだけ」です。${store.backend.kind === 'firestore' ? '' : '<br><b>このプレビューでは、画面の確認だけができます（保存されず、実際の制限もかかりません）。</b>'}</p>
  <div style="overflow-x:auto"><table class="list small" id="permTable"><thead><tr><th>メールアドレス</th><th>名前（メモ）</th>${PERMS.map((x) => `<th style="text-align:center" title="${h(x[2])}">${x[1]}</th>`).join('')}<th></th></tr></thead><tbody></tbody></table></div>
  ${store.can('roles') ? '<div class="btn-row"><button type="button" class="btn" id="permAdd">＋ 人を足す</button><button type="button" class="btn" id="permSave">権限を保存</button></div>' : '<p class="small muted">権限を変えられるのは、「権限の変更」にチェックがある人だけです。</p>'}
  <table class="list small mt"><thead><tr><th>チェック</th><th>できること</th></tr></thead><tbody>
    ${PERMS.map((x) => `<tr><td>${x[1].replace('<br>', '')}</td><td>${h(x[2])}</td></tr>`).join('')}
  </tbody></table>
</section>

<section class="card" id="backup">
  <h2>バックアップ</h2>
  ${store.backend.kind === 'firestore' && !store.can('backup') ? `<p class="small muted">毎日3時（日本時間）に、すべてのデータを自動でバックアップしています。バックアップの実行とダウンロードは、管理者だけができます。</p>` : store.backend.kind === 'firestore' ? `
  <p class="small muted">毎日3時（日本時間）に、すべてのデータ（取引先・商品・単価・請求書・明細・設定など）を1つのファイルにして、Googleのクラウドの別の場所に保存しています。保存したファイルは90日間残り、そのあと古いものから自動で消えます。</p>
  <p id="bkLast" class="small">最後のバックアップ：確認しています…</p>
  <div class="btn-row"><button type="button" class="btn" id="bkRun">今すぐバックアップする</button><button type="button" class="btn" id="bkList">保存したファイルを見る</button><span class="small muted" id="bkMsg"></span></div>
  <div id="bkFiles"></div>` : `<p class="small muted">本番では、毎日3時に自動でバックアップを取ります。このプレビューでは使えません。</p>`}
</section>
`;

  return {
    title: '設定', active: 'settings', bizTabs: false, html,
    mount(root) {
      const ex = root.querySelector('#exportData');
      if (ex) ex.addEventListener('click', async () => {
        const text = JSON.stringify(store.db), msg = root.querySelector('#exportMsg');
        const count = `請求書${store.db.invoices.length}件・取引先${store.db.clients.length}件・商品${store.db.products.length}件`;
        try { await navigator.clipboard.writeText(text); msg.textContent = 'コピーしました（' + count + '）。'; }
        catch (err) { const ta = root.querySelector('#exportText'); ta.hidden = false; ta.value = text; ta.select(); msg.textContent = '自動でコピーできませんでした。下の枠の中をすべて選んでコピーしてください（' + count + '）。'; }
      });
      // 権限の名簿
      const tb = root.querySelector('#permTable tbody'), canRoles = store.can('roles');
      const me = String((store.backend.userEmail && store.backend.userEmail()) || '').toLowerCase();
      const permRow = (email, v, isNew) => `<tr>
        <td><input type="email" class="mono" data-p="email" value="${h(email)}" placeholder="name@example.com" style="min-width:210px"${canRoles && isNew ? '' : ' readonly'}></td>
        <td><input type="text" data-p="name" value="${h(v.name || '')}" style="min-width:110px"${canRoles ? '' : ' readonly'}></td>
        ${PERMS.map((x) => `<td style="text-align:center"><input type="checkbox" data-p="${x[0]}"${v[x[0]] === true ? ' checked' : ''}${canRoles ? '' : ' disabled'}></td>`).join('')}
        <td class="r">${canRoles && email !== me ? '<button type="button" class="btn small" data-perm-del>外す</button>' : ''}</td></tr>`;
      const people = store.backend.kind === 'firestore' ? store.backend.people : previewPeople;
      tb.innerHTML = Object.keys(people).sort((a, b) => (a === me ? -1 : b === me ? 1 : a.localeCompare(b))).map((k) => permRow(k, people[k], false)).join('')
        || '<tr class="perm-empty"><td colspan="10" class="muted">まだ登録がありません。</td></tr>';
      const permAdd = root.querySelector('#permAdd');
      if (permAdd) permAdd.addEventListener('click', () => {
        const em = tb.querySelector('.perm-empty'); if (em) em.remove();
        tb.insertAdjacentHTML('beforeend', permRow('', { ...NEW_PERSON }, true));
        tb.lastElementChild.querySelector('input').focus();
      });
      tb.addEventListener('click', (e) => { const b = e.target.closest('[data-perm-del]'); if (b) b.closest('tr').remove(); });
      const permSave = root.querySelector('#permSave');
      if (permSave) permSave.addEventListener('click', async () => {
        const next = {};
        for (const tr of tb.querySelectorAll('tr:not(.perm-empty)')) {
          const email = tr.querySelector('[data-p=email]').value.trim().toLowerCase();
          if (!email) continue;
          if (!isEmail(email)) { showFlash('メールアドレスの形式が正しくありません：' + email, 'err'); return; }
          if (next[email]) { showFlash('同じメールアドレスが2回入っています：' + email, 'err'); return; }
          const v = { name: tr.querySelector('[data-p=name]').value.trim() };
          PERMS.forEach((x) => { v[x[0]] = tr.querySelector(`[data-p=${x[0]}]`).checked; });
          next[email] = v;
        }
        if (store.backend.kind !== 'firestore') { previewPeople = next; showFlash('（プレビュー）権限の表を確認しました。本番では、ここで保存されます。'); return; }
        if (!next[me] || !next[me].roles) { showFlash('自分（' + me + '）の「権限の変更」のチェックは外せません。外すと、だれも権限を変えられなくなることがあるためです。', 'err'); return; }
        try { await store.backend.savePeople(next); flash('権限を保存しました（' + Object.keys(next).length + '人）。'); location.reload(); }
        catch (e) { showFlash('権限を保存できませんでした。', 'err'); }
      });
      // バックアップ（本番だけ・管理者だけ）
      if (store.backend.kind === 'firestore' && store.can('backup')) {
        const be = store.backend, msg = root.querySelector('#bkMsg'), last = root.querySelector('#bkLast'), list = root.querySelector('#bkFiles');
        const kb = (n) => (n / 1024).toFixed(n < 10240 ? 1 : 0) + 'KB';
        const fileLabel = (n) => { const m = /^backup_(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})\.json$/.exec(n); return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日 ${m[4]}:${m[5]}` : n; };
        const showLast = async () => {
          try {
            const b = await be.backupInfo();
            last.textContent = b ? `最後のバックアップ：${b.last_at}（${b.by}・請求書${(b.counts || {}).invoices ?? '-'}件・取引先${(b.counts || {}).clients ?? '-'}件・${kb(b.size || 0)}）` : '最後のバックアップ：まだありません（今夜3時に1回目を取ります）';
          } catch (e) { last.textContent = '最後のバックアップ：確認できませんでした'; }
        };
        showLast();
        const busy = (on, text) => { root.querySelectorAll('#bkRun, #bkList').forEach((b) => { b.disabled = on; }); msg.textContent = text || ''; };
        root.querySelector('#bkRun').addEventListener('click', async () => {
          busy(true, 'バックアップしています…');
          try { const r = await be.backups('run'); busy(false); showFlash(`バックアップしました（${fileLabel(r.name)}・${kb(r.size)}）。`); showLast(); if (list.innerHTML) root.querySelector('#bkList').click(); }
          catch (e) { busy(false); showFlash(e.message, 'err'); }
        });
        root.querySelector('#bkList').addEventListener('click', async () => {
          busy(true, '読み込んでいます…');
          try {
            const r = await be.backups('list'); busy(false);
            list.innerHTML = !r.files.length ? '<p class="small muted mt">保存したファイルはまだありません。</p>' : `
              <table class="list small mt"><thead><tr><th>日時</th><th class="r">大きさ</th><th></th></tr></thead><tbody>
              ${r.files.map((f) => `<tr><td>${h(fileLabel(f.name))}</td><td class="r">${kb(f.size)}</td><td class="r"><button type="button" class="btn small" data-bk="${h(f.name)}">ダウンロード</button></td></tr>`).join('')}
              </tbody></table>`;
          } catch (e) { busy(false); showFlash(e.message, 'err'); }
        });
        list.addEventListener('click', async (e) => {
          const b = e.target.closest('[data-bk]'); if (!b) return;
          b.disabled = true; b.textContent = '取り出し中…';
          try {
            const r = await be.backups('get', b.dataset.bk);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([r.text], { type: 'application/json' })); a.download = r.name; a.click();
            URL.revokeObjectURL(a.href);
            b.textContent = 'ダウンロードしました';
          } catch (err) { b.disabled = false; b.textContent = 'ダウンロード'; showFlash(err.message, 'err'); }
        });
      }

      // 事業
      root.querySelectorAll('[data-biz-form]').forEach((f) => f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = Number(f.dataset.bizForm), name = f.biz_name.value.trim();
        const kind = f.biz_kind.value === 'reconcile' ? 'reconcile' : 'invoice', bank = f.biz_bank.value.trim();
        if (name === '') { showFlash('事業の名前を入れてください。', 'err'); return; }
        if (id) {
          await store.saveBusiness(Object.assign(store.bizOf(id), { name, kind, bank }));
          flash('「' + name + '」を保存しました。');
        } else {
          const all = store.db.businesses;
          await store.saveBusiness({ id: Math.max(0, ...all.map((b) => b.id)) + 1, name, kind, bank, csv_date_col: '', csv_amount_col: '', csv_name_col: '', csv_skip_rows: '1', due_day: 0, sort: Math.max(0, ...all.map((b) => b.sort || 0)) + 1 });
          flash('事業「' + name + '」を追加しました。');
        }
        go('settings');
      }));

      // 担当者
      const stBody = root.querySelector('#staff tbody');
      root.querySelector('#addStaff').onclick = () => stBody.insertAdjacentHTML('beforeend', staffRow({}));
      stBody.addEventListener('click', (e) => { if (e.target.classList.contains('sdel')) { if (stBody.rows.length > 1) e.target.closest('tr').remove(); else e.target.closest('tr').querySelectorAll('input').forEach((i) => { i.value = ''; }); } });

      // 印影：長い辺を240pxにして、文字数が多すぎないように保存する
      const file = root.querySelector('#sealFile'), data = root.querySelector('#sealData'), prev = root.querySelector('#sealPrev'), del = root.querySelector('#sealDel');
      file.addEventListener('change', () => {
        const f = file.files[0]; if (!f) return;
        const img = new Image();
        img.onload = () => {
          let size = 240, url = '';
          for (let i = 0; i < 4; i++) {
            const sc = Math.min(1, size / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            url = c.toDataURL('image/png');
            if (url.length > 46000) url = c.toDataURL('image/jpeg', 0.85);
            if (url.length <= 46000) break;
            size = Math.round(size * 0.75);
          }
          data.value = url; prev.src = url; prev.hidden = false; del.hidden = false;
          URL.revokeObjectURL(img.src);
        };
        img.onerror = () => showFlash('印影の画像を読み込めませんでした。PNGかJPEGの画像で試してください。', 'err');
        img.src = URL.createObjectURL(f);
      });
      del.addEventListener('click', () => { data.value = ''; prev.hidden = true; del.hidden = true; file.value = ''; });

      // 保存
      root.querySelector('#mainForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        store.guard('settings');
        const f = e.target, v = {};
        for (const k of KEYS) v[k] = String(f[k].value || '').trim();
        v.reg_no = toHalf(v.reg_no).toUpperCase();
        v.number_prefix = v.number_prefix.replace(/[^A-Za-z0-9-]/g, '') || 'INV';
        const list = [];
        for (const tr of stBody.rows) {
          const name = tr.querySelector('.sname').value.trim(), email = tr.querySelector('.semail').value.trim();
          if (name === '' && email === '') continue;
          if (!isEmail(email)) { showFlash('担当者のメールアドレスの形式が正しくありません：' + (email || name), 'err'); return; }
          list.push({ name, email });
        }
        if (v.seal_image !== '' && (!/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(v.seal_image) || v.seal_image.length > 48000)) { showFlash('印影の画像を読み込めませんでした。もう少し小さい画像（PNGかJPEG）で試してください。', 'err'); return; }
        if (v.reg_no !== '' && !/^T\d{13}$/.test(v.reg_no)) { showFlash('登録番号は「T＋13桁の数字」で入力してください。', 'err'); return; }
        v.staff = JSON.stringify(list);
        // 事業の欄（名前・使い方・振込先・期日）も、この「保存」でまとめて保存する
        const bizChanges = [];
        for (const bf of root.querySelectorAll('[data-biz-form]:not(.new)')) {
          const b = store.bizOf(Number(bf.dataset.bizForm)), name = bf.biz_name.value.trim();
          if (name === '') { showFlash('事業の名前を入れてください。', 'err'); return; }
          const nv = { name, kind: bf.biz_kind.value === 'reconcile' ? 'reconcile' : 'invoice', bank: bf.biz_bank.value.trim() };
          if (Object.keys(nv).some((k) => String(b[k] ?? '') !== String(nv[k]))) bizChanges.push({ ...b, ...nv });
        }
        for (const b of bizChanges) await store.saveBusiness(b);
        await store.saveSettings(v);
        flash('設定を保存しました。'); go('settings');
      });
    },
  };
}
