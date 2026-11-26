// 卸先別の年間管理表（今までのスプレッドシート「卸先別_年間管理表」と同じ形）
import { store } from '../store.js';
import { go } from '../nav.js';
import { h, nf, today } from '../util.js';
import { flash, showFlash } from '../ui.js';
import { exportCsv, mailCsv } from '../export.js';
import { buildKanri, kanriTable, kanriProfit, linesTable, parseAnnual, importAnnual, setManual, setAlias, ymLabel, tabYm, inTax, DEFAULT_GROUP } from '../kanri-logic.js';

const sel = { fy: 0, ym: '' };
const HOW = { guess: '名前が似ているので、この行に入れています（要確認）', none: '管理表に同じ名前の行がありません（新しい行として下に出しています）' };

export function kanriPage() {
  const td = today();
  const fyNow = Number(td.slice(5, 7)) >= 4 ? Number(td.slice(0, 4)) : Number(td.slice(0, 4)) - 1;
  const fy = sel.fy || fyNow;
  const k = buildKanri(fy);
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const tabs = [...new Set(store.db.cbmLines.map((l) => l.tab))];
  const tabOf = (ym) => tabs.find((t) => tabYm(t) === ym) || '';
  if (sel.ym && !k.months.includes(sel.ym)) sel.ym = '';
  const curTab = sel.ym ? tabOf(sel.ym) : '';
  const groupNames = [...new Set(k.groups.map((g) => g.name).concat([DEFAULT_GROUP]))];
  const empty = !k.groups.length;

  const num = (v) => `<td class="r${v ? '' : ' zero'}">${v ? nf(v) : '-'}</td>`;
  const rowCells = (r) => r.vals.map((v) => num(inTax(v))).join('');
  const totalCells = (taxes) => taxes.map((v) => `<td class="r">${v ? nf(v) : '-'}</td>`).join('');
  const pf = kanriProfit(k);
  const pct = (v) => (v == null ? '-' : v.toFixed(1) + '%');

  const html = `
<div class="head-row">
  <h1>年次集計 <span class="muted small">${fy}年度（${fy}年4月〜${fy + 1}年3月）・CBM</span> <span class="badge warn" style="font-size:13px">税込表示</span></h1>
  <div class="btns">
    <button class="btn small" data-fy="${fy - 1}">← ${fy - 1}年度</button>
    <button class="btn small" data-fy="${fy + 1}">${fy + 1}年度 →</button>
    <button class="btn small" id="kCsv"${empty ? ' disabled' : ''}>${store.isPreview ? '表をコピーする' : 'CSVで書き出す'}</button>
    <button class="btn small" id="kMail"${empty ? ' disabled' : ''}>CSVをメールで送る</button>
  </div>
</div>
<p class="small muted">卸先ごとの金額は、CBMからの仕入れ（明細の 数量×単価 を卸先ごとに足したもの・税込）です。請求書を手で直すと、明細とこの表にも反映されます。下の「売上」は、CBMの請求書（下書きを除く）を件名の「◯月分」で集計したものです。</p>

${k.noRows && !empty ? '<div class="flash warn" style="position:static">今までのスプレッドシートの年間管理表を、まだ取り込んでいません。いまは読み込み済みの明細の月だけが出ています。下の「スプレッドシートの年間管理表を取り込む」から取り込むと、卸先の並び・グループ・過去の月の金額が入ります。</div>' : ''}
${k.pending.length ? `
<section class="card form">
  <h2 style="margin-top:0">卸先名の確認 <span class="badge warn">${k.pending.length}件</span></h2>
  <p class="small muted">明細の卸先名が、管理表の行の名前とちがっています。どの行に入れるかを選んでください（読み取りまちがいの名前も、ここで正しい行に寄せられます）。</p>
  <table class="list"><thead><tr><th>明細の卸先名</th><th>いまの扱い</th><th>入れる行</th><th></th></tr></thead><tbody>
  ${k.pending.map((p, i) => `<tr>
    <td>${h(p.name)}</td><td class="small muted">${HOW[p.how]}</td>
    <td><select data-alias="${i}"><option value="">（選んでください）</option>${k.rowNames.map((n) => `<option value="${h(n)}"${p.to === n ? ' selected' : ''}>${h(n)}</option>`).join('')}<option value="__new">この名前で新しい行を作る</option></select>
        <select data-alias-group="${i}" hidden>${groupNames.map((g) => `<option${g === DEFAULT_GROUP ? ' selected' : ''}>${h(g)}</option>`).join('')}</select></td>
    <td><button class="btn small" data-alias-save="${i}">決定</button></td></tr>`).join('')}
  </tbody></table>
</section>` : ''}

${empty ? '<div class="empty">年次集計はまだ空です。下の「スプレッドシートの年間管理表を取り込む」から今までの表を入れるか、<a href="#cbm">CBMの明細</a>を読み込んでください。</div>' : `
<div class="table-wrap">
<table class="list report kanri">
  <thead>
    <tr><th>卸先名 <span class="badge b-sheet">金額はすべて税込</span></th>${k.months.map((ym) => `<th class="r">${tabOf(ym) ? `<a href="#kanri" data-ym="${ym}">${ymLabel(ym)}</a>` : ymLabel(ym)}</th>`).join('')}<th class="r">年間合計（税込）</th></tr>
  </thead>
  <tbody>
  ${k.groups.map((g) => g.rows.map((r) => `
    <tr><td>${h(r.name)}${r.isNew ? ' <span class="badge warn">新しい卸先</span>' : ''}</td>${rowCells(r)}<td class="r b">${nf(sum(r.vals.map(inTax)))}</td></tr>`).join('') + `
    <tr class="r-total"><td>${h(g.name)} 小計（税込）</td>${totalCells(g.subTax)}<td class="r">${nf(sum(g.subTax))}</td></tr>`).join('')}
    <tr class="r-total"><td>仕入 合計（税込）</td>${totalCells(k.totalTax)}<td class="r">${nf(sum(k.totalTax))}</td></tr>
    <tr class="r-top"><td><b>売上（税込）</b></td>${totalCells(pf.sales)}<td class="r b">${nf(pf.salesYear)}</td></tr>
    <tr><td><b>粗利（税込）</b></td>${pf.per.map((x) => `<td class="r${x.profit == null ? ' zero' : (x.profit < 0 ? ' warn' : '')}">${x.profit == null ? '-' : nf(x.profit)}</td>`).join('')}<td class="r b">${pf.year.profit == null ? '-' : nf(pf.year.profit)}</td></tr>
    <tr><td><b>利益率</b></td>${pf.per.map((x) => `<td class="r${x.rate == null ? ' zero' : ''}">${pct(x.rate)}</td>`).join('')}<td class="r b">${pct(pf.year.rate)}</td></tr>
  </tbody>
</table>
</div>`}

${curTab ? (() => { const t = linesTable(curTab); return `
<div class="head-row" style="margin-top:22px">
  <h2 style="margin:0">${ymLabel(sel.ym)}分 明細 <span class="muted small">${t.length - 1}行・金額は税抜</span></h2>
  <div class="btns"><button class="btn small" id="kLinesCsv">${store.isPreview ? '明細をコピーする' : '明細をCSVで書き出す'}</button><a class="btn small" href="#kanri" data-ym="">閉じる</a></div>
</div>
<div class="table-wrap"><table class="list report">
  <thead><tr>${t[0].map((c, i) => `<th${i >= 3 ? ' class="r"' : ''}>${h(c)}</th>`).join('')}</tr></thead>
  <tbody>${t.slice(1).map((r) => `<tr><td>${h(r[0])}</td><td>${h(r[1])}</td><td>${h(r[2])}</td><td class="r">${nf(r[3])}</td><td class="r">${r[4] === '' ? '-' : nf(r[4])}</td><td class="r">${nf(r[5])}</td></tr>`).join('')}</tbody>
</table></div>`; })() : (tabs.length && !empty ? '<p class="small muted mt">「粗利」は 売上 − 仕入、「利益率」は 粗利 ÷ 売上 です（どちらも税込）。売上か仕入のどちらかがまだない月は「-」にして、年間の粗利にも入れていません。月の名前を押すと、その月の明細が下に出ます。</p>' : '')}

<details class="card form" style="margin-top:22px"${empty || k.noRows ? ' open' : ''}>
  <summary><b>スプレッドシートの年間管理表を取り込む</b> <span class="small muted">今までの表の金額を、まとめて入れます</span></summary>
  <p class="small muted">スプレッドシート「卸先別_年間管理表」の「年間管理表」タブを開き、見出し（卸先グループ・卸先名・2026年4月…）の行から総合計の行までを選んでコピーし、下に貼り付けてください。卸先の並びとグループ、明細のない月の税抜金額を取り込みます（税込・小計・合計はアプリが計算します）。</p>
  <textarea id="kPaste" rows="6" placeholder="ここに貼り付け"></textarea>
  <div class="actions"><button class="btn primary" id="kImport">取り込む</button></div>
</details>`;

  return {
    title: '年次集計', active: 'kanri', html,
    mount(root) {
      const fileBase = `年次集計_${fy}年度`;
      root.querySelectorAll('[data-fy]').forEach((b) => b.addEventListener('click', () => { sel.fy = Number(b.dataset.fy); sel.ym = ''; go('kanri'); }));
      root.querySelectorAll('a[data-ym]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); sel.ym = a.dataset.ym; go('kanri'); }));
      const on = (id, fn) => { const el = root.querySelector(id); if (el) el.addEventListener('click', fn); };
      on('#kCsv', () => exportCsv(kanriTable(k), fileBase + '.csv'));
      on('#kLinesCsv', () => exportCsv(linesTable(curTab), `CBM明細_${ymLabel(sel.ym)}.csv`));
      on('#kMail', () => {
        const files = [{ name: fileBase + '.csv', table: kanriTable(k) }];
        if (curTab) files.push({ name: `CBM明細_${ymLabel(sel.ym)}.csv`, table: linesTable(curTab) });
        mailCsv({ title: '年次集計をメールで送る', files, subject: `【${store.setting('company') || 'GROW'}】年次集計（${fy}年度）`,
          body: `お疲れさまです。\n\n年次集計（${fy}年度）をCSVでお送りします。\nご確認をお願いいたします。` });
      });
      // 明細のない月：黄色の欄に入れた金額を保存する
      root.querySelectorAll('.kanri-in').forEach((inp) => inp.addEventListener('change', async () => {
        const raw = inp.value.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[,¥￥円\s]/g, '');
        if (raw !== '' && !/^\d+$/.test(raw)) { showFlash('金額は数字で入れてください。', 'err'); return; }
        await setManual(inp.dataset.ym, inp.dataset.name, raw === '' ? 0 : Number(raw));
        go('kanri');
      }));
      // 卸先名の対応
      root.querySelectorAll('[data-alias]').forEach((s) => s.addEventListener('change', () => { root.querySelector(`[data-alias-group="${s.dataset.alias}"]`).hidden = s.value !== '__new'; }));
      root.querySelectorAll('[data-alias-save]').forEach((b) => b.addEventListener('click', async () => {
        const i = b.dataset.aliasSave, p = k.pending[Number(i)];
        const v = root.querySelector(`[data-alias="${i}"]`).value;
        if (v === '') { showFlash('入れる行を選んでください。', 'err'); return; }
        await setAlias(p.name, v === '__new' ? p.name : v, root.querySelector(`[data-alias-group="${i}"]`).value);
        flash(v === '__new' ? `「${p.name}」を新しい行として足しました。` : `「${p.name}」を「${v}」の行に入れました。`); go('kanri');
      }));
      on('#kImport', async () => {
        try {
          const r = await importAnnual(parseAnnual(root.querySelector('#kPaste').value));
          flash(`年間管理表を取り込みました（卸先${r.rows}件${r.added ? '・うち新しい行' + r.added + '件' : ''}、${r.months}か月分の金額）。`); go('kanri');
        } catch (err) { showFlash(err.message, 'err'); }
      });
    },
  };
}
