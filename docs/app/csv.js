// CSVファイルを読む（Shift_JISのままでも読める）
export function decodeBytes(buf) {
  let bytes = new Uint8Array(buf);
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) bytes = bytes.subarray(3);
  for (const enc of ['utf-8', 'shift_jis', 'euc-jp']) {
    try { return new TextDecoder(enc, { fatal: true }).decode(bytes); } catch (e) { /* 次の文字コードを試す */ }
  }
  return new TextDecoder('shift_jis').decode(bytes);
}
export function parseCsv(text) {
  if (text === '') throw new Error('ファイルが空です。');
  const first = text.split('\n')[0];
  const delim = (first.split('\t').length - 1) > (first.split(',').length - 1) ? '\t' : ',';
  const rows = []; let row = [], cur = '', q = false;
  const endRow = () => { row.push(cur); cur = ''; if (!(row.length === 1 && row[0] === '')) rows.push(row.map((c) => c.trim())); row = []; };
  for (let i = 0; i < text.length && rows.length <= 3000; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === delim) { row.push(cur); cur = ''; }
    else if (ch === '\n') endRow();
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length) endRow();
  if (!rows.length) throw new Error('CSVを読み取れませんでした。');
  return rows;
}
