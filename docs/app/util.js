// 表示用の小さな部品（今までのアプリの h / yen / jdate などと同じ動き）
export const h = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const nf = (n) => Math.round(Number(n) || 0).toLocaleString('ja-JP');
export const yen = (n) => '¥' + nf(n);
export const nl2br = (s) => h(s).replace(/\n/g, '<br>');

const pad = (n) => String(n).padStart(2, '0');

// 日本時間の「今日」（yyyy-mm-dd）
export function today() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p; // en-CA は yyyy-mm-dd
}
// 記録用の日時（世界標準時の "yyyy-mm-dd hh:mm:ss"。今までのデータと同じ形）
export function nowUtc() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}
const ymdParts = (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; };
export function jdate(d) { const p = ymdParts(d); return p ? `${p[0]}年${p[1]}月${p[2]}日` : ''; }
export function ymdJp(d) { const p = ymdParts(d); return p ? `${p[0]}年${pad(p[1])}月${pad(p[2])}日` : ''; }
export function slashDate(d) { const p = ymdParts(d); return p ? `${p[0]}/${pad(p[1])}/${pad(p[2])}` : ''; }
// 世界標準時で記録した日時を、日本時間の yyyy/mm/dd hh:mm にする
export function jdatetime(d) {
  if (!d) return '';
  const t = new Date(String(d).replace(' ', 'T') + 'Z');
  if (isNaN(t)) return '';
  const f = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(t);
  const g = (k) => f.find((x) => x.type === k).value;
  return `${g('year')}/${g('month')}/${g('day')} ${g('hour')}:${g('minute')}`;
}
export function addDays(ymd, n) {
  const p = ymdParts(ymd); const t = new Date(Date.UTC(p[0], p[1] - 1, p[2] + n));
  return t.toISOString().slice(0, 10);
}
// 翌月の末日
export function endOfNextMonth(ymd) {
  const p = ymdParts(ymd); const t = new Date(Date.UTC(p[0], p[1] + 1, 0));
  return t.toISOString().slice(0, 10);
}
export const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
export const num = (v) => parseFloat(String(v == null ? '' : v).replace(/[,¥￥円\s]/g, '')) || 0;
export function randomToken() {
  const a = new Uint8Array(20); crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
// 「1,200円」「１２００」などを数字にする。空や数字でないものは null
export function toIntOrNull(v) {
  let s = String(v == null ? '' : v).trim().replace(/[０-９．－]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  s = s.replace(/[,¥￥円\s]/g, '');
  if (s === '' || isNaN(Number(s))) return null;
  return Math.round(Number(s));
}
export const isEmail = (s) => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(String(s));
