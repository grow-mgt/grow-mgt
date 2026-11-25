// シービーエムの請求書PDF（Excelから出力した、文字データのあるPDF）から明細を取り出す
// 読むもの：《〇〇薬局様分》の見出し、ご注文日・摘要・数量・単価・金額の行、小計、備考の「※1 お客様価格は￥…」
let pdfjsReady = null;
function loadPdfjs() {
  if (!pdfjsReady) {
    pdfjsReady = import('../vendor/pdfjs/pdf.min.js').then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.js', import.meta.url).href;
      return m;
    }).catch((e) => { pdfjsReady = null; throw new Error('PDFを読む部品を読み込めませんでした。ページを読み込み直して、もう一度お試しください。'); });
  }
  return pdfjsReady;
}

const half = (s) => String(s).replace(/[０-９，￥]/g, (c) => ({ '，': ',', '￥': '¥' }[c] || String.fromCharCode(c.charCodeAt(0) - 0xFEE0)));
const num = (s) => Number(half(s).replace(/[¥,\s]/g, ''));
const isNum = (s) => /^[\d,]+$/.test(half(s).trim());
const isYen = (s) => /^¥\s*[\d,]+$/.test(half(s).trim());

/** 1つのPDFを、行ごとの「セルの並び」にする：[[セル, セル, …], …]（上から順） */
async function pdfRows(buf) {
  const pdfjs = await loadPdfjs();
  let doc;
  try { doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise; }
  catch (e) { throw new Error('PDFを開けませんでした。ファイルが壊れていないか確かめてください。'); }
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const items = (await page.getTextContent()).items.filter((it) => it.str && it.str.trim() !== '')
      .map((it) => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0 }));
    items.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const lines = [];
    for (const it of items) {
      const last = lines[lines.length - 1];
      if (last && Math.abs(last.y - it.y) <= 3) last.items.push(it); else lines.push({ y: it.y, items: [it] });
    }
    for (const ln of lines) {
      ln.items.sort((a, b) => a.x - b.x);
      const cells = []; let cur = null, end = 0;
      for (const it of ln.items) {
        if (cur !== null && it.x - end <= 7) cur += (it.x - end > 1.5 ? ' ' : '') + it.s; // 近い文字は同じセル
        else { if (cur !== null) cells.push(cur.trim()); cur = it.s; }
        end = it.x + it.w;
      }
      if (cur !== null) cells.push(cur.trim());
      out.push(cells.filter((c) => c !== ''));
    }
  }
  return out;
}

/**
 * PDF（1つ〜複数。2枚目・3枚目に分かれていてもよい）から明細を取り出す。
 * files：[{ name, buf }]
 * 戻り値：{ lines:[{store,date,name,qty,cost,note?,cust_price?}], month:'2026-10'|'', invoiceNo, subtotal, sum, notes:[明細に付いた備考], general:[全体の備考], warnings:[文] }
 */
