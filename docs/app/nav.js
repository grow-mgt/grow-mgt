// 画面の行き先と、今見ている事業・絞り込みの状態
export const state = { biz: 1, filter: 'all', q: '' };
// 画面をまたいで一度だけ渡す値（保存はしない）
export const once = { backToNew: false, newClient: 0, matrixGroup: '', matrixAll: false };
try { const s = JSON.parse(sessionStorage.getItem('grow-mgt-state') || 'null'); if (s) Object.assign(state, s); } catch (e) { /* 覚えていなくても動く */ }
const remember = () => { try { sessionStorage.setItem('grow-mgt-state', JSON.stringify(state)); } catch (e) { /* 何もしない */ } };

// 画面の行き先は「#invoice-98」のような名前で表す
export function go(name) {
  if (location.hash === '#' + name) window.dispatchEvent(new Event('app:render')); else location.hash = name;
}
export function setBiz(b) { state.biz = Number(b); state.filter = 'all'; state.q = ''; remember(); }
export function setFilter(f, q) { state.filter = f; state.q = q; remember(); }
