// 商品データ格納庫：営業で案内する商品・サービスの資料（PDF・LP）と案内文を置いておき、すぐメールやLINEで送れるようにする。
// 請求書に使う「商品・単価」とは別の一覧。タグ（節電、老人ホーム など）で探せる。
import { store } from '../store.js';
import { go } from '../nav.js';
import { sendMail } from '../mailer.js';
import { staffList } from './settings.js';
import { h, nowUtc, jdatetime, isEmail } from '../util.js';
import { flash, showFlash, confirmBox } from '../ui.js';

const view = { tag: '', q: '' };
const DEFAULT_SUBJECT = '{name}のご案内';
const DEFAULT_BODY = 'いつもお世話になっております。\n{issuer}の{staff}です。\n\n{name}の資料をお送りいたします。\n\n{materials}\n\nご不明な点がございましたら、お気軽にお問い合わせください。\nよろしくお願いいたします。';
const DEFAULT_LINE = '{name}の資料をお送りします。\n{materials}';

const isUrl = (s) => /^https?:\/\/\S+$/i.test(String(s).trim());
const splitTags = (s) => [...new Set(String(s).split(/[,、\s　]+/u).map((t) => t.replace(/^[#＃]/, '').trim()).filter(Boolean))];
const allTags = () => { const m = new Map(); for (const it of store.db.catalog) for (const t of it.tags || []) m.set(t, (m.get(t) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja')); };
const materialsText = (it) => (it.materials || []).filter((m) => m.url).map((m) => (m.label ? m.label + '：' : '') + m.url).join('\n');
function fill(tpl, it, staffName) {
  const map = { '{name}': it.name, '{materials}': materialsText(it) || '（資料は準備中です）', '{issuer}': store.setting('company'), '{staff}': staffName || '' };
  let out = String(tpl);
  if (!staffName) out = out.replace(/の\{staff\}/g, ''); // 担当者が決まっていないときは「〇〇の（担当者）です」の名前の部分を外す
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  return out.replace(/\n{3,}/g, '\n\n');
}

/* ---------- 一覧 ---------- */
export function catalogPage() {
  const tags = allTags();
  const q = view.q.trim().toLowerCase();
  const items = [...store.db.catalog]
    .filter((it) => (!view.tag || (it.tags || []).includes(view.tag)) && (q === '' || (it.name + ' ' + (it.memo || '') + ' ' + (it.tags || []).join(' ')).toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  const staff = staffList();

  const html = `
<div class="head-row">
  <div><h1>商品データ格納庫</h1><p class="muted small">案内する商品・サービスの資料（PDF・LP）と案内文を置いておく場所です。請求書の「商品・単価」とは別の一覧です。</p></div>
  <a class="btn primary" href="#citem-new">＋ 商品を登録</a>
</div>
<form class="filters" id="catFilters">
  <a href="#catalog" data-tag="" class="chip${view.tag === '' ? ' on' : ''}">すべて <small>${store.db.catalog.length}</small></a>
  ${tags.map(([t, n]) => `<a href="#catalog" data-tag="${h(t)}" class="chip${view.tag === t ? ' on' : ''}">${h(t)} <small>${n}</small></a>`).join('')}
  <input type="search" name="q" value="${h(view.q)}" placeholder="商品名・タグ・メモで検索">
</form>
${!items.length ? `<div class="empty">${store.db.catalog.length ? '当てはまる商品がありません。' : 'まだ登録がありません。<br>「＋ 商品を登録」から、商品名・タグ・資料のURLを入れてください。'}</div>` : `
<div class="cat-list">
  ${items.map((it) => { const mats = (it.materials || []).filter((m) => m.url); const last = (it.sends || []).at(-1); return `
  <section class="card" data-id="${it.id}" style="margin-bottom:12px">
    <div class="head-row" style="margin-bottom:8px">
      <div>
        <b style="font-size:16px">${h(it.name)}</b>
        <div style="margin-top:4px">${(it.tags || []).map((t) => `<a href="#catalog" data-tag="${h(t)}" class="badge b-sent" style="margin-right:4px">${h(t)}</a>`).join('')}</div>
      </div>
      <div class="btns">
        <button class="btn small primary" data-act="mail">メールで送る</button>
        <a class="btn small" data-act="line" href="https://line.me/R/share?text=${encodeURIComponent(fill(it.line_text || DEFAULT_LINE, it, ''))}" target="_blank" rel="noopener" style="background:#06c755;border-color:#06c755;color:#fff">LINEで送る</a>
        <button class="btn small" data-act="copy">文面をコピー</button>
        <a class="btn small" href="#citem-${it.id}">編集</a>
      </div>
    </div>
    ${it.memo ? `<p class="small" style="margin:0 0 8px;white-space:pre-wrap">${h(it.memo)}</p>` : ''}
    ${mats.length ? `<table class="mini">${mats.map((m) => `<tr><td style="width:30%">${h(m.label || '資料')}</td><td class="small"><a href="${h(m.url)}" target="_blank" rel="noopener">${h(m.url)}</a></td></tr>`).join('')}</table>`
      : '<p class="small warn-text" style="margin:0">資料のURLが未登録です。</p>'}
    ${last ? `<p class="small muted" style="margin:8px 0 0">最後に送った日：${h(jdatetime(last.at))}　${h(last.to)}（${h(last.by)}）${(it.sends || []).length > 1 ? '　ほか' + ((it.sends || []).length - 1) + '回' : ''}</p>` : ''}
  </section>`; }).join('')}
</div>`}
<dialog id="catMail" style="border:0;border-radius:10px;padding:20px 22px;width:min(620px,94vw);box-shadow:0 10px 30px rgba(0,0,0,.25)"></dialog>`;

  return {
    title: '商品データ格納庫', active: 'catalog', bizTabs: false, html,
    mount(root) {
      root.querySelectorAll('[data-tag]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); view.tag = a.dataset.tag; go('catalog'); }));
      const ff = root.querySelector('#catFilters');
      ff.addEventListener('submit', (e) => { e.preventDefault(); view.q = ff.q.value; go('catalog'); });
      ff.q.addEventListener('search', () => { view.q = ff.q.value; go('catalog'); });

      root.querySelectorAll('section[data-id]').forEach((sec) => {
        const it = store.db.catalog.find((x) => String(x.id) === sec.dataset.id);
        sec.querySelector('[data-act="copy"]').addEventListener('click', async (e) => {
          try { await navigator.clipboard.writeText(fill(it.line_text || DEFAULT_LINE, it, '')); e.target.textContent = 'コピーしました'; }
          catch (err) { showFlash('コピーできませんでした。', 'err'); }
        });
        sec.querySelector('[data-act="mail"]').addEventListener('click', () => openMail(root, it, staff));
      });
    },
  };
}

// メールで送る（確認の小窓）
function openMail(root, it, staff) {
  const dlg = root.querySelector('#catMail');
  if (!staff.length) { showFlash('差し出し人にする担当者が未登録です。設定の「メール送信」で登録してください。', 'err'); return; }
  let last = ''; try { last = localStorage.getItem('grow-mgt-sender') || ''; } catch (e) { last = ''; }
  const cur = staff.find((x) => x.email === last) || staff[0];
  dlg.innerHTML = `
    <form class="form" method="dialog" id="catMailForm">
      <h2 style="margin-top:0">「${h(it.name)}」をメールで送る</h2>
      <label>差し出し人（担当者）<select name="from">${staff.map((x) => `<option value="${h(x.email)}" data-name="${h(x.name || '')}"${x.email === cur.email ? ' selected' : ''}>${h((x.name ? x.name + ' ' : '') + '<' + x.email + '>')}</option>`).join('')}</select></label>
      <label>宛先<input type="email" name="to" required placeholder="customer@example.com"></label>
      <label>件名<input name="subject" value="${h(fill(it.mail_subject || DEFAULT_SUBJECT, it, cur.name))}"></label>
      <label>本文<textarea name="body" rows="12">${h(fill(it.mail_body || DEFAULT_BODY, it, cur.name))}</textarea></label>
      <p class="small muted" id="catMailMsg"></p>
      <div class="actions"><button type="button" class="btn" id="catMailClose">閉じる</button><button class="btn primary">送信する</button></div>
    </form>`;
  const f = dlg.querySelector('form');
  dlg.querySelector('#catMailClose').onclick = () => dlg.close();
  // 担当者を変えたら、手を入れていない件名・本文は名前を入れ直す
  let auto = { subject: f.subject.value, body: f.body.value };
  f.from.addEventListener('change', () => {
    const nm = f.from.selectedOptions[0].dataset.name;
    for (const [k, tpl] of [['subject', it.mail_subject || DEFAULT_SUBJECT], ['body', it.mail_body || DEFAULT_BODY]]) {
      if (f[k].value === auto[k]) { f[k].value = fill(tpl, it, nm); auto[k] = f[k].value; }
    }
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const to = f.to.value.trim(), from = f.from.value;
    if (!isEmail(to)) { dlg.querySelector('#catMailMsg').textContent = '宛先のメールアドレスを確かめてください。'; return; }
    try {
      const r = await sendMail({ from, to, cc: '', subject: f.subject.value.trim(), body: f.body.value });
      try { localStorage.setItem('grow-mgt-sender', from); } catch (err) { /* 覚えられなくても送れる */ }
      it.sends = (it.sends || []).concat([{ at: nowUtc(), to, by: f.from.selectedOptions[0].dataset.name || from, simulated: !!r.simulated }]).slice(-50);
      await store.saveCatalog(it);
      dlg.close();
      flash(r.simulated ? 'プレビューのため、メールは実際には送っていません（送った記録だけ残しました）。' : '「' + it.name + '」の資料をメールで送りました。', r.simulated ? 'warn' : 'ok'); go('catalog');
    } catch (err) { dlg.querySelector('#catMailMsg').textContent = err.message; }
  });
  dlg.showModal();
}

/* ---------- 登録・編集 ---------- */
const matRow = (m) => `<tr>
  <td><input class="mlabel" value="${h(m.label || '')}" placeholder="例：パンフレット（PDF）／LP"></td>
  <td><input class="murl" value="${h(m.url || '')}" placeholder="https://…"></td>
  <td><button type="button" class="icon mdel" title="この行を削除">×</button></td></tr>`;

export function catalogEditPage(arg) {
  const isNew = arg === 'new';
  const it = isNew ? { id: 0, name: '', tags: view.tag ? [view.tag] : [], memo: '', materials: [], mail_subject: '', mail_body: '', line_text: '' } : store.db.catalog.find((x) => String(x.id) === String(arg));
  if (!it) return null;
  const tags = allTags();
  const html = `
<p class="crumb"><a href="#catalog">商品データ格納庫</a> ›</p>
<h1>${isNew ? '商品を登録' : '商品を編集'}</h1>
<form class="card form" id="catForm">
  <div class="grid2">
    <label class="span2">商品・サービスの名前 <em>必須</em><input name="name" value="${h(it.name)}" required placeholder="例：節電システム〇〇"></label>
    <label class="span2">タグ（空白か「、」で区切る）<input name="tags" value="${h((it.tags || []).join(' '))}" placeholder="例：節電 老人ホーム">
      <small>${tags.length ? '今あるタグ（押すと入ります）：' + tags.map(([t]) => `<a href="#" class="chip" data-add-tag="${h(t)}" style="padding:2px 9px;font-size:12px">${h(t)}</a>`).join(' ') : 'タグを付けると、一覧で絞り込めます。'}</small></label>
    <label class="span2">メモ（社内用。どんな商品か、誰に聞けばよいか、など）<textarea name="memo" rows="3">${h(it.memo || '')}</textarea></label>
  </div>

  <h2>資料（PDF・LP）</h2>
  <p class="small muted">資料の置き場所のURLを入れます。Googleドライブに置いたPDFなら、共有リンク（リンクを知っている人が見られる設定）を貼ってください。ここに入れたURLが、メールとLINEの文面に入ります。</p>
  <div class="table-wrap">
  <table class="items" id="mats">
    <thead><tr><th style="width:32%">資料の名前</th><th>URL</th><th></th></tr></thead>
    <tbody>${[...(it.materials || []), {}].map(matRow).join('')}</tbody>
  </table>
  </div>
  <button type="button" class="btn small" id="addMat">＋ 資料を追加</button>

  <h2>案内文</h2>
  <p class="small muted">空欄なら、決まった文面を使います。差し込める項目：{name} 商品名、{materials} 資料の一覧、{issuer} 自社名、{staff} 担当者名</p>
  <div class="grid2">
    <label class="span2">メールの件名<input name="mail_subject" value="${h(it.mail_subject || '')}" placeholder="${h(DEFAULT_SUBJECT)}"></label>
    <label class="span2">メールの本文<textarea name="mail_body" rows="9" placeholder="${h(DEFAULT_BODY)}">${h(it.mail_body || '')}</textarea></label>
    <label class="span2">LINEの文面<textarea name="line_text" rows="3" placeholder="${h(DEFAULT_LINE)}">${h(it.line_text || '')}</textarea></label>
  </div>
  <div class="actions"><a class="btn" href="#catalog">戻る</a><button class="btn primary">保存</button></div>
</form>
${isNew ? '' : '<div class="danger-zone"><button class="btn danger small" id="delCat">この商品を削除</button></div>'}`;

  return {
    title: '商品データ格納庫', active: 'catalog', bizTabs: false, html,
    mount(root) {
      const f = root.querySelector('#catForm'), body = root.querySelector('#mats tbody');
      root.querySelector('#addMat').onclick = () => body.insertAdjacentHTML('beforeend', matRow({}));
      body.addEventListener('click', (e) => { if (e.target.classList.contains('mdel')) { if (body.rows.length > 1) e.target.closest('tr').remove(); else e.target.closest('tr').querySelectorAll('input').forEach((i) => { i.value = ''; }); } });
      root.querySelectorAll('[data-add-tag]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); const cur = splitTags(f.tags.value); if (!cur.includes(a.dataset.addTag)) cur.push(a.dataset.addTag); f.tags.value = cur.join(' '); }));

      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = f.name.value.trim();
        if (name === '') { showFlash('商品・サービスの名前を入力してください。', 'err'); return; }
        const materials = [];
        for (const tr of body.rows) {
          const label = tr.querySelector('.mlabel').value.trim(), url = tr.querySelector('.murl').value.trim();
          if (label === '' && url === '') continue;
          if (url !== '' && !isUrl(url)) { showFlash('資料のURLは「https://」から始まる形で入れてください：' + url, 'err'); return; }
          materials.push({ label, url });
        }
        const next = { ...it, id: it.id || store.newId(), name, tags: splitTags(f.tags.value), memo: f.memo.value.trim(), materials,
          mail_subject: f.mail_subject.value.trim(), mail_body: f.mail_body.value.trim(), line_text: f.line_text.value.trim(), updated_at: nowUtc() };
        if (isNew) next.created_at = nowUtc();
        await store.saveCatalog(next);
        flash('「' + name + '」を保存しました。'); go('catalog');
      });
      const del = root.querySelector('#delCat');
      if (del) del.addEventListener('click', async () => {
        if (!(await confirmBox('「' + it.name + '」を格納庫から削除しますか？', '削除する'))) return;
        await store.deleteCatalog(it.id);
        flash('削除しました。'); go('catalog');
      });
    },
  };
}