export async function parseCbmPdfs(files) {
  const docs = [];
  for (const f of files) {
    const rows = await pdfRows(f.buf);
    const text = rows.map((r) => r.join(' ')).join('\n');
    if (text.replace(/\s/g, '').length < 40) throw new Error(`「${f.name}」には文字データがありません（紙をスキャンしたPDFのようです）。シービーエムに、Excelから出力したPDFを送ってもらってください。`);
    docs.push({ name: f.name, rows, text, head: /請求\s*No/u.test(text) || /請\s*求\s*書/u.test(text), foot: /消費税/u.test(text) && /お振込先|合計/u.test(text) });
  }
  // 並べる順：請求書の1枚目 → 途中（ファイル名の番号順）→ 合計のある最後の1枚
  const rank = (d) => (d.head ? 0 : (d.foot ? 2 : 1));
  docs.sort((a, b) => (rank(a) - rank(b)) || a.name.localeCompare(b.name, 'ja', { numeric: true }));

  const all = docs.map((d) => d.text).join('\n');
  let m = /請求日\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/u.exec(half(all));
  const invYear = m ? Number(m[1]) : 0, invMonth = m ? Number(m[2]) : 0;
  const month = m ? `${m[1]}-${String(m[2]).padStart(2, '0')}` : '';
  m = /請求\s*No\.?\s*([0-9A-Za-z-]+)/u.exec(half(all));
  const invoiceNo = m ? m[1] : '';

  // 備考欄：「備考」の行から下に書いてある文を、すべて拾う
  const remarks = [];
  for (const d of docs) {
    const at = d.rows.findIndex((cells) => /^備\s*考/u.test(cells[0] || ''));
    if (at < 0) continue;
    for (const cells of d.rows.slice(at)) {
      const t = cells.join(' ').replace(/^備\s*考\s*/u, '').trim();
      if (t !== '') remarks.push(t);
    }
  }
  // 「※1」などの印が付いた備考は、同じ印の明細に結び付ける。「お客様価格は￥…」は、その金額を単価にする
  const marks = {}; const general = [];
  for (const r of remarks) {
    const ms = [...half(r).matchAll(/※\d+/gu)].map((x) => x[0]);
    if (!ms.length) { general.push(r); continue; }
    const pm = /お客様価格は\s*¥\s*([\d,]+)/u.exec(half(r));
    for (const mk of ms) marks[mk] = { text: r, price: pm && ms.length === 1 ? num(pm[1]) : null };
  }

  const lines = [], warnings = [];
  let store = null, subtotal = null;
  for (const d of docs) for (const cells of d.rows) {
    const joined = cells.join(' ');
    const h = /《\s*(.+?)\s*様分\s*》/u.exec(joined);
    if (h) { store = h[1].trim(); continue; }
    if (/小計/u.test(joined)) { // 「《小計》」はグループの小計。何も付かない「小計」が全体の税抜合計
      if (!/《\s*小計\s*》/u.test(joined)) { const y = cells.filter(isYen).pop(); if (y) subtotal = num(y); }
      continue;
    }
    if (cells.length < 4 || !isYen(cells[cells.length - 1]) || !isNum(cells[cells.length - 2]) || !isNum(cells[cells.length - 3])) continue;
    const amount = num(cells[cells.length - 1]), cost = num(cells[cells.length - 2]), qty = num(cells[cells.length - 3]);
    let head = half(cells.slice(0, cells.length - 3).join(' ')).trim(), date = '', mark = '';
    let mk = /^(※\d+)\s*/u.exec(head);
    if (mk) { mark = mk[1]; head = head.slice(mk[0].length); }
    const dm = /^(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*/u.exec(head);
    if (dm) {
      // 年は請求日から決める（請求の月より先の月は、前の年の注文）
      const mo = Number(dm[1]), y = invYear ? (mo > invMonth ? invYear - 1 : invYear) : 0;
      date = y ? `${y}-${String(mo).padStart(2, '0')}-${String(dm[2]).padStart(2, '0')}` : `${mo}月${Number(dm[2])}日`;
      head = head.slice(dm[0].length);
    }
    // 品名は元の文字のまま使う（先頭の日付・印だけ外す）
    const rawHead = cells.slice(0, cells.length - 3).join(' ').trim();
    const name = rawHead.replace(/^(※[\d０-９]+)?\s*([\d０-９]{1,2}\s*月\s*[\d０-９]{1,2}\s*日)?\s*/u, '').trim() || head;
    if (!store) { warnings.push(`卸先の見出しより前に明細がありました：${name}`); continue; }
    if (name === '' || qty <= 0) continue;
    if (qty * cost !== amount) warnings.push(`「${store}」の「${name}」は、数量×単価（${qty}×${cost}）と金額（${amount}）が合いません。`);
    const line = { store, date, name, qty, cost };
    if (mark && marks[mark]) { line.note = marks[mark].text; if (marks[mark].price != null) line.cust_price = marks[mark].price; marks[mark].used = true; }
    else if (mark) line.note = mark + '（備考欄に説明が見つかりません）';
    lines.push(line);
  }
  if (!lines.length) throw new Error('明細の行を見つけられませんでした。シービーエムの請求書のPDFか確かめてください。');
  const sum = lines.reduce((a, l) => a + l.qty * l.cost, 0);
  // どの明細にも結び付かなかった備考は「全体の備考」として、その月の請求書すべてで確認してもらう
  for (const [mk, v] of Object.entries(marks)) if (!v.used) general.push(v.text);
  const notes = lines.filter((l) => l.note).map((l) => `「${l.store}」の「${l.name}」：${l.note}`);
  return { lines, month, invoiceNo, subtotal, sum, notes, general, remarks, warnings, files: docs.map((d) => d.name) };
}
