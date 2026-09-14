import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

(() => {
  'use strict';

  const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
  const STRATEGIES = ['盤整突破', '沿線上行', '族群效應', '回調築底', '處置操作', '其他'];
  const ENTRY_ACTIONS = new Set(['買進', '加碼']);
  const EXIT_ACTIONS = new Set(['減碼', '賣出', '加碼轉賣出']);

  // 資金加權累計報酬曲線／各月份資金加權報酬：只看 7/1 起的資料，6 月不計入、7/1 為新的 0% 基準點
  const CHART_START_DATE = '2026-07-01';

  // 總資金基準：8/1 起改為 70 萬，之前的紀錄維持 100 萬
  const CAPITAL_AUG_CUTOFF = '2026-08-01';

  // ---- 供應鏈資料模型 ----
  // 節點是扁平陣列，用 parentIds（可多個上層）表達階層，不用巢狀樹狀結構，
  // 這樣同一個子產業（例如 PCB）未來若同時屬於多條供應鏈，只要在 parentIds 多加一個 id 即可，不需要複製節點。
  // 公司與節點是多對多關聯（companyLinks），一家公司可以同時掛在多個供應鏈節點上。
  const STAGE_LABEL = { upstream: '上游', midstream: '中游', downstream: '下游' };
  const DEFAULT_SUPPLY_CHAIN_NODES = [
    { id: 'ai', name: 'AI', parentIds: [], stage: null },
    { id: 'gpu', name: 'GPU', parentIds: ['ai'], stage: 'midstream' },
    { id: 'asic', name: 'ASIC', parentIds: ['ai'], stage: 'midstream' },
    { id: 'foundry', name: '晶圓代工', parentIds: ['ai'], stage: 'upstream' },
    { id: 'adv_packaging', name: '先進封裝', parentIds: ['ai'], stage: 'midstream' },
    { id: 'cowos', name: 'CoWoS', parentIds: ['adv_packaging'], stage: 'midstream' },
    { id: 'hbm', name: 'HBM', parentIds: ['adv_packaging'], stage: 'midstream' },
    { id: 'ai_server', name: 'AI Server', parentIds: ['ai'], stage: 'midstream' },
    { id: 'odm', name: 'ODM', parentIds: ['ai_server'], stage: 'midstream' },
    { id: 'pcb', name: 'PCB', parentIds: ['ai_server'], stage: 'upstream' },
    { id: 'ccl', name: 'CCL', parentIds: ['ai_server'], stage: 'upstream' },
    { id: 'power', name: '電源', parentIds: ['ai_server'], stage: 'upstream' },
    { id: 'cooling', name: '散熱', parentIds: ['ai_server'], stage: 'upstream' },
    { id: 'networking', name: 'Networking', parentIds: ['ai'], stage: 'midstream' },
    { id: 'switch', name: 'Switch', parentIds: ['networking'], stage: 'midstream' },
    { id: 'optical', name: 'Optical / CPO', parentIds: ['networking'], stage: 'midstream' },
  ];

  // 台灣櫃買指數（TPEx OTC Index）每日收盤，作為資金加權報酬曲線的對照基準。
  // 全部由使用者逐日核對提供，並與證交所 TPEx OpenAPI 官方數字（8/3–8/12）交叉比對完全吻合（誤差在0.03內）。
  // 6/19（端午節）、7/10 為休市日，已從交易日序列中排除。
  // 這份資料不會自動即時更新，需要之後手動補充最新交易日的收盤值。
  const OTC_INDEX_CLOSE = {
    '2026-06-01': 446.02, '2026-06-02': 440.64, '2026-06-03': 446.82, '2026-06-04': 440.1,
    '2026-06-05': 431.07, '2026-06-08': 412.57, '2026-06-09': 424.71, '2026-06-10': 405.91,
    '2026-06-11': 407.09, '2026-06-12': 419.72, '2026-06-15': 429.37, '2026-06-16': 430.26,
    '2026-06-17': 433.34, '2026-06-18': 447.06, '2026-06-22': 459.56, '2026-06-23': 440.81,
    '2026-06-24': 442.09, '2026-06-25': 439.84, '2026-06-26': 415.26, '2026-06-29': 412.93,
    '2026-06-30': 426.97, '2026-07-01': 431.23, '2026-07-02': 439.51, '2026-07-03': 445.38,
    '2026-07-06': 439.8, '2026-07-07': 419.47, '2026-07-08': 421.39, '2026-07-09': 424.99,
    '2026-07-13': 419.9, '2026-07-14': 407.41, '2026-07-15': 416.41, '2026-07-16': 407.01,
    '2026-07-17': 378.44, '2026-07-20': 368.53, '2026-07-21': 381.96, '2026-07-22': 395.18,
    '2026-07-23': 392.11, '2026-07-24': 377.63, '2026-07-27': 378.09, '2026-07-28': 352.42,
    '2026-07-29': 334.24, '2026-07-30': 326.23, '2026-07-31': 347.85, '2026-08-03': 362.86,
    '2026-08-04': 375.03, '2026-08-05': 383.75, '2026-08-06': 391.37, '2026-08-07': 384.19,
    '2026-08-10': 391.61, '2026-08-11': 391.68, '2026-08-12': 402.02, '2026-08-13': 406.12,
    '2026-08-14': 400.95, '2026-08-17': 398.32, '2026-08-18': 390.83,
    '2026-08-19': 384.79, '2026-08-20': 389.96, '2026-08-21': 387.27, '2026-08-24': 386.10,
    '2026-08-25': 389.41, '2026-08-26': 395.66, '2026-08-27': 400.38, '2026-08-28': 402.83,
    '2026-08-31': 401.70, '2026-09-01': 410.77, '2026-09-02': 406.96, '2026-09-03': 395.25,
    '2026-09-04': 402.48, '2026-09-07': 409.33, '2026-09-08': 407.19, '2026-09-09': 408.09,
    '2026-09-10': 405.24,
  };
  // 各月 OTC 報酬率：該月最後一個交易日收盤 相對 前一月最後一個交易日收盤（第一個月則相對該月第一筆資料）
  function computeOtcMonthlyReturns() {
    const dates = Object.keys(OTC_INDEX_CLOSE).sort();
    if (!dates.length) return {};
    const lastDateOfMonth = {};
    const firstDateOfMonth = {};
    dates.forEach(d => {
      const m = d.slice(0, 7);
      if (!firstDateOfMonth[m]) firstDateOfMonth[m] = d;
      lastDateOfMonth[m] = d;
    });
    const months = Object.keys(lastDateOfMonth).sort();
    const result = {};
    months.forEach((m, i) => {
      const endClose = OTC_INDEX_CLOSE[lastDateOfMonth[m]];
      const startClose = i === 0 ? OTC_INDEX_CLOSE[firstDateOfMonth[m]] : OTC_INDEX_CLOSE[lastDateOfMonth[months[i - 1]]];
      result[m] = (endClose / startClose - 1) * 100;
    });
    return result;
  }

  function computeOtcSeries(binStart, binDays, startDate) {
    let dates = Object.keys(OTC_INDEX_CLOSE).sort();
    if (startDate) dates = dates.filter(d => d >= startDate);
    if (!dates.length) return [];
    const base = OTC_INDEX_CLOSE[dates[0]];
    const raw = dates.map(d => ({ date: d, ts: parseDateTs(d), value: (OTC_INDEX_CLOSE[d] / base - 1) * 100 }));
    if (!binDays) return raw;
    // 跟個人資金加權曲線用同一個 binStart 對齊分桶（每桶取區間內最後一筆），
    // 這樣兩條線的資料點會落在同一批 3 天區間上，視覺上才對得齊。
    const binMs = binDays * 24 * 60 * 60 * 1000;
    const bins = new Map();
    raw.forEach(p => {
      const idx = Math.floor((p.ts - binStart) / binMs);
      bins.set(idx, p);
    });
    return [...bins.keys()].sort((a, b) => a - b).map(k => ({ ...bins.get(k), binTs: binStart + k * binMs }));
  }

  // ---------- state ----------
  let state = { trades: [], diary: [] };
  let currentUser = null;

  const syncStatusEl = document.getElementById('sync-status');
  function setSyncStatus(text) { if (syncStatusEl) syncStatusEl.textContent = text; }

  // Back-compat: imported/older JSON may hold the previous entry/exit-price schema.
  function migrate(data) {
    if (!Array.isArray(data.trades)) return { trades: [], diary: [] };
    data.trades = data.trades.map(t => {
      if (t.date) return t; // already new schema
      return {
        id: t.id, date: t.entryDate || '', symbol: t.symbol, name: t.name || '',
        action: t.side === 'short' ? '賣出' : '買進', strategy: STRATEGIES.includes(t.strategy) ? t.strategy : '其他',
        sector: '', positionPct: null, returnPct: t.pct ?? null, rating: '',
        reason: t.note || '', review: '', marketNote: '',
      };
    });
    if (!Array.isArray(data.diary)) data.diary = [];
    return data;
  }

  async function loadFromCloud(uid) {
    setSyncStatus('讀取中…');
    try {
      const snap = await getDoc(doc(db, 'journals', uid));
      state = snap.exists() ? migrate(snap.data()) : { trades: [], diary: [] };
      setSyncStatus('已同步');

      // 一次性清除：內容欄已從表單移除，順便清掉舊紀錄殘留的內容文字
      const hadContent = state.diary.some(d => d.content);
      if (hadContent) {
        state.diary = state.diary.map(d => ({ ...d, content: '' }));
        await save();
      }

      // 一次性換算：總資金基準從 140 萬改為 100 萬，把舊紀錄的資金佔比等比例放大（× 1.4），
      // 讓所有舊紀錄的資金佔比换算成「以 100 萬總資金為基準」的結果，之後新紀錄也一律用 100 萬計算。
      if (!state.capitalBase1M) {
        state.trades = state.trades.map(t =>
          t.positionPct != null ? { ...t, positionPct: Math.round(t.positionPct * 1.4 * 10) / 10 } : t
        );
        state.capitalBase1M = true;
        await save();
      }

      // 一次性換算：8 月份起總資金基準從 100 萬改為 70 萬，把 8 月起的舊紀錄資金佔比等比例放大（× 10/7），
      // 7 月以前的紀錄維持 100 萬基準不動。
      if (!state.capitalBase70kAug) {
        state.trades = state.trades.map(t =>
          t.positionPct != null && t.date >= CAPITAL_AUG_CUTOFF
            ? { ...t, positionPct: Math.round(t.positionPct * (10 / 7) * 10) / 10 }
            : t
        );
        state.capitalBase70kAug = true;
        await save();
      }

      // 一次性建立：供應鏈資料模型（節點 + 公司關聯），種子資料建立後完全開放編輯，不會再被覆蓋。
      if (!state.supplyChainSeeded) {
        state.supplyChainNodes = DEFAULT_SUPPLY_CHAIN_NODES.map(n => ({ ...n, parentIds: [...n.parentIds] }));
        state.companyLinks = [];
        state.supplyChainSeeded = true;
        await save();
      }
      if (!Array.isArray(state.supplyChainNodes)) state.supplyChainNodes = [];
      if (!Array.isArray(state.companyLinks)) state.companyLinks = [];
    } catch (e) {
      console.error('loadFromCloud failed', e);
      setSyncStatus('讀取失敗');
      alert('讀取雲端資料失敗，請檢查網路連線或 Firestore 設定。');
    }
    renderTrades(); renderStats();
  }

  async function save() {
    if (!currentUser) return;
    setSyncStatus('同步中…');
    try {
      await setDoc(doc(db, 'journals', currentUser.uid), state);
      setSyncStatus('已同步');
    } catch (e) {
      console.error('save failed', e);
      setSyncStatus('同步失敗');
      alert('儲存到雲端失敗，請檢查網路連線。');
    }
  }

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  // ---------- helpers ----------
  const fmtPct = (n, digits = 1) => n == null ? '–' : (n >= 0 ? '+' : '') + n.toFixed(digits) + '%';
  const isExitAction = (a) => EXIT_ACTIONS.has(a) || a === '當沖';

  function actionBadgeClass(a) {
    if (a === '當沖') return 'action-day';
    if (isExitAction(a)) return 'action-out';
    return 'action-in';
  }

  function sortedTrades() {
    return [...state.trades].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  }

  // ---------- tabs ----------
  document.querySelectorAll('.tab').forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
      tabBtn.classList.add('active'); tabBtn.setAttribute('aria-selected', 'true');
      const target = tabBtn.dataset.tab;
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.getElementById('panel-' + target).classList.add('active');
      if (target === 'stats') renderStats();
      if (target === 'chain') { renderChainTree(); renderChainDetail(); }
    });
  });

  // ================= TRADES =================
  const tbody = document.getElementById('trade-tbody');
  const tradesEmpty = document.getElementById('trades-empty');
  const filterAction = document.getElementById('filter-action');
  const filterStrategy = document.getElementById('filter-strategy');
  const filterSearch = document.getElementById('filter-search');

  [filterAction, filterStrategy, filterSearch].forEach(el => el.addEventListener('input', renderTrades));

  function renderTrades() {
    const list = sortedTrades().filter(t => {
      if (filterAction.value !== 'all' && t.action !== filterAction.value) return false;
      if (filterStrategy.value !== 'all' && t.strategy !== filterStrategy.value) return false;
      const q = filterSearch.value.trim().toLowerCase();
      if (q && !(t.symbol.toLowerCase().includes(q) || (t.name || '').toLowerCase().includes(q) || (t.sector || '').toLowerCase().includes(q))) return false;
      return true;
    });

    tbody.innerHTML = '';
    tradesEmpty.style.display = list.length ? 'none' : 'block';

    for (const t of list) {
      const tr = document.createElement('tr');
      tr.dataset.id = t.id;
      if (t.marked) tr.classList.add('marked-row');
      const pnlClass = t.returnPct == null ? 'pnl-zero' : t.returnPct > 0 ? 'pnl-pos' : t.returnPct < 0 ? 'pnl-neg' : 'pnl-zero';
      const ratingHtml = t.rating ? `<span class="rating-badge rating-${t.rating}">${t.rating}</span>` : '–';
      tr.innerHTML = `
        <td class="mark-col"><input type="checkbox" class="mark-checkbox" data-mark="${t.id}" ${t.marked ? 'checked' : ''}></td>
        <td class="num">${t.date}</td>
        <td><strong>${escapeHtml(t.symbol)}</strong> ${t.name ? `<span style="color:var(--text-muted)">${escapeHtml(t.name)}</span>` : ''}</td>
        <td><span class="badge ${actionBadgeClass(t.action)}">${escapeHtml(t.action)}</span></td>
        <td>${escapeHtml(t.strategy)}</td>
        <td>${escapeHtml(t.sector || '–')}</td>
        <td class="num">${t.positionPct == null ? '–' : t.positionPct.toFixed(1) + '%'}</td>
        <td class="num ${pnlClass}">${fmtPct(t.returnPct, 2)}</td>
        <td>${ratingHtml}</td>
        <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)">${escapeHtml(t.reason || '')}</td>
        <td><button class="row-del" data-del="${t.id}" title="刪除">✕</button></td>
      `;
      tr.addEventListener('click', (e) => {
        if (e.target.closest('[data-del]') || e.target.closest('[data-mark]')) return;
        openTradeModal(t);
      });
      tbody.appendChild(tr);
      tr.querySelector('[data-del]').addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`確定刪除 ${t.symbol} 這筆交易紀錄？`)) {
          state.trades = state.trades.filter(x => x.id !== t.id);
          save(); renderTrades();
        }
      });
      tr.querySelector('[data-mark]').addEventListener('click', (e) => {
        e.stopPropagation();
        t.marked = e.target.checked;
        tr.classList.toggle('marked-row', t.marked);
        save();
      });
    }

    updateSymbolDatalist();
  }

  // ---- 股票代號自動帶出名稱/族群（依最近一筆同代號的紀錄） ----
  function symbolLookup() {
    const map = new Map();
    for (const t of sortedTrades()) { // 由新到舊，先出現的（較新）優先，不覆蓋
      if (!map.has(t.symbol)) map.set(t.symbol, { name: t.name || '', sector: t.sector || '' });
    }
    return map;
  }

  function updateSymbolDatalist() {
    const datalist = document.getElementById('symbol-datalist');
    const map = symbolLookup();
    datalist.innerHTML = [...map.entries()]
      .map(([symbol, info]) => `<option value="${escapeHtml(symbol)}">${escapeHtml(info.name)}</option>`)
      .join('');
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---- trade modal ----
  const tradeModal = document.getElementById('trade-modal');
  const tradeForm = document.getElementById('trade-form');
  const btnDeleteTrade = document.getElementById('btn-delete-trade');

  document.getElementById('btn-add-trade').addEventListener('click', () => openTradeModal(null));

  // 打過的股票代號，自動帶出名稱與族群
  document.getElementById('f-symbol').addEventListener('input', (e) => {
    const info = symbolLookup().get(e.target.value.trim());
    if (!info) return;
    const nameEl = document.getElementById('f-name');
    const sectorEl = document.getElementById('f-sector');
    if (!nameEl.value) nameEl.value = info.name;
    if (!sectorEl.value) sectorEl.value = info.sector;
    maybeAutofillEntryPrice();
  });

  // 減碼／賣出時，自動帶入該股票最近一筆買進／加碼的價格，只需要再輸入股數
  function lastEntryPrice(symbol) {
    for (const t of sortedTrades()) {
      if (t.symbol === symbol && ENTRY_ACTIONS.has(t.action) && t.price != null) return t.price;
    }
    return null;
  }
  function maybeAutofillEntryPrice() {
    const action = document.getElementById('f-action').value;
    if (action !== '減碼' && action !== '賣出') return;
    const priceEl = document.getElementById('f-calc-price');
    if (priceEl.value) return; // 使用者已手動填過，不覆蓋
    const symbol = document.getElementById('f-symbol').value.trim();
    if (!symbol) return;
    const price = lastEntryPrice(symbol);
    if (price != null) priceEl.value = price;
  }
  document.getElementById('f-action').addEventListener('change', maybeAutofillEntryPrice);

  // 交易價格 × 股數 ÷ 總資本，自動算出資金佔比（會儲存價格，供之後減碼/賣出時自動帶入）
  // 總資本會依這筆交易的日期自動切換：8/1 起用 70 萬，之前用 100 萬
  function recalcPositionPct() {
    const price = parseFloat(document.getElementById('f-calc-price').value);
    const shares = parseFloat(document.getElementById('f-calc-shares').value);
    if (!price || !shares) return;
    const date = document.getElementById('f-date').value;
    const totalCapital = date >= CAPITAL_AUG_CUTOFF ? 700000 : 1000000;
    const pct = (price * shares / totalCapital) * 100;
    document.getElementById('f-position-pct').value = pct.toFixed(1);
  }
  document.getElementById('f-calc-price').addEventListener('input', recalcPositionPct);
  document.getElementById('f-calc-shares').addEventListener('input', recalcPositionPct);
  document.getElementById('f-date').addEventListener('change', recalcPositionPct);

  // 資金加權貢獻 = 資金佔比 × 報酬率 ÷ 100，自動計算，也可手動覆蓋
  function recalcContrib() {
    const pos = parseFloat(document.getElementById('f-position-pct').value);
    const ret = parseFloat(document.getElementById('f-return-pct').value);
    if (isNaN(pos) || isNaN(ret)) return;
    document.getElementById('f-contrib').value = (pos * ret / 100).toFixed(2);
  }
  document.getElementById('f-position-pct').addEventListener('input', recalcContrib);
  document.getElementById('f-return-pct').addEventListener('input', recalcContrib);

  function openTradeModal(t) {
    document.getElementById('trade-modal-title').textContent = t ? '編輯交易' : '新增交易';
    document.getElementById('trade-id').value = t ? t.id : '';
    document.getElementById('f-marked').checked = t ? !!t.marked : false;
    document.getElementById('f-date').value = t ? t.date : new Date().toISOString().slice(0, 10);
    document.getElementById('f-symbol').value = t ? t.symbol : '';
    document.getElementById('f-name').value = t ? (t.name || '') : '';
    document.getElementById('f-sector').value = t ? (t.sector || '') : '';
    document.getElementById('f-calc-price').value = t && t.price != null ? t.price : '';
    document.getElementById('f-calc-shares').value = '';
    document.getElementById('f-action').value = t ? t.action : '買進';
    document.getElementById('f-strategy').value = t ? t.strategy : '族群效應';
    document.getElementById('f-position-pct').value = t && t.positionPct != null ? t.positionPct : '';
    document.getElementById('f-return-pct').value = t && t.returnPct != null ? t.returnPct : '';
    document.getElementById('f-contrib').value = t && t.contrib != null ? t.contrib : '';
    document.getElementById('f-rating').value = t ? (t.rating || '') : '';
    document.getElementById('f-reason').value = t ? (t.reason || '') : '';
    document.getElementById('f-review').value = t ? (t.review || '') : '';
    btnDeleteTrade.hidden = !t;
    tradeModal.classList.add('open');
  }

  tradeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('trade-id').value || uid();
    const posVal = document.getElementById('f-position-pct').value;
    const retVal = document.getElementById('f-return-pct').value;
    const contribVal = document.getElementById('f-contrib').value;
    const priceVal = document.getElementById('f-calc-price').value;
    const rec = {
      id,
      marked: document.getElementById('f-marked').checked,
      date: document.getElementById('f-date').value,
      symbol: document.getElementById('f-symbol').value.trim(),
      name: document.getElementById('f-name').value.trim(),
      sector: document.getElementById('f-sector').value.trim(),
      action: document.getElementById('f-action').value,
      strategy: document.getElementById('f-strategy').value,
      price: priceVal === '' ? null : parseFloat(priceVal),
      positionPct: posVal === '' ? null : parseFloat(posVal),
      returnPct: retVal === '' ? null : parseFloat(retVal),
      contrib: contribVal === '' ? null : parseFloat(contribVal),
      rating: document.getElementById('f-rating').value,
      reason: document.getElementById('f-reason').value.trim(),
      review: document.getElementById('f-review').value.trim(),
    };
    const idx = state.trades.findIndex(x => x.id === id);
    if (idx >= 0) state.trades[idx] = rec; else state.trades.push(rec);
    save();
    closeModals();
    renderTrades();
  });

  btnDeleteTrade.addEventListener('click', () => {
    const id = document.getElementById('trade-id').value;
    if (id && confirm('確定刪除這筆交易紀錄？')) {
      state.trades = state.trades.filter(x => x.id !== id);
      save(); closeModals(); renderTrades();
    }
  });

  // ================= STATS =================
  function computeStats(realized) {
    const wins = realized.filter(t => t.returnPct > 0);
    const losses = realized.filter(t => t.returnPct < 0);
    const weighted = realized
      .filter(t => t.contrib != null || t.positionPct != null)
      .map(t => ({ ...t, contrib: t.contrib != null ? t.contrib : t.returnPct * t.positionPct / 100 }));
    const totalWeighted = weighted.reduce((s, t) => s + t.contrib, 0);
    const winRate = realized.length ? (wins.length / realized.length) * 100 : 0;
    const avgWin = wins.length ? wins.reduce((s, t) => s + t.returnPct, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, t) => s + t.returnPct, 0) / losses.length : 0;
    const grossWin = wins.reduce((s, t) => s + t.returnPct, 0);
    const grossLoss = Math.abs(losses.reduce((s, t) => s + t.returnPct, 0));
    const pf = grossLoss > 0 ? (grossWin / grossLoss) : (grossWin > 0 ? Infinity : 0);
    const maxWin = realized.length ? Math.max(...realized.map(t => t.returnPct)) : 0;
    const maxLoss = realized.length ? Math.min(...realized.map(t => t.returnPct)) : 0;
    return { realized, wins, losses, weighted, totalWeighted, winRate, avgWin, avgLoss, pf, maxWin, maxLoss };
  }

  function renderStats() {
    const allRealized = sortedTrades().filter(t => t.returnPct != null);
    const s = computeStats(allRealized);

    document.getElementById('stat-total-pnl').textContent = fmtPct(s.totalWeighted, 2);
    document.getElementById('stat-total-pnl').style.color = s.totalWeighted > 0 ? 'var(--good)' : s.totalWeighted < 0 ? 'var(--critical)' : '';
    document.getElementById('stat-winrate').textContent = s.realized.length ? s.winRate.toFixed(1) + '%' : '–';
    document.getElementById('stat-count').textContent = s.realized.length;
    document.getElementById('stat-count-sub').textContent = `${s.wins.length} 勝 / ${s.losses.length} 敗`;
    document.getElementById('stat-avg').textContent = `${fmtPct(s.avgWin, 2)} / ${fmtPct(s.avgLoss, 2)}`;
    document.getElementById('stat-pf').textContent = s.pf === Infinity ? '∞' : s.realized.length ? s.pf.toFixed(2) : '–';
    document.getElementById('stat-maxminmax').textContent = `${fmtPct(s.maxWin, 2)} / ${fmtPct(s.maxLoss, 2)}`;

    const barWrap = document.getElementById('stat-winloss-bar');
    barWrap.innerHTML = '';
    if (s.realized.length) {
      const winPct = (s.wins.length / s.realized.length) * 100;
      const w = document.createElement('div'); w.className = 'win'; w.style.width = winPct + '%';
      const l = document.createElement('div'); l.className = 'loss'; l.style.width = (100 - winPct) + '%';
      barWrap.appendChild(w); barWrap.appendChild(l);
    }

    renderMonthlyStatsTable(allRealized);
    renderEquityCurve(s.weighted);
    renderMonthlyChart(s.weighted);
    renderStrategyChart(s.realized);
    renderSectorChart(s.realized);
  }

  // ---- monthly stats breakdown table ----
  function renderMonthlyStatsTable(allRealized) {
    const tbody = document.getElementById('monthly-stats-tbody');
    const empty = document.getElementById('monthly-stats-empty');
    tbody.innerHTML = '';
    empty.style.display = allRealized.length ? 'none' : 'block';
    if (!allRealized.length) return;

    const byMonth = {};
    allRealized.forEach(t => {
      const m = t.date.slice(0, 7);
      (byMonth[m] = byMonth[m] || []).push(t);
    });
    const months = Object.keys(byMonth).sort().reverse();

    for (const m of months) {
      const s = computeStats(byMonth[m]);
      const pnlClass = s.totalWeighted > 0 ? 'pnl-pos' : s.totalWeighted < 0 ? 'pnl-neg' : 'pnl-zero';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${m.replace('-', '/')}</strong></td>
        <td class="num ${pnlClass}">${fmtPct(s.totalWeighted, 2)}</td>
        <td class="num">${s.winRate.toFixed(1)}%</td>
        <td class="num">${s.realized.length}（${s.wins.length}勝${s.losses.length}敗）</td>
        <td class="num">${fmtPct(s.avgWin, 2)} / ${fmtPct(s.avgLoss, 2)}</td>
        <td class="num">${s.pf === Infinity ? '∞' : s.pf.toFixed(2)}</td>
        <td class="num">${fmtPct(s.maxWin, 2)} / ${fmtPct(s.maxLoss, 2)}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  // ---- weighted cumulative return curve (SVG line chart) ----
  function parseDateTs(dateStr) { return new Date(dateStr + 'T00:00:00').getTime(); }

  function renderEquityCurve(weighted) {
    const el = document.getElementById('equity-chart');
    el.innerHTML = '';
    weighted = weighted.filter(t => t.date >= CHART_START_DATE);
    if (!weighted.length) {
      el.innerHTML = '<p class="empty-state">尚無帶有資金佔比與報酬率的已實現紀錄，無法繪製曲線。</p>';
      return;
    }
    const sorted = [...weighted].sort((a, b) => a.date > b.date ? 1 : -1);
    let cum = 0;
    const raw = sorted.map(t => { cum += t.contrib; return { date: t.date, ts: parseDateTs(t.date), value: cum, symbol: t.symbol, contrib: t.contrib }; });

    // 每 6 天合併成一個資料點（取區間內最後一筆的累計值），避免資料點過於密集
    const BIN_DAYS = 3;
    const binMs = BIN_DAYS * 24 * 60 * 60 * 1000;
    const binStart = raw[0].ts;
    const bins = new Map();
    raw.forEach(p => {
      const idx = Math.floor((p.ts - binStart) / binMs);
      const existing = bins.get(idx);
      bins.set(idx, { ...p, count: existing ? existing.count + 1 : 1 });
    });
    // binTs：每個桶固定用「桶的起始時間」當作繪圖 x 座標（而非桶內最後一筆的實際日期），
    // 這樣個人曲線跟櫃買指數線只要落在同一個桶，x 座標就會完全一致、對得齊。
    const points = [...bins.keys()].sort((a, b) => a - b).map(k => ({ ...bins.get(k), binTs: binStart + k * binMs }));

    const otcSeries = computeOtcSeries(binStart, BIN_DAYS, CHART_START_DATE);
    const otcBinsByIdx = new Map(otcSeries.map(p => [Math.round((p.binTs - binStart) / binMs), p]));

    const W = 900, H = 280, PAD = { top: 16, right: 16, bottom: 36, left: 56 };
    const innerW = W - PAD.left - PAD.right, innerH = H - PAD.top - PAD.bottom;

    // 縱軸固定為 -50% ~ +50%，每 10% 一格
    const min = -50, max = 50;

    // 用「原始交易」的日期範圍當作 X 軸範圍（而非合併後的區間點），
    // 這樣月初/月中標記線才不會因為合併時取區間內最後一筆而被誤判裁掉
    // 同時涵蓋櫃買指數對照線的日期範圍（可能比交易紀錄更早開始，例如 6/1）
    const tMin = Math.min(raw[0].ts, otcSeries.length ? otcSeries[0].ts : raw[0].ts);
    const tMax = Math.max(raw[raw.length - 1].ts, otcSeries.length ? otcSeries[otcSeries.length - 1].ts : raw[raw.length - 1].ts);
    const tSpan = tMax - tMin || 1; // 同一天的資料時避免除以 0

    const x = (ts) => PAD.left + ((ts - tMin) / tSpan) * innerW;
    const y = (v) => PAD.top + innerH - ((v - min) / (max - min)) * innerH;

    const zeroY = y(0);
    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.binTs).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L ${x(points[points.length - 1].binTs).toFixed(1)} ${zeroY.toFixed(1)} L ${x(points[0].binTs).toFixed(1)} ${zeroY.toFixed(1)} Z`;

    const gridStep = 10;
    let gridLines = '';
    let axisLabels = '';
    for (let v = min; v <= max; v += gridStep) {
      const gy = y(v);
      const isZero = v === 0;
      gridLines += `<line x1="${PAD.left}" y1="${gy.toFixed(1)}" x2="${W - PAD.right}" y2="${gy.toFixed(1)}" stroke="var(--gridline)" stroke-width="1"/>`;
      axisLabels += `<text x="${PAD.left - 8}" y="${(gy + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="var(--text-muted)" ${isZero ? 'font-weight="700"' : ''}>${v > 0 ? '+' : ''}${v}%</text>`;
    }

    // 每個月 1 號與 15 號的標記：對齊到「包含該日期的 6 天區間」實際存在的資料點正下方，
    // 而不是用連續時間軸算出的位置（否則會跟合併後的資料點對不上）。
    // 自動涵蓋資料範圍內的每一個月，之後月份增加會自動延伸，不需要手動調整。
    let monthTicks = '';
    {
      const startD = new Date(tMin);
      const cursor = new Date(startD.getFullYear(), startD.getMonth(), 1);
      const usedBins = new Set();
      while (cursor.getTime() <= tMax) {
        const y = cursor.getFullYear(), mo = cursor.getMonth();
        [[new Date(y, mo, 1).getTime(), 1], [new Date(y, mo, 15).getTime(), 15]].forEach(([ts, day]) => {
          if (ts < tMin || ts > tMax) return;
          const idx = Math.floor((ts - binStart) / binMs);
          const point = bins.get(idx) || otcBinsByIdx.get(idx); // 個人紀錄沒有該區間資料時，改用櫃買指數的資料點定位
          if (!point || usedBins.has(idx)) return; // 該 6 天區間內兩邊都沒有資料，或已被同月另一個標記用掉，就不標示
          usedBins.add(idx);
          const gx = x(point.binTs);
          const label = `${mo + 1}/${day}`;
          monthTicks += `<line x1="${gx.toFixed(1)}" y1="${PAD.top}" x2="${gx.toFixed(1)}" y2="${H - PAD.bottom}" stroke="var(--gridline)" stroke-width="1" stroke-dasharray="2,3"/>`;
          monthTicks += `<text x="${gx.toFixed(1)}" y="${H - PAD.bottom + 16}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${label}</text>`;
        });
        cursor.setMonth(cursor.getMonth() + 1);
      }
    }

    const dots = points.map((p, i) => `<circle class="ec-dot" data-i="${i}" cx="${x(p.binTs).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3" fill="var(--series-1)" stroke="var(--surface-1)" stroke-width="1.5" style="cursor:pointer"/>`).join('');

    const otcLinePath = otcSeries.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.binTs).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
    const otcDots = otcSeries.map((p, i) => `<circle class="otc-dot" data-i="${i}" cx="${x(p.binTs).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.5" fill="var(--series-3)" stroke="var(--surface-1)" stroke-width="1.5" style="cursor:pointer"/>`).join('');

    const legend = otcSeries.length ? `
      <div class="legend" style="margin-bottom:6px;">
        <div class="legend-item"><span class="legend-swatch" style="background:var(--series-1)"></span>個人資金加權報酬</div>
        <div class="legend-item"><span class="legend-swatch" style="background:var(--series-3)"></span>櫃買指數（7/1 起，基準 0%，資料經核對）</div>
      </div>
    ` : '';

    const svg = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="aspect-ratio:${W}/${H}">
        ${gridLines}
        ${monthTicks}
        <line x1="${PAD.left}" y1="${zeroY.toFixed(1)}" x2="${W - PAD.right}" y2="${zeroY.toFixed(1)}" stroke="var(--baseline)" stroke-width="1.5"/>
        <path d="${areaPath}" fill="var(--series-1)" opacity="0.10" stroke="none"/>
        ${otcLinePath ? `<path d="${otcLinePath}" fill="none" stroke="var(--series-3)" stroke-width="2" stroke-dasharray="5,4" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
        <path d="${linePath}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}
        ${otcDots}
        ${axisLabels}
      </svg>
    `;
    const wrap = document.createElement('div');
    wrap.className = 'chart-wrap';
    wrap.innerHTML = legend + svg + '<div class="chart-tooltip"></div>';
    el.appendChild(wrap);

    const tooltip = wrap.querySelector('.chart-tooltip');
    wrap.querySelectorAll('.ec-dot').forEach(dot => {
      dot.addEventListener('mouseenter', () => {
        const i = +dot.dataset.i;
        const p = points[i];
        tooltip.innerHTML = `<div class="tt-title">${p.date}${p.count > 1 ? `（近 ${BIN_DAYS} 天內 ${p.count} 筆）` : ''}</div><div>最新一筆：${p.symbol}</div><div>累計 ${fmtPct(p.value, 2)}</div>`;
        tooltip.style.opacity = '1';
        dot.setAttribute('r', '5');
      });
      dot.addEventListener('mousemove', (e) => {
        const rect = wrap.getBoundingClientRect();
        tooltip.style.left = (e.clientX - rect.left + 12) + 'px';
        tooltip.style.top = (e.clientY - rect.top - 10) + 'px';
      });
      dot.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; dot.setAttribute('r', '3'); });
    });
    wrap.querySelectorAll('.otc-dot').forEach(dot => {
      dot.addEventListener('mouseenter', () => {
        const p = otcSeries[+dot.dataset.i];
        tooltip.innerHTML = `<div class="tt-title">${p.date}</div><div>櫃買指數 ${fmtPct(p.value, 2)}</div>`;
        tooltip.style.opacity = '1';
        dot.setAttribute('r', '4.5');
      });
      dot.addEventListener('mousemove', (e) => {
        const rect = wrap.getBoundingClientRect();
        tooltip.style.left = (e.clientX - rect.left + 12) + 'px';
        tooltip.style.top = (e.clientY - rect.top - 10) + 'px';
      });
      dot.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; dot.setAttribute('r', '2.5'); });
    });
  }

  // ---- monthly weighted-return bar chart ----
  function renderMonthlyChart(weighted) {
    const el = document.getElementById('monthly-chart');
    el.innerHTML = '';
    weighted = weighted.filter(t => t.date >= CHART_START_DATE);
    if (!weighted.length) {
      el.innerHTML = '<p class="empty-state">尚無帶有資金佔比與報酬率的已實現紀錄，無法繪製月度統計。</p>';
      return;
    }
    const byMonth = {};
    weighted.forEach(t => {
      const m = t.date.slice(0, 7); // YYYY-MM
      byMonth[m] = (byMonth[m] || 0) + t.contrib;
    });
    const months = Object.keys(byMonth).sort();
    const otcMonthly = computeOtcMonthlyReturns();
    const data = months.map(m => ({ name: m.replace('-', '/'), value: byMonth[m], otc: otcMonthly[m] }));

    const W = 900, H = 240, PAD = { top: 16, right: 16, bottom: 40, left: 56 };
    const innerW = W - PAD.left - PAD.right, innerH = H - PAD.top - PAD.bottom;
    const values = data.flatMap(d => d.otc != null ? [d.value, d.otc] : [d.value]);
    let min = Math.min(0, ...values), max = Math.max(0, ...values);
    if (min === max) { max += 1; }
    const padV = (max - min) * 0.15 || 1;
    min -= (min < 0 ? padV : 0); max += padV;
    const y = (v) => PAD.top + innerH - ((v - min) / (max - min)) * innerH;
    const zeroY = y(0);

    const n = data.length;
    const gap = 20;
    const groupW = Math.min(70, (innerW - gap * (n - 1)) / n);
    const barGap = 4;
    const barW = (groupW - barGap) / 2;
    const totalW = groupW * n + gap * (n - 1);
    const startX = PAD.left + (innerW - totalW) / 2;

    let gridLines = '';
    const gridN = 4;
    for (let i = 0; i <= gridN; i++) {
      const v = min + ((max - min) * i) / gridN;
      const gy = y(v);
      gridLines += `<line x1="${PAD.left}" y1="${gy.toFixed(1)}" x2="${W - PAD.right}" y2="${gy.toFixed(1)}" stroke="var(--gridline)" stroke-width="1"/>`;
    }

    let bars = '', labels = '';
    data.forEach((d, i) => {
      const gx = startX + i * (groupW + gap);

      const barY = Math.min(y(d.value), zeroY);
      const barH = Math.max(2, Math.abs(y(d.value) - zeroY));
      const rTop = d.value >= 0 ? 4 : 0;
      const rBot = d.value < 0 ? 4 : 0;
      const color = d.value >= 0 ? 'var(--good)' : 'var(--critical)';
      bars += `<path class="bar" data-i="${i}" data-type="me" d="${roundedBarPath(gx, barY, barW, barH, rTop, rBot)}" fill="${color}" style="cursor:pointer"/>`;
      const valY = d.value >= 0 ? barY - 6 : barY + barH + 14;
      labels += `<text x="${(gx + barW / 2).toFixed(1)}" y="${valY.toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${color}">${fmtPct(d.value, 1)}</text>`;

      if (d.otc != null) {
        const ox = gx + barW + barGap;
        const otcY = Math.min(y(d.otc), zeroY);
        const otcH = Math.max(2, Math.abs(y(d.otc) - zeroY));
        const oTop = d.otc >= 0 ? 4 : 0;
        const oBot = d.otc < 0 ? 4 : 0;
        bars += `<path class="bar" data-i="${i}" data-type="otc" d="${roundedBarPath(ox, otcY, barW, otcH, oTop, oBot)}" fill="var(--series-3)" style="cursor:pointer"/>`;
        const oValY = d.otc >= 0 ? otcY - 6 : otcY + otcH + 14;
        labels += `<text x="${(ox + barW / 2).toFixed(1)}" y="${oValY.toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--series-3)">${fmtPct(d.otc, 1)}</text>`;
      }

      labels += `<text x="${(gx + groupW / 2).toFixed(1)}" y="${H - PAD.bottom + 18}" text-anchor="middle" font-size="12" fill="var(--text-secondary)">${d.name}</text>`;
    });

    const legend = `
      <div class="legend" style="margin-bottom:6px;">
        <div class="legend-item"><span class="legend-swatch" style="background:var(--good)"></span>個人資金加權報酬</div>
        <div class="legend-item"><span class="legend-swatch" style="background:var(--series-3)"></span>櫃買指數當月報酬</div>
      </div>
    `;

    const svg = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="aspect-ratio:${W}/${H}">
        ${gridLines}
        <line x1="${PAD.left}" y1="${zeroY.toFixed(1)}" x2="${W - PAD.right}" y2="${zeroY.toFixed(1)}" stroke="var(--baseline)" stroke-width="1.5"/>
        ${bars}
        ${labels}
      </svg>
    `;
    const wrap = document.createElement('div');
    wrap.className = 'chart-wrap';
    wrap.innerHTML = legend + svg + '<div class="chart-tooltip"></div>';
    el.appendChild(wrap);

    const tooltip = wrap.querySelector('.chart-tooltip');
    wrap.querySelectorAll('.bar').forEach(bar => {
      bar.addEventListener('mouseenter', () => {
        const d = data[+bar.dataset.i];
        const isOtc = bar.dataset.type === 'otc';
        tooltip.innerHTML = isOtc
          ? `<div class="tt-title">${d.name}</div><div>櫃買指數當月報酬 ${fmtPct(d.otc, 2)}</div>`
          : `<div class="tt-title">${d.name}</div><div>個人資金加權報酬 ${fmtPct(d.value, 2)}</div>`;
        tooltip.style.opacity = '1';
        bar.style.opacity = '0.8';
      });
      bar.addEventListener('mousemove', (e) => {
        const rect = wrap.getBoundingClientRect();
        tooltip.style.left = (e.clientX - rect.left + 12) + 'px';
        tooltip.style.top = (e.clientY - rect.top - 10) + 'px';
      });
      bar.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; bar.style.opacity = '1'; });
    });
  }

  // ---- strategy bar chart (avg return %) ----
  function renderStrategyChart(realized) {
    const el = document.getElementById('strategy-chart');
    const legendEl = document.getElementById('strategy-legend');
    el.innerHTML = ''; legendEl.innerHTML = '';
    if (!realized.length) {
      el.innerHTML = '<p class="empty-state">尚無已實現紀錄，無法繪製策略統計。</p>';
      return;
    }
    const byStrategy = STRATEGIES.map((name, i) => {
      const trades = realized.filter(t => t.strategy === name);
      // 以「貢獻值」為單位取平均：有手動填資金加權貢獻就直接用，沒填才用資金佔比×報酬率算
      const weightedTrades = trades
        .filter(t => t.contrib != null || t.positionPct != null)
        .map(t => t.contrib != null ? t.contrib : t.returnPct * t.positionPct / 100);
      const avg = weightedTrades.length ? weightedTrades.reduce((s, c) => s + c, 0) / weightedTrades.length : 0;
      return { name, avg, count: trades.length, color: SERIES[i % SERIES.length] };
    }).filter(s => s.count > 0);

    if (!byStrategy.length) { el.innerHTML = '<p class="empty-state">尚無資料。</p>'; return; }

    byStrategy.forEach(s => {
      const item = document.createElement('div');
      item.className = 'legend-item';
      item.innerHTML = `<span class="legend-swatch" style="background:${s.color}"></span>${s.name}`;
      legendEl.appendChild(item);
    });

    const W = 900, H = 240, PAD = { top: 16, right: 16, bottom: 40, left: 56 };
    const innerW = W - PAD.left - PAD.right, innerH = H - PAD.top - PAD.bottom;
    const values = byStrategy.map(s => s.avg);
    let min = Math.min(0, ...values), max = Math.max(0, ...values);
    if (min === max) { max += 1; }
    const padV = (max - min) * 0.15 || 1;
    min -= (min < 0 ? padV : 0); max += padV;
    const y = (v) => PAD.top + innerH - ((v - min) / (max - min)) * innerH;
    const zeroY = y(0);

    const n = byStrategy.length;
    const gap = 24;
    const barW = Math.min(64, (innerW - gap * (n - 1)) / n);
    const totalW = barW * n + gap * (n - 1);
    const startX = PAD.left + (innerW - totalW) / 2;

    let gridLines = '';
    const gridN = 4;
    for (let i = 0; i <= gridN; i++) {
      const v = min + ((max - min) * i) / gridN;
      const gy = y(v);
      gridLines += `<line x1="${PAD.left}" y1="${gy.toFixed(1)}" x2="${W - PAD.right}" y2="${gy.toFixed(1)}" stroke="var(--gridline)" stroke-width="1"/>`;
    }

    let bars = '', labels = '';
    byStrategy.forEach((s, i) => {
      const bx = startX + i * (barW + gap);
      const barY = Math.min(y(s.avg), zeroY);
      const barH = Math.max(2, Math.abs(y(s.avg) - zeroY));
      const rTop = s.avg >= 0 ? 4 : 0;
      const rBot = s.avg < 0 ? 4 : 0;
      bars += `<path class="bar" data-i="${i}" d="${roundedBarPath(bx, barY, barW, barH, rTop, rBot)}" fill="${s.color}" style="cursor:pointer"/>`;
      labels += `<text x="${(bx + barW / 2).toFixed(1)}" y="${H - PAD.bottom + 18}" text-anchor="middle" font-size="12" fill="var(--text-secondary)">${s.name}</text>`;
      const valY = s.avg >= 0 ? barY - 6 : barY + barH + 14;
      labels += `<text x="${(bx + barW / 2).toFixed(1)}" y="${valY.toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="${s.avg >= 0 ? 'var(--good)' : 'var(--critical)'}">${fmtPct(s.avg, 1)}</text>`;
    });

    const svg = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="aspect-ratio:${W}/${H}">
        ${gridLines}
        <line x1="${PAD.left}" y1="${zeroY.toFixed(1)}" x2="${W - PAD.right}" y2="${zeroY.toFixed(1)}" stroke="var(--baseline)" stroke-width="1.5"/>
        ${bars}
        ${labels}
      </svg>
    `;
    const wrap = document.createElement('div');
    wrap.className = 'chart-wrap';
    wrap.innerHTML = svg + '<div class="chart-tooltip"></div>';
    el.appendChild(wrap);

    const tooltip = wrap.querySelector('.chart-tooltip');
    wrap.querySelectorAll('.bar').forEach(bar => {
      bar.addEventListener('mouseenter', () => {
        const s = byStrategy[+bar.dataset.i];
        tooltip.innerHTML = `<div class="tt-title">${s.name}</div><div>平均資金加權貢獻 ${fmtPct(s.avg, 2)}</div><div>${s.count} 筆紀錄</div>`;
        tooltip.style.opacity = '1';
        bar.style.opacity = '0.8';
      });
      bar.addEventListener('mousemove', (e) => {
        const rect = wrap.getBoundingClientRect();
        tooltip.style.left = (e.clientX - rect.left + 12) + 'px';
        tooltip.style.top = (e.clientY - rect.top - 10) + 'px';
      });
      bar.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; bar.style.opacity = '1'; });
    });
  }

  // ---- sector grouped bar chart (total contrib sum vs weighted average) ----
  const SECTOR_PAGE_SIZE = 6;
  let sectorChartPage = 0;

  function renderSectorChart(realized) {
    const el = document.getElementById('sector-chart');
    el.innerHTML = '';
    if (!realized.length) {
      el.innerHTML = '<p class="empty-state">尚無已實現紀錄，無法繪製族群統計。</p>';
      return;
    }
    const sectorNames = [...new Set(realized.map(t => (t.sector || '').trim()).filter(Boolean))];
    const bySectorAll = sectorNames.map(name => {
      const trades = realized.filter(t => (t.sector || '').trim() === name);
      const contribs = trades
        .filter(t => t.contrib != null || t.positionPct != null)
        .map(t => t.contrib != null ? t.contrib : t.returnPct * t.positionPct / 100);
      const total = contribs.reduce((s, c) => s + c, 0);
      return { name, total, count: trades.length };
    }).filter(s => s.count > 0).sort((a, b) => b.total - a.total);

    if (!bySectorAll.length) { el.innerHTML = '<p class="empty-state">尚無資料。</p>'; return; }

    const totalPages = Math.max(1, Math.ceil(bySectorAll.length / SECTOR_PAGE_SIZE));
    if (sectorChartPage >= totalPages) sectorChartPage = totalPages - 1;
    if (sectorChartPage < 0) sectorChartPage = 0;
    const bySector = bySectorAll.slice(sectorChartPage * SECTOR_PAGE_SIZE, (sectorChartPage + 1) * SECTOR_PAGE_SIZE);

    const W = 900, H = 240, PAD = { top: 16, right: 16, bottom: 40, left: 56 };
    const innerW = W - PAD.left - PAD.right, innerH = H - PAD.top - PAD.bottom;
    const values = bySectorAll.map(s => s.total);
    let min = Math.min(0, ...values), max = Math.max(0, ...values);
    if (min === max) { max += 1; }
    const padV = (max - min) * 0.15 || 1;
    min -= (min < 0 ? padV : 0); max += padV;
    const y = (v) => PAD.top + innerH - ((v - min) / (max - min)) * innerH;
    const zeroY = y(0);

    const n = bySector.length;
    const gap = 24;
    const barW = Math.min(64, (innerW - gap * (n - 1)) / n);
    const totalW = barW * n + gap * (n - 1);
    const startX = PAD.left + (innerW - totalW) / 2;

    let gridLines = '';
    const gridN = 4;
    for (let i = 0; i <= gridN; i++) {
      const v = min + ((max - min) * i) / gridN;
      const gy = y(v);
      gridLines += `<line x1="${PAD.left}" y1="${gy.toFixed(1)}" x2="${W - PAD.right}" y2="${gy.toFixed(1)}" stroke="var(--gridline)" stroke-width="1"/>`;
    }

    let bars = '', labels = '';
    bySector.forEach((s, i) => {
      const bx = startX + i * (barW + gap);
      const barY = Math.min(y(s.total), zeroY);
      const barH = Math.max(2, Math.abs(y(s.total) - zeroY));
      const color = s.total >= 0 ? 'var(--good)' : 'var(--critical)';
      bars += `<path class="bar" data-i="${i}" d="${roundedBarPath(bx, barY, barW, barH, s.total >= 0 ? 4 : 0, s.total < 0 ? 4 : 0)}" fill="${color}" style="cursor:pointer"/>`;
      labels += `<text x="${(bx + barW / 2).toFixed(1)}" y="${H - PAD.bottom + 18}" text-anchor="middle" font-size="12" fill="var(--text-secondary)">${escapeHtml(s.name)}</text>`;
      const valY = s.total >= 0 ? barY - 6 : barY + barH + 14;
      labels += `<text x="${(bx + barW / 2).toFixed(1)}" y="${valY.toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="${color}">${fmtPct(s.total, 1)}</text>`;
    });

    const pager = totalPages > 1 ? `
      <div class="chart-pager">
        <button type="button" class="btn ghost pager-btn" id="sector-page-prev" ${sectorChartPage === 0 ? 'disabled' : ''}>‹ 上一頁</button>
        <span class="pager-label">第 ${sectorChartPage + 1} / ${totalPages} 頁</span>
        <button type="button" class="btn ghost pager-btn" id="sector-page-next" ${sectorChartPage === totalPages - 1 ? 'disabled' : ''}>下一頁 ›</button>
      </div>
    ` : '';

    const svg = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="aspect-ratio:${W}/${H}">
        ${gridLines}
        <line x1="${PAD.left}" y1="${zeroY.toFixed(1)}" x2="${W - PAD.right}" y2="${zeroY.toFixed(1)}" stroke="var(--baseline)" stroke-width="1.5"/>
        ${bars}
        ${labels}
      </svg>
    `;
    const wrap = document.createElement('div');
    wrap.className = 'chart-wrap';
    wrap.innerHTML = svg + pager + '<div class="chart-tooltip"></div>';
    el.appendChild(wrap);

    if (totalPages > 1) {
      const prevBtn = wrap.querySelector('#sector-page-prev');
      const nextBtn = wrap.querySelector('#sector-page-next');
      if (prevBtn) prevBtn.addEventListener('click', () => { sectorChartPage--; renderSectorChart(realized); });
      if (nextBtn) nextBtn.addEventListener('click', () => { sectorChartPage++; renderSectorChart(realized); });
    }

    const tooltip = wrap.querySelector('.chart-tooltip');
    wrap.querySelectorAll('.bar').forEach(bar => {
      bar.addEventListener('mouseenter', () => {
        const s = bySector[+bar.dataset.i];
        tooltip.innerHTML = `<div class="tt-title">${escapeHtml(s.name)}</div><div>總報酬 ${fmtPct(s.total, 2)}</div><div>${s.count} 筆紀錄</div>`;
        tooltip.style.opacity = '1';
        bar.style.opacity = '0.8';
      });
      bar.addEventListener('mousemove', (e) => {
        const rect = wrap.getBoundingClientRect();
        tooltip.style.left = (e.clientX - rect.left + 12) + 'px';
        tooltip.style.top = (e.clientY - rect.top - 10) + 'px';
      });
      bar.addEventListener('mouseleave', () => { tooltip.style.opacity = '0'; bar.style.opacity = '1'; });
    });
  }

  function roundedBarPath(x, y, w, h, rTop, rBot) {
    rTop = Math.min(rTop, h / 2); rBot = Math.min(rBot, h / 2);
    return `
      M ${x} ${y + rTop}
      Q ${x} ${y} ${x + rTop} ${y}
      L ${x + w - rTop} ${y}
      Q ${x + w} ${y} ${x + w} ${y + rTop}
      L ${x + w} ${y + h - rBot}
      Q ${x + w} ${y + h} ${x + w - rBot} ${y + h}
      L ${x + rBot} ${y + h}
      Q ${x} ${y + h} ${x} ${y + h - rBot}
      Z
    `;
  }

  // ================= SUPPLY CHAIN =================
  // 節點/公司關聯查詢輔助函式：一律從 state.supplyChainNodes / state.companyLinks 現查，不快取，
  // 因為編輯區隨時可能新增/刪除節點，快取容易跟畫面不同步。
  function scNode(id) { return state.supplyChainNodes.find(n => n.id === id); }
  function scChildren(id) { return state.supplyChainNodes.filter(n => (n.parentIds || []).includes(id)); }
  function scRoots() { return state.supplyChainNodes.filter(n => !n.parentIds || n.parentIds.length === 0); }
  function scDepth(id) {
    let depth = 0, node = scNode(id), guard = 0;
    while (node && node.parentIds && node.parentIds[0] && guard++ < 20) { depth++; node = scNode(node.parentIds[0]); }
    return depth;
  }
  // 含自己在內的所有下層節點 id（沿 parentIds 反向展開，支援多重上層/DAG）
  function scDescendantIds(id) {
    const result = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      state.supplyChainNodes.forEach(n => {
        if (!result.has(n.id) && (n.parentIds || []).some(p => result.has(p))) { result.add(n.id); changed = true; }
      });
    }
    return result;
  }
  function scLinksForNode(nodeId) {
    const ids = scDescendantIds(nodeId);
    return state.companyLinks.filter(l => ids.has(l.nodeId));
  }
  function scNodesForSymbol(symbol) {
    return state.companyLinks
      .filter(l => l.symbol === symbol)
      .map(l => ({ ...l, node: scNode(l.nodeId) }))
      .filter(l => l.node);
  }
  function scTradesForSymbols(symbols) {
    const set = new Set(symbols);
    return sortedTrades().filter(t => set.has(t.symbol));
  }

  let chainExpanded = new Set();
  let chainSelectedNodeId = null;
  let chainSelectedSymbol = null;

  function renderChainTree() {
    const el = document.getElementById('chain-tree');
    if (!el) return;
    el.innerHTML = '';
    const roots = scRoots();
    if (!roots.length) {
      el.innerHTML = '<p class="empty-state">尚無供應鏈節點，點右上角「編輯供應鏈」新增。</p>';
      return;
    }
    const renderNode = (node, depth) => {
      const children = scChildren(node.id);
      const hasChildren = children.length > 0;
      const isExpanded = chainExpanded.has(node.id);
      const linkCount = scLinksForNode(node.id).length;
      const row = document.createElement('div');
      row.className = 'chain-row' + (chainSelectedNodeId === node.id && !chainSelectedSymbol ? ' active' : '');
      row.style.paddingLeft = (depth * 18 + 10) + 'px';
      row.innerHTML = `
        <span class="chain-toggle">${hasChildren ? (isExpanded ? '▾' : '▸') : ''}</span>
        <span class="chain-row-name">${escapeHtml(node.name)}</span>
        ${linkCount ? `<span class="chain-row-count">${linkCount}</span>` : ''}
      `;
      if (hasChildren) {
        row.querySelector('.chain-toggle').addEventListener('click', (e) => {
          e.stopPropagation();
          if (isExpanded) chainExpanded.delete(node.id); else chainExpanded.add(node.id);
          renderChainTree();
        });
      }
      row.addEventListener('click', () => {
        chainSelectedNodeId = node.id;
        chainSelectedSymbol = null;
        renderChainTree();
        renderChainDetail();
      });
      el.appendChild(row);
      if (hasChildren && isExpanded) children.forEach(c => renderNode(c, depth + 1));
    };
    roots.forEach(r => renderNode(r, 0));
  }

  function chainStatTiles(s) {
    return `
      <div class="stat-grid" style="margin:16px 0;">
        <div class="stat-tile"><span class="stat-label">已實現次數</span><span class="stat-value">${s.realized.length}</span></div>
        <div class="stat-tile"><span class="stat-label">勝率</span><span class="stat-value">${s.realized.length ? s.winRate.toFixed(1) + '%' : '–'}</span></div>
        <div class="stat-tile"><span class="stat-label">平均獲利 / 虧損</span><span class="stat-value">${fmtPct(s.avgWin, 2)} / ${fmtPct(s.avgLoss, 2)}</span></div>
        <div class="stat-tile"><span class="stat-label">資金加權貢獻</span><span class="stat-value">${fmtPct(s.totalWeighted, 2)}</span></div>
      </div>
    `;
  }

  function renderChainDetail() {
    const el = document.getElementById('chain-detail');
    if (!el) return;

    if (chainSelectedSymbol) {
      const symbol = chainSelectedSymbol;
      const trades = sortedTrades().filter(t => t.symbol === symbol);
      const realized = trades.filter(t => t.returnPct != null);
      const s = computeStats(realized);
      const nodeLinks = scNodesForSymbol(symbol);
      const name = trades[0]?.name || '';
      const sector = (trades.find(t => t.sector)?.sector) || '–';
      el.innerHTML = `
        <div class="chain-detail-head">
          <button type="button" class="btn ghost" id="chain-back-btn">‹ 返回節點</button>
          <h2>${escapeHtml(symbol)} ${escapeHtml(name)}</h2>
        </div>
        <div class="chain-detail-meta">
          <div><span class="chain-meta-label">所屬族群</span>${escapeHtml(sector)}</div>
          <div><span class="chain-meta-label">所屬供應鏈</span>${nodeLinks.length ? nodeLinks.map(l => `${escapeHtml(l.node.name)}${l.role ? `（${escapeHtml(l.role)}）` : ''}`).join('、') : '–'}</div>
        </div>
        ${chainStatTiles(s)}
        <h3 class="chain-companies-title">交易紀錄（${trades.length}）</h3>
        <div class="table-wrap">
          <table class="trade-table">
            <thead><tr><th>日期</th><th>操作</th><th>策略</th><th>資金佔比</th><th>報酬率</th></tr></thead>
            <tbody>${trades.map(t => `
              <tr>
                <td class="num">${t.date}</td>
                <td><span class="badge ${actionBadgeClass(t.action)}">${escapeHtml(t.action)}</span></td>
                <td>${escapeHtml(t.strategy)}</td>
                <td class="num">${t.positionPct == null ? '–' : t.positionPct.toFixed(1) + '%'}</td>
                <td class="num ${t.returnPct == null ? 'pnl-zero' : t.returnPct > 0 ? 'pnl-pos' : t.returnPct < 0 ? 'pnl-neg' : 'pnl-zero'}">${fmtPct(t.returnPct, 2)}</td>
              </tr>
            `).join('')}</tbody>
          </table>
        </div>
      `;
      document.getElementById('chain-back-btn').addEventListener('click', () => {
        chainSelectedSymbol = null;
        renderChainTree();
        renderChainDetail();
      });
      return;
    }

    if (!chainSelectedNodeId || !scNode(chainSelectedNodeId)) {
      el.innerHTML = '<p class="empty-state">點選左側的供應鏈節點查看詳細資料。</p>';
      return;
    }
    const node = scNode(chainSelectedNodeId);
    const links = scLinksForNode(node.id);
    const symbols = [...new Set(links.map(l => l.symbol))];
    const trades = scTradesForSymbols(symbols);
    const realized = trades.filter(t => t.returnPct != null);
    const s = computeStats(realized);

    el.innerHTML = `
      <div class="chain-detail-head"><h2>${escapeHtml(node.name)}</h2></div>
      ${chainStatTiles(s)}
      <h3 class="chain-companies-title">相關公司（${symbols.length}）</h3>
      <div class="chain-company-list">
        ${symbols.length ? symbols.map(sym => {
          const link = links.find(l => l.symbol === sym);
          const tr = state.trades.find(t => t.symbol === sym);
          return `<div class="chain-company-row" data-symbol="${escapeHtml(sym)}"><strong>${escapeHtml(sym)}</strong> ${escapeHtml(tr ? tr.name : '')} ${link.role ? `<span class="chain-role-tag">${escapeHtml(link.role)}</span>` : ''}</div>`;
        }).join('') : '<p class="empty-state">此節點（含子節點）尚未關聯任何公司，可到「編輯供應鏈」新增。</p>'}
      </div>
    `;
    el.querySelectorAll('.chain-company-row').forEach(row => {
      row.addEventListener('click', () => {
        chainSelectedSymbol = row.dataset.symbol;
        renderChainDetail();
      });
    });
  }

  // ---- 編輯供應鏈 ----
  const btnChainEditToggle = document.getElementById('btn-chain-edit-toggle');
  const chainEditPanel = document.getElementById('chain-edit');
  btnChainEditToggle.addEventListener('click', () => {
    const willOpen = chainEditPanel.hidden;
    chainEditPanel.hidden = !willOpen;
    btnChainEditToggle.textContent = willOpen ? '完成編輯' : '編輯供應鏈';
    if (willOpen) renderChainEdit();
  });

  function populateNodeSelect(selectEl, { includeEmpty } = {}) {
    const options = state.supplyChainNodes.map(n => `<option value="${n.id}">${'　'.repeat(scDepth(n.id))}${escapeHtml(n.name)}</option>`).join('');
    selectEl.innerHTML = (includeEmpty ? '<option value="">（無，作為根節點）</option>' : '') + options;
  }

  function renderChainEdit() {
    populateNodeSelect(document.getElementById('cn-parent'), { includeEmpty: true });
    populateNodeSelect(document.getElementById('cl-node'), {});

    const nodeListEl = document.getElementById('chain-node-list');
    nodeListEl.innerHTML = state.supplyChainNodes.length ? state.supplyChainNodes.map(n => `
      <div class="chain-manage-row">
        <span>${'　'.repeat(scDepth(n.id))}${escapeHtml(n.name)}</span>
        <span class="chain-manage-meta">${n.stage ? STAGE_LABEL[n.stage] : ''}</span>
        <button type="button" class="row-del" data-del-node="${n.id}" title="刪除">✕</button>
      </div>
    `).join('') : '<p class="empty-state">尚無節點。</p>';
    nodeListEl.querySelectorAll('[data-del-node]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.delNode;
        if (!confirm('刪除此節點？（子節點不會一併刪除，會變成暫時沒有上層，建議先處理子節點）')) return;
        state.supplyChainNodes = state.supplyChainNodes.filter(n => n.id !== id);
        state.supplyChainNodes.forEach(n => { n.parentIds = (n.parentIds || []).filter(p => p !== id); });
        state.companyLinks = state.companyLinks.filter(l => l.nodeId !== id);
        if (chainSelectedNodeId === id) { chainSelectedNodeId = null; chainSelectedSymbol = null; }
        save(); renderChainEdit(); renderChainTree(); renderChainDetail();
      });
    });

    const linkListEl = document.getElementById('chain-link-list');
    linkListEl.innerHTML = state.companyLinks.length ? state.companyLinks.map((l, i) => `
      <div class="chain-manage-row">
        <span><strong>${escapeHtml(l.symbol)}</strong> → ${escapeHtml(scNode(l.nodeId)?.name || '（節點已刪除）')}${l.role ? `（${escapeHtml(l.role)}）` : ''}</span>
        <button type="button" class="row-del" data-del-link="${i}" title="刪除">✕</button>
      </div>
    `).join('') : '<p class="empty-state">尚無公司關聯。</p>';
    linkListEl.querySelectorAll('[data-del-link]').forEach(btn => {
      btn.addEventListener('click', () => {
        state.companyLinks.splice(+btn.dataset.delLink, 1);
        save(); renderChainEdit(); renderChainTree(); renderChainDetail();
      });
    });
  }

  document.getElementById('chain-node-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('cn-name').value.trim();
    if (!name) return;
    const parentId = document.getElementById('cn-parent').value;
    const stage = document.getElementById('cn-stage').value;
    state.supplyChainNodes.push({ id: 'n_' + uid(), name, parentIds: parentId ? [parentId] : [], stage: stage || null });
    save();
    e.target.reset();
    renderChainEdit(); renderChainTree();
  });

  document.getElementById('chain-link-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const symbol = document.getElementById('cl-symbol').value.trim();
    const nodeId = document.getElementById('cl-node').value;
    const role = document.getElementById('cl-role').value.trim();
    if (!symbol || !nodeId) return;
    state.companyLinks.push({ symbol, nodeId, role });
    save();
    e.target.reset();
    renderChainEdit(); renderChainTree(); renderChainDetail();
  });

  // ================= MODALS shared =================
  function closeModals() {
    document.querySelectorAll('.modal-overlay').forEach(m => m.classList.remove('open'));
  }
  document.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', closeModals));
  document.querySelectorAll('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', (e) => { if (e.target === ov) closeModals(); });
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModals(); });

  // ================= EXPORT / IMPORT =================
  document.getElementById('btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `trading-journal-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  const fileImport = document.getElementById('file-import');
  document.getElementById('btn-import').addEventListener('click', () => fileImport.click());
  fileImport.addEventListener('change', () => {
    const file = fileImport.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.trades) || !Array.isArray(data.diary)) throw new Error('格式不符');
        if (confirm('匯入將覆蓋目前所有本機資料，確定繼續？')) {
          state = migrate(data); save(); renderTrades(); renderStats();
        }
      } catch (err) {
        alert('匯入失敗：檔案格式不正確。');
      }
      fileImport.value = '';
    };
    reader.readAsText(file);
  });

  // ================= AUTH =================
  const loginGate = document.getElementById('login-gate');
  const appRoot = document.getElementById('app-root');
  const loginStatus = document.getElementById('login-status');
  const userChip = document.getElementById('user-chip');

  document.getElementById('btn-google-signin').addEventListener('click', () => {
    loginStatus.textContent = '登入中…';
    signInWithPopup(auth, new GoogleAuthProvider()).catch(e => {
      console.error('signIn failed', e);
      loginStatus.textContent = '登入失敗：' + (e.code || e.message);
    });
  });

  document.getElementById('btn-signout').addEventListener('click', () => signOut(auth));

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      currentUser = user;
      loginGate.style.display = 'none';
      appRoot.hidden = false;
      userChip.textContent = user.displayName || user.email || '';
      await loadFromCloud(user.uid);
    } else {
      currentUser = null;
      loginGate.style.display = 'flex';
      appRoot.hidden = true;
      loginStatus.textContent = '';
    }
  });

  // ================= init =================
  renderTrades();
})();
