// 請求書の詳細（今までの invoice.php と同じ画面）
import { store } from '../store.js';
import { go, setBiz } from '../nav.js';
import { needsCheck, isReconcile, statusBadge, setInvoiceStatus, refreshPaymentStatus, fillTemplate, publicUrl, STATUS_LABELS } from '../logic.js';
import { renderInvoiceDoc, fitDocs } from '../doc.js';
import { sendMail } from '../mailer.js';
import { staffList } from './settings.js';
import { h, yen, nf, nl2br, jdate, jdatetime, slashDate, today, nowUtc, isYmd, num, randomToken } from '../util.js';
import { flash, showFlash, confirmBox } from '../ui.js';

export function detailPage(id) {
  const inv = store.invoiceFull(id);
  if (!inv) return null;
  const IB = store.bizOf(inv.business_id);
  const irec = isReconcile(IB);
  const iword = irec ? '入金予定' : '請求書';
  const items = inv.items || [];
  const payments = [...(inv.payments || [])].sort((a, b) => (a.paid_date > b.paid_date ? 1 : -1));
  const events = [...(inv.events || [])].reverse();
  const url = publicUrl(inv);
  const remain = Number(inv.total) - Number(inv.paid_amount || 0);
  const statusChoices = irec ? { sent: '入金待ち', paid: '入金済み' } : { draft: '下書き', sent: '送付済み', opened: '開封済み', paid: '入金済み' };

  const html = `
<div class="head-row">
  <div>
    <p class="crumb"><a href="#list" data-biz="${IB.id}">${h(IB.name)}の${iword}</a> ›</p>
    <h1>${h(inv.number)} ${statusBadge(inv)}</h1>
    <p class="muted">${h(inv.client_name)} ／ ${yen(inv.total)} ／ 期限 ${h(jdate(inv.due_date))}</p>
  </div>
  <div class="btns">
    <a class="btn" href="#edit-${id}">編集</a>
    <a class="btn" href="#print-${id}">PDFで保存</a>
    <a class="btn" href="#copy-${id}">複製して新規</a>
  </div>
</div>

${String(inv.check_note || '').trim() !== '' ? (needsCheck(inv) ? `
<section class="card remark-box">
  <h2 style="margin-top:0">PDFの備考あり・要確認 <span class="badge warn">送る前に目で確認してください</span></h2>
  <p class="small">シービーエムの請求書の備考に、次の記載がありました。この請求書の品目・単価・金額が、備考のとおりになっているか確かめてください。</p>
  <p class="remark-text">${nl2br(inv.check_note)}</p>
  <div class="btn-row"><button type="button" class="btn primary" id="checkDone">確認しました（内容は正しい）</button><a class="btn" href="#edit-${id}">編集して直す</a></div>
</section>` : `<p class="small muted remark-done">PDFの備考は確認済みです（${h(jdatetime(inv.checked_at))}${inv.checked_by ? '・' + h(inv.checked_by) : ''}）：${h(String(inv.check_note).replace(/\n/g, '／'))}</p>`) : ''}

${irec ? '' : `
<ol class="steps">
  <li class="${inv.sent_at ? 'done' : 'now'}"><b>送付</b><span>${inv.sent_at ? (inv.source_ref === 'invoy' ? 'invoyで送付 ' + h(slashDate(inv.issue_date)) : h(jdatetime(inv.sent_at))) : '未送付'}</span></li>
  <li class="${inv.opened_at ? 'done' : (inv.sent_at ? 'now' : '')}"><b>開封</b><span>${inv.opened_at ? h(jdatetime(inv.opened_at)) + '（' + Number(inv.open_count) + '回）' : (inv.source_ref === 'invoy' ? 'invoyで送付（記録なし）' : '未開封')}</span></li>
  <li class="${inv.status === 'paid' ? 'done' : (inv.status === 'partial' ? 'now' : '')}"><b>入金</b><span>${inv.status === 'paid' ? h(jdate(inv.paid_at)) : (inv.paid_amount ? '一部 ' + yen(inv.paid_amount) : '未入金')}</span></li>
</ol>`}

<div class="cols">
  <div class="col-main">
    ${irec ? `
      <section class="card expect">
        <h2>入金予定の内容</h2>
        <dl class="kv">
          <div><dt>取引先</dt><dd>${h(inv.client_name)}${inv.payer_kana ? '<span class="muted small">（振込名義 ' + h(inv.payer_kana) + '）</span>' : ''}</dd></div>
          <div><dt>件名</dt><dd>${h(inv.title)}</dd></div>
          <div><dt>入金予定日</dt><dd>${h(jdate(inv.due_date))}</dd></div>
          <div><dt>金額</dt><dd class="big">${yen(inv.total)}</dd></div>
          <div><dt>入金済み</dt><dd>${yen(inv.paid_amount)}</dd></div>
        </dl>
        <table class="mini">${items.map((it) => `<tr><td>${h(it.name)}</td><td class="r">${nf(Math.round(it.qty * it.price))}</td></tr>`).join('')}</table>
        ${inv.notes ? `<p class="small muted mt">${nl2br(inv.notes)}</p>` : ''}
      </section>` : `<div class="preview">${renderInvoiceDoc(inv)}</div>`}
  </div>

  <aside class="col-side">
    ${inv.status !== 'paid' && !irec ? `
    <section class="card">
      <h2>${inv.sent_at ? 'もう一度メールで送る' : 'メールで送る'}</h2>
      <form id="sendForm">
        ${(() => { const st = staffList(); let last = ''; try { last = localStorage.getItem('grow-mgt-sender') || ''; } catch (e) { last = ''; }
          return st.length ? `<label>差し出し人（担当者）<select name="from">${st.map((x) => `<option value="${h(x.email)}"${x.email === last ? ' selected' : ''}>${h((x.name ? x.name + ' ' : '') + '<' + x.email + '>')}</option>`).join('')}</select></label>`
            : '<p class="small warn-text">差し出し人にする担当者が未登録です。<a href="#settings">設定</a>の「メール送信」で登録してください。</p>'; })()}
        <label>宛先<input type="email" name="to" value="${h(inv.client_email)}" required></label>
        <label>CC<input name="cc" value="${h(inv.client_cc)}"></label>
        <label>件名<input name="subject" value="${h(fillTemplate(store.setting('mail_subject'), inv))}"></label>
        <label>本文<textarea name="body" rows="12">${h(fillTemplate(store.setting('mail_body'), inv))}</textarea></label>
        <button class="btn primary wide">送信する</button>
      </form>
      ${!inv.sent_at ? `<button class="btn small wide mt" id="markSent">メール以外で送った（送付済みにする）</button>` : ''}
    </section>` : ''}

    ${!irec ? `
    <section class="card">
      <h2>請求書リンク</h2>
      <div class="copy"><input readonly value="${h(url)}" id="url"><button class="btn small" type="button" id="copyUrl">コピー</button></div>
      <p class="small muted">このリンクを開くと「開封済み」になります。${inv.status === 'draft' ? '下書きのうちは先方は開けません。' : ''}${store.isPreview ? '（先方の画面は、メール送信と一緒にこれから移します）' : ''}</p>
    </section>` : ''}

    <section class="card">
      <h2>入金</h2>
      ${payments.length ? `<table class="mini">${payments.map((p) => `
        <tr>
          <td>${h(slashDate(p.paid_date))}</td>
          <td class="r">${yen(p.amount)}</td>
          <td class="small muted">${p.source === 'csv' ? 'CSV' : '手入力'}</td>
          <td><button class="icon unpay" data-pid="${p.id}" title="取り消し">×</button></td>
        </tr>`).join('')}</table>` : ''}
      ${remain > 0 ? `
      <form class="inline-form" id="payForm">
        <label>入金日<input type="date" name="paid_date" value="${today()}"></label>
        <label>金額<input name="amount" value="${remain}" inputmode="numeric" class="r"></label>
        <button class="btn ok wide">入金済みにする</button>
      </form>
      <p class="small muted">銀行の明細CSVからまとめて消し込むときは<a href="#payments">入金照合</a>へ。</p>` : `<p class="ok-text">全額入金済みです。</p>`}
    </section>

    <section class="card">
      <h2>ステータスを変える</h2>
      <form class="status-form" id="statusForm">
        <select name="status">${Object.entries(statusChoices).map(([k, l]) => `<option value="${k}"${inv.status === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
        <label class="pd"${inv.status === 'paid' ? '' : ' hidden'}>入金日<input type="date" name="paid_date" value="${h(inv.paid_at || today())}"></label>
        <button class="btn small">変える</button>
      </form>
      <p class="small muted">入金済みから戻すと、入金の記録は消えます。</p>
    </section>

    <section class="card">
      <h2>履歴</h2>
      <ul class="timeline">${events.map((e) => `<li class="ev-${h(e.type)}"><time>${h(jdatetime(e.created_at))}</time>${h(e.detail)}</li>`).join('')}</ul>
    </section>

    <details class="danger-zone">
      <summary>その他の操作</summary>
      <form class="status-form" id="bizForm" style="margin-bottom:8px">
        <select name="business_id">${store.businesses().map((b) => `<option value="${b.id}"${b.id === IB.id ? ' selected' : ''}>${h(b.name)}</option>`).join('')}</select>
        <button class="btn small">事業を変える</button>
      </form>
      <button class="btn small" id="resetLink">リンクを作り直す</button>
      <button class="btn danger small" id="deleteInv">請求書を削除</button>
    </details>
  </aside>
</div>`;

  return {
    title: inv.number, active: 'list', html,
    mount(root) {
      const raw = store.invoice(id); // 保存するのは、取引先の情報を足す前の請求書そのもの
      const save = async (msg, type = 'ok') => { await store.saveInvoice(raw); flash(msg, type); go('invoice-' + id); };
      const on = (sel, ev, fn) => { const el = root.querySelector(sel); if (el) el.addEventListener(ev, fn); };
      fitDocs(root);

      root.querySelector('.crumb a').addEventListener('click', () => setBiz(IB.id));

      on('#sendForm', 'submit', async (e) => {
        e.preventDefault();
        const f = e.target, to = f.to.value.trim(), cc = f.cc.value.trim();
        if (needsCheck(raw)) { showFlash('この請求書は、PDFの備考の確認がまだです。上の黄色の枠で内容を確かめ、「確認しました」を押してから送ってください。', 'err'); return; }
        const from = f.from ? f.from.value : '';
        if (from === '') { showFlash('差し出し人にする担当者を、設定の「メール送信」で登録してください。', 'err'); return; }
        try { localStorage.setItem('grow-mgt-sender', from); } catch (err) { /* 覚えられなくても送れる */ }
        if (to === '') { showFlash('送付先メールアドレスを入力してください。', 'err'); return; }
        if (!(await confirmBox('この内容でメールを送信しますか？', '送信する'))) return;
        try {
          const r = await sendMail({ from, to, cc, subject: f.subject.value.trim(), body: f.body.value, invoice: inv });
          raw.sent_at = nowUtc();
          if (raw.status === 'draft') raw.status = 'sent';
          store.logEvent(raw, 'send', (r.simulated ? '（プレビュー：実際には送っていません）' : '') + 'メール送信：' + to + (cc ? '（CC ' + cc + '）' : '') + '／差し出し人 ' + from);
          await save(r.simulated ? 'プレビューのため、メールは実際には送っていません。送ったときと同じく「送付済み」にしました。' : '請求書をメールで送りました。', r.simulated ? 'warn' : 'ok');
        } catch (err) { showFlash(err.message, 'err'); }
      });
      on('#checkDone', 'click', async () => {
        raw.checked_at = nowUtc();
        raw.checked_by = store.backend.userEmail ? store.backend.userEmail() : '';
        store.logEvent(raw, 'edit', 'PDFの備考を確認した');
        await save('備考の確認を記録しました。');
      });
      on('#markSent', 'click', async () => {
        raw.sent_at = raw.sent_at || nowUtc();
        if (raw.status === 'draft') raw.status = 'sent';
        store.logEvent(raw, 'send', 'メール以外で送付済みにした');
        await save('送付済みにしました。リンクを先方に伝えてください。');
      });
      on('#copyUrl', 'click', async (e) => {
        try { await navigator.clipboard.writeText(root.querySelector('#url').value); e.target.textContent = 'コピーしました'; }
        catch (err) { root.querySelector('#url').select(); e.target.textContent = '選択しました'; }
      });
      on('#payForm', 'submit', async (e) => {
        e.preventDefault();
        const amount = Math.trunc(num(e.target.amount.value)), date = e.target.paid_date.value;
        if (amount <= 0 || !isYmd(date)) { showFlash('入金日と金額を入力してください。', 'err'); return; }
        raw.payments = raw.payments || [];
        raw.payments.push({ id: store.newId(), paid_date: date, amount, payer: '', source: 'manual', created_at: nowUtc() });
        if (raw.status === 'draft') raw.sent_at = raw.sent_at || nowUtc();
        refreshPaymentStatus(raw);
        store.logEvent(raw, 'pay', '入金を記録：' + yen(amount) + '（' + date + '）');
        await save('入金を記録しました。');
      });
      root.querySelectorAll('.unpay').forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmBox('この入金記録を取り消しますか？', '取り消す'))) return;
        raw.payments = (raw.payments || []).filter((p) => String(p.id) !== b.dataset.pid);
        refreshPaymentStatus(raw);
        store.logEvent(raw, 'unpay', '入金記録を取り消し');
        await save('入金記録を取り消しました。');
      }));
      const sf = root.querySelector('#statusForm');
      sf.status.addEventListener('change', () => { sf.querySelector('.pd').hidden = sf.status.value !== 'paid'; });
      sf.addEventListener('submit', async (e) => {
        e.preventDefault();
        const st = sf.status.value, pd = sf.paid_date.value;
        if (st === 'paid' && !(await confirmBox('入金済みにしますか？'))) return;
        setInvoiceStatus(raw, st, isYmd(pd) ? pd : null);
        await save('ステータスを「' + STATUS_LABELS[st] + '」に変えました。');
      });
      on('#bizForm', 'submit', async (e) => {
        e.preventDefault();
        const nb = Number(e.target.business_id.value), name = store.bizOf(nb).name;
        raw.business_id = nb;
        store.logEvent(raw, 'edit', '事業を「' + name + '」に変更');
        await save('事業を「' + name + '」に変えました。');
      });
      on('#resetLink', 'click', async () => {
        if (!(await confirmBox('リンクを作り直すと、送ったメールのリンクは開けなくなります。よろしいですか？', '作り直す'))) return;
        raw.token = randomToken();
        store.logEvent(raw, 'edit', '請求書リンクを作り直し（古いリンクは無効）');
        await save('リンクを作り直しました。古いリンクはもう開けません。');
      });
      on('#deleteInv', 'click', async () => {
        if (!(await confirmBox('この請求書を削除します。元に戻せません。よろしいですか？', '削除する'))) return;
        await store.deleteInvoice(id);
        flash('請求書を削除しました。'); go('list');
      });
    },
  };
}
