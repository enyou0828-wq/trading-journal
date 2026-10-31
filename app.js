import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-auth.js";
import { getFirestore, doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-firestore.js";
import { getMessaging, isSupported as isMessagingSupported, getToken, onMessage } from "https://www.gstatic.com/firebasejs/10.13.1/firebase-messaging.js";
import { firebaseConfig } from "./firebase-config.js";
import { SUPPLY_CHAIN_NODES, COMPANY_LINKS } from "./supplyChainData.js";
import { VAPID_KEY } from "./push-config.js";

// 族群分頁模組；版本號由 pre-commit hook 在 groups.js 改動時自動更新
const GROUPS_JS = './groups.js?v=20261031110056';

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

(() => {
  'use strict';

  const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];
  // 新增交易只能選這兩種；舊紀錄裡的其他策略名稱（量縮突破、族群效應…）原樣保留，篩選與統計會自動列出
  const STRATEGIES = ['盤整突破', '動能延續'];
  function strategyList() {
    const legacy = [...new Set(state.trades.map(t => t.strategy).filter(n => n && !STRATEGIES.includes(n)))].sort();
    return [...STRATEGIES, ...legacy];
  }
  const ENTRY_ACTIONS = new Set(['買進', '加碼']);
  const EXIT_ACTIONS = new Set(['減碼', '賣出', '加碼轉賣出']);

  // 每筆交易的損益（f-profit-wan，單位：萬元）是唯一手動輸入的原始金額；
  // 資金加權累計報酬（曲線／總計）跟各月份資金加權報酬都是從這個金額即時換算成 % 顯示，
  // 差別只在分母用哪個資金基準：
  //   - fixedCapitalBasis：固定兩段式基準（8/1 起 70 萬，之前 100 萬）。
  //     資金加權累計報酬曲線／總計永遠用這個，代表「以固定基準為底」的加權報酬指數，不是真實資產報酬率。
  //   - monthlyCapitalBasis（透過 buildMonthlyCapitalBasisMap）：MONTHLY_CAPITAL_BASE 表列的當月實際
  //     總資產；表列之外的月份自動複利延伸＝上個月的底 + 上個月真實總損益，不用每個月手動加資料
  //     （例如表列最後是 9 月 55 萬，10 月就自動算成 55 萬 + 9 月總損益，11 月再用 10 月的結果繼續延伸）。
  //     只用在各月份資金加權報酬（月度統計表／長條圖），代表當月真實報酬率。
  const CAPITAL_AUG_CUTOFF = '2026-08-01';
  const MONTHLY_CAPITAL_BASE = {
    '2026-05': 750000,
    '2026-06': 1270000,
    '2026-07': 1420000,
    '2026-08': 650000,
    '2026-09': 550000,
  };
  function fixedCapitalBasis(dateStr) {
    return dateStr >= CAPITAL_AUG_CUTOFF ? 700000 : 1000000;
  }
  function monthKey(dateStr) { return dateStr.slice(0, 7); }
  function nextMonthKey(m) {
    const [y, mo] = m.split('-').map(Number);
    const d = new Date(y, mo, 1); // mo 是 1-indexed字串，new Date 用 0-indexed 月份，兩者相減剛好等於下個月
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  function buildMonthlyCapitalBasisMap(realizedTrades) {
    const profitByMonth = {};
    realizedTrades.forEach(t => {
      if (t.profitWan == null) return;
      const m = monthKey(t.date);
      profitByMonth[m] = (profitByMonth[m] || 0) + t.profitWan;
    });

    const anchorMonths = Object.keys(MONTHLY_CAPITAL_BASE).sort();
    if (!anchorMonths.length) return {};
    const lastAnchor = anchorMonths[anchorMonths.length - 1];
    const tradeMonths = Object.keys(profitByMonth).sort();
    const latestMonth = tradeMonths.length ? tradeMonths[tradeMonths.length - 1] : lastAnchor;

    const basisMap = { ...MONTHLY_CAPITAL_BASE };
    let cursor = lastAnchor;
    let basis = MONTHLY_CAPITAL_BASE[lastAnchor];
    while (cursor < latestMonth) {
      basis += (profitByMonth[cursor] || 0) * 10000;
      cursor = nextMonthKey(cursor);
      if (MONTHLY_CAPITAL_BASE[cursor] != null) basis = MONTHLY_CAPITAL_BASE[cursor]; // 手動指定過的月份優先
      basisMap[cursor] = basis;
    }
    return basisMap;
  }
  // 損益（萬）換算成相對於某個資金基準（元）的百分比報酬
  function profitPct(profitWan, dateStr, basisFn) {
    return (profitWan * 10000 / basisFn(dateStr)) * 100;
  }
  function monthlyProfitPct(profitWan, dateStr, basisMap) {
    const basis = basisMap[monthKey(dateStr)] != null ? basisMap[monthKey(dateStr)] : fixedCapitalBasis(dateStr);
    return (profitWan * 10000 / basis) * 100;
  }
  // 資金加權累計報酬曲線只看 6/1 之後的紀錄，6/1 當天視為 0% 起點（之前的紀錄不計入這條曲線）
  // 報酬累計曲線的起點：個人、櫃買、加權三條線都從這天的 0% 起算（原本 6/1 起的圖已移除）
  const EQUITY_CURVE_START = '2026-09-01';
  // 這張曲線個人報酬的分母：起點當天的實際淨值（9/1 = 9 月月初資金 55 萬），
  // 所以藍線＝起點以來的真實報酬率。只影響這張圖，總覽的資金加權累計報酬仍用 fixedCapitalBasis。
  const EQUITY_CURVE_CAPITAL = 550000;

  // ---- 供應鏈資料模型 ----
  // 節點是扁平陣列，用 parentIds（可多個上層）表達階層，不用巢狀樹狀結構，
  // 這樣同一個子產業（例如 CPO）可以同時屬於多條供應鏈／多個上層分類，只要在 parentIds 多加一個 id 即可，不需要複製節點。
  // 公司與節點是多對多關聯（companyLinks），一家公司可以同時掛在多個供應鏈節點上。
  // 種子資料（SUPPLY_CHAIN_NODES / COMPANY_LINKS）抽離在 supplyChainData.js，跟這裡的 App 邏輯完全分離，
  // 之後要調整供應鏈分類/公司清單只需要改那個檔案，不用動這裡任何一行程式碼。
  // 台灣櫃買指數（TPEx OTC Index）每日收盤，作為資金加權報酬曲線的對照基準。
  // 歷史資料存在 data/otc_index.json（{"YYYY-MM-DD": 收盤點數}），由
  // .github/workflows/daily-otc-update.yml 每個交易日自動呼叫 TPEx OpenAPI 補上最新一筆、
  // commit 回這個檔案——app.js 只在頁面載入時 fetch 這份 JSON，不用再手動編輯這裡維護資料。
  // 6/19（端午節）、7/10 為休市日，已從交易日序列中排除。
  const OTC_INDEX_CLOSE = {};
  let otcDataLoaded = false;
  async function ensureOtcData() {
    if (otcDataLoaded) return;
    try {
      const res = await fetch('data/otc_index.json', { cache: 'no-store' });
      if (res.ok) Object.assign(OTC_INDEX_CLOSE, await res.json());
    } catch (e) { /* 讀取失敗就不畫對照線，不影響個人紀錄本身的統計 */ }
    otcDataLoaded = true;
  }
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
    // 5 月沒有每日收盤資料可算，使用者提供官方月報酬數字直接寫死
    result['2026-05'] = 15.53;
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
    // 保證序列的第一個點（基準日，數學上一定是 0%）不會被同一個 bin 裡較晚的日期蓋掉——
    // bin 的分界是跟著 binStart（個人曲線第一筆交易的日期）對齊，不是跟著這條線自己的
    // 起始日期對齊，兩者的「第一個 3 天區間」常常沒有剛好卡在起始日那天，導致起始日
    // 跟隔壁一兩天被分進同一桶，桶內「取最後一筆」的規則就會讓起始日的 0% 被洗掉，
    // 畫出來變成「第一個點不在 0%」。這裡強制把第一個 bin 覆寫回序列自己的起點。
    const firstIdx = Math.floor((raw[0].ts - binStart) / binMs);
    bins.set(firstIdx, raw[0]);
    return [...bins.keys()].sort((a, b) => a - b).map(k => ({ ...bins.get(k), binTs: binStart + k * binMs }));
  }

  // 加權指數（TAIEX／TWI，臺灣證券交易所發行量加權股價指數）每日收盤，作為資金加權報酬曲線的
  // 第二條對照線（櫃買指數是第一條）。歷史資料存在 data/twi_index.json（{"YYYY-MM-DD": 收盤指數}），
  // 由 .github/workflows/daily-twi-update.yml 每個交易日自動呼叫 TWSE 網站補上最新一筆、
  // commit 回這個檔案——跟 OTC_INDEX_CLOSE 同一套機制，app.js 只在頁面載入時 fetch 這份 JSON。
  const TWI_INDEX_CLOSE = {};
  let twiDataLoaded = false;
  async function ensureTwiData() {
    if (twiDataLoaded) return;
    try {
      const res = await fetch('data/twi_index.json', { cache: 'no-store' });
      if (res.ok) Object.assign(TWI_INDEX_CLOSE, await res.json());
    } catch (e) { /* 讀取失敗就不畫對照線，不影響個人紀錄本身的統計 */ }
    twiDataLoaded = true;
  }

  function computeTwiSeries(binStart, binDays, startDate) {
    let dates = Object.keys(TWI_INDEX_CLOSE).sort();
    if (startDate) dates = dates.filter(d => d >= startDate);
    if (!dates.length) return [];
    const base = TWI_INDEX_CLOSE[dates[0]];
    const raw = dates.map(d => ({ date: d, ts: parseDateTs(d), value: (TWI_INDEX_CLOSE[d] / base - 1) * 100 }));
    if (!binDays) return raw;
    const binMs = binDays * 24 * 60 * 60 * 1000;
    const bins = new Map();
    raw.forEach(p => {
      const idx = Math.floor((p.ts - binStart) / binMs);
      bins.set(idx, p);
    });
    // 同 computeOtcSeries：強制第一個 bin 回到序列自己的起點，避免起始日的 0% 被同一桶內
    // 較晚的日期蓋掉。
    const firstIdx = Math.floor((raw[0].ts - binStart) / binMs);
    bins.set(firstIdx, raw[0]);
    return [...bins.keys()].sort((a, b) => a - b).map(k => ({ ...bins.get(k), binTs: binStart + k * binMs }));
  }

  // 各月加權指數報酬率：算法跟 computeOtcMonthlyReturns 一樣（該月最後一個交易日收盤
  // 相對前一月最後一個交易日收盤）。data/twi_index.json 跟 OTC_INDEX_CLOSE 一樣只從
  // 6/1 開始每日累積，所以 5 月同樣沒有逐日資料可以算，但這裡直接去查證過加權指數的
  // 官方歷史收盤（TWSE 網站 MI_INDEX type=IND 端點）：2026-04-30 收盤 38,926.63，
  // 2026-05-29（5月最後一個交易日）收盤 44,732.94，算出 5 月報酬 +14.92%，寫死在這裡
  // （不是用戶口頭提供的數字，是直接向資料源查證過的）。
  function computeTwiMonthlyReturns() {
    const dates = Object.keys(TWI_INDEX_CLOSE).sort();
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
      const endClose = TWI_INDEX_CLOSE[lastDateOfMonth[m]];
      const startClose = i === 0 ? TWI_INDEX_CLOSE[firstDateOfMonth[m]] : TWI_INDEX_CLOSE[lastDateOfMonth[months[i - 1]]];
      result[m] = (endClose / startClose - 1) * 100;
    });
    result['2026-05'] = 14.92;
    return result;
  }

  // ---- 紅黃綠燈號 ----
  const LIGHT_ORDER = ['green', 'yellow', 'red'];
  function lampHtml(color) {
    return `<span class="lamp">${LIGHT_ORDER.map(c => `<i class="lamp-dot ${c}${c === color ? ' on' : ''}"></i>`).join('')}</span>`;
  }

  // 大盤水位（2026-10-25 版規則）：收盤跌破月線 → 30%；站回月線 → 50%、再站上 10 日線 → 70%、
  // 再站上 5 日線 → 滿倉、創新高 → 槓桿。新高＝收盤 ≥ 資料內最高收盤。
  function indexLevel(closeMap) {
    const dates = Object.keys(closeMap).sort();
    if (dates.length < 20) return null;
    const closes = dates.map(d => closeMap[d]);
    const n = closes.length, c = closes[n - 1];
    const ma = k => closes.slice(n - k).reduce((a, v) => a + v, 0) / k;
    const ma5 = ma(5), ma10 = ma(10), ma20 = ma(20);
    const high = Math.max(...closes);
    let level, color;
    if (c < ma20) { level = '30%'; color = 'red'; }
    else if (c < ma10) { level = '50%'; color = 'yellow'; }
    else if (c < ma5) { level = '70%'; color = 'yellow'; }
    else if (c < high) { level = '100%'; color = 'green'; }
    else { level = '槓桿'; color = 'green'; }
    const dist = v => (c / v - 1) * 100;
    return {
      date: dates[n - 1], close: c, chg: (c / closes[n - 2] - 1) * 100, level, color,
      checks: [['月線', dist(ma20)], ['10日線', dist(ma10)], ['5日線', dist(ma5)], ['新高', dist(high)]],
    };
  }

  async function renderMarketLevel() {
    const el = document.getElementById('market-level');
    if (!el) return;
    await ensureTwiData();
    await ensureOtcData();
    const rows = [['加權', indexLevel(TWI_INDEX_CLOSE)], ['櫃買', indexLevel(OTC_INDEX_CLOSE)]].filter(r => r[1]);
    if (!rows.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="chart-card ml-card">
      <div class="chart-head"><h2>大盤水位</h2><span class="ml-date">${rows[0][1].date}</span></div>
      ${rows.map(([name, r]) => `
        <div class="ml-row">
          ${lampHtml(r.color)}
          <div class="ml-name">${name}<span class="ml-close">${r.close.toLocaleString('zh-TW', { maximumFractionDigits: 2 })} <b class="${r.chg >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtPct(r.chg, 2)}</b></span></div>
          <div class="ml-level light-${r.color}">${r.level}</div>
          <div class="ml-checks">${r.checks.map(([k, d]) => `<span class="ml-chip ${d >= 0 ? 'ok' : 'no'}">${d >= 0 ? '✓' : '✗'} ${k} <em>${fmtPct(d, 1)}</em></span>`).join('')}</div>
        </div>`).join('')}
    </div>`;
  }

  // 個人回撤：9/1 起的已實現報酬累計（分母 55 萬），相對歷史高點的回落。紅線 7.5%、黃線為一半。
  const DD_RED = 7.5, DD_YELLOW = 3.75;
  function computeDrawdown(items) {
    const sorted = [...items].sort((a, b) => a.date > b.date ? 1 : a.date < b.date ? -1 : 0);
    let cum = 0, peak = 1, peakDate = EQUITY_CURVE_START, maxDd = 0;
    for (const t of sorted) {
      cum += t.contrib;
      const eq = 1 + cum / 100;
      if (eq >= peak) { peak = eq; peakDate = t.date; }
      maxDd = Math.max(maxDd, (1 - eq / peak) * 100);
    }
    const dd = (1 - (1 + cum / 100) / peak) * 100;
    const color = dd >= DD_RED ? 'red' : dd >= DD_YELLOW ? 'yellow' : 'green';
    const status = { green: '正常', yellow: '注意', red: '停止新倉' }[color];
    return { dd, color, status, peakDate, maxDd };
  }
  function renderDrawdownLight(items) {
    const el = document.getElementById('dd-light');
    if (!el) return;
    const { dd, color, status, peakDate, maxDd } = computeDrawdown(items);
    el.innerHTML = `<div class="dd-row">
      ${lampHtml(color)}
      <div class="dd-main"><span class="dd-status light-${color}">${status}</span><span class="dd-val">${dd > 0.005 ? '−' + dd.toFixed(2) : '0.00'}%</span></div>
      <div class="dd-meta">
        <span>高點 <b>${peakDate.slice(5).replace('-', '/')}</b></span>
        <span>距紅線 <b>${Math.max(0, DD_RED - dd).toFixed(2)}%</b></span>
        <span>最大回撤 <b>${maxDd > 0.005 ? '−' + maxDd.toFixed(2) : '0.00'}%</b></span>
      </div>
    </div>`;
  }

  // ---------- state ----------
  let state = { trades: [], diary: [], monthlyReviews: [], watchlist: [], holdings: [], futures: [], fcmTokens: [] };
  let currentUser = null;
  // 雲端資料讀取成功前不准寫回，避免讀取失敗時用空資料覆蓋雲端
  let cloudLoaded = false;

  const syncStatusEl = document.getElementById('sync-status');
  function setSyncStatus(text) { if (syncStatusEl) syncStatusEl.textContent = text; }
  syncStatusEl?.addEventListener('click', () => {
    if (cloudLoaded || !currentUser || !syncStatusEl.classList.contains('sync-retry')) return;
    syncStatusEl.classList.remove('sync-retry');
    loadFromCloud(currentUser.uid);
  });

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
    // 匯入舊版（不含供應鏈資料）的檔案時，補上空陣列，避免供應鏈分頁因欄位不存在而壞掉。
    // 若匯入的檔案本身就有供應鏈資料，這裡不會動它，原樣保留（含使用者後續編輯過的內容）。
    if (!Array.isArray(data.supplyChainNodes)) data.supplyChainNodes = [];
    if (!Array.isArray(data.companyLinks)) data.companyLinks = [];
    if (!Array.isArray(data.monthlyReviews)) data.monthlyReviews = [];
    // 舊的匯出檔可能沒有這些欄位，補空陣列避免畫面出錯
    for (const k of ['watchlist', 'holdings', 'futures', 'fcmTokens']) if (!Array.isArray(data[k])) data[k] = [];
    return data;
  }

  async function loadFromCloud(uid) {
    setSyncStatus('讀取中…');
    try {
      const snap = await getDoc(doc(db, 'journals', uid));
      state = snap.exists() ? migrate(snap.data()) : migrate({ trades: [], diary: [] });
      cloudLoaded = true;
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

      // 一次性換算：5～9 月改用 MONTHLY_CAPITAL_BASE 的精確月資金，取代原本兩段式的 100萬/70萬。
      // 換算方式：新資金佔比 = 舊資金佔比 ×（換算前的兩段式基準 ÷ 新的精確月基準），
      // 只調整這幾個月份的紀錄，其餘月份不受影響。
      if (!state.capitalBaseMonthlyV1) {
        state.trades = state.trades.map(t => {
          if (t.positionPct == null) return t;
          const month = t.date.slice(0, 7);
          if (MONTHLY_CAPITAL_BASE[month] == null) return t;
          const oldBasis = t.date >= CAPITAL_AUG_CUTOFF ? 700000 : 1000000;
          const newBasis = MONTHLY_CAPITAL_BASE[month];
          return { ...t, positionPct: Math.round(t.positionPct * (oldBasis / newBasis) * 10) / 10 };
        });
        state.capitalBaseMonthlyV1 = true;
        await save();
      }

      // 一次性換算（V1 的補漏）：V1 只換算了 positionPct，但有些紀錄是直接手動填「資金加權貢獻」
      // （positionPct 是空的，contrib 才是實際存的值），這些完全沒被 V1 動到。用同一套換算比例
      // 直接調整 contrib 本身：新 contrib = 舊 contrib ×（換算前的兩段式基準 ÷ 新的精確月基準）。
      if (!state.capitalBaseMonthlyV2) {
        state.trades = state.trades.map(t => {
          if (t.contrib == null) return t;
          const month = t.date.slice(0, 7);
          if (MONTHLY_CAPITAL_BASE[month] == null) return t;
          const oldBasis = t.date >= CAPITAL_AUG_CUTOFF ? 700000 : 1000000;
          const newBasis = MONTHLY_CAPITAL_BASE[month];
          return { ...t, contrib: Math.round(t.contrib * (oldBasis / newBasis) * 100) / 100 };
        });
        state.capitalBaseMonthlyV2 = true;
        await save();
      }

      // 一次性復原：V1+V2 的精確月資金換算會連帶改到資金加權累計報酬曲線（跟月度統計共用同一份
      // 底層資料），但那條曲線不該被這次調整影響，所以整個復原成兩段式 100萬/70萬 基準原本的樣子。
      // 換算方式：對 V1/V2 已經套用過的同一批紀錄，乘上反方向的比例（新精確基準 ÷ 換算前的兩段式基準）。
      if (!state.capitalBaseMonthlyRevert) {
        state.trades = state.trades.map(t => {
          const month = t.date.slice(0, 7);
          if (MONTHLY_CAPITAL_BASE[month] == null) return t;
          const oldBasis = t.date >= CAPITAL_AUG_CUTOFF ? 700000 : 1000000;
          const newBasis = MONTHLY_CAPITAL_BASE[month];
          const inverseFactor = newBasis / oldBasis;
          const updated = { ...t };
          if (t.positionPct != null) updated.positionPct = Math.round(t.positionPct * inverseFactor * 10) / 10;
          if (t.contrib != null) updated.contrib = Math.round(t.contrib * inverseFactor * 100) / 100;
          return updated;
        });
        state.capitalBaseMonthlyRevert = true;
        await save();
      }

      // 一次性建立：新增 profitWan（損益，萬元）取代 positionPct/contrib 當作資金加權計算的原始輸入。
      // 換算方式：舊的資金加權貢獻 %（contrib，或用 positionPct×returnPct/100 推算）本來就是相對於
      // 固定兩段式基準算出來的，所以 profitWan = 舊 % × 固定基準 ÷ 100 ÷ 10000。
      // positionPct/contrib 兩個舊欄位保留在資料裡當歷史紀錄，之後的計算都不會再讀它們。
      if (!state.profitWanMigrationV1) {
        state.trades = state.trades.map(t => {
          const contribPct = t.contrib != null
            ? t.contrib
            : (t.positionPct != null && t.returnPct != null ? t.returnPct * t.positionPct / 100 : null);
          if (contribPct == null) return t;
          const profitWan = Math.round((contribPct / 100) * fixedCapitalBasis(t.date) / 10000 * 100) / 100;
          return { ...t, profitWan };
        });
        state.profitWanMigrationV1 = true;
        await save();
      }

      // 一次性建立/升級：供應鏈資料模型（節點 + 公司關聯），改用完整版種子資料（supplyChainData.js）。
      // 種子資料建立後完全開放編輯，不會再被自動覆蓋；只在第一次（或從舊版簡化種子升級）時執行一次。
      if (!state.supplyChainSeedV2) {
        state.supplyChainNodes = SUPPLY_CHAIN_NODES.map(n => ({ ...n, parentIds: [...n.parentIds] }));
        state.companyLinks = COMPANY_LINKS.map(l => ({ ...l }));
        state.supplyChainSeeded = true;
        state.supplyChainSeedV2 = true;
        await save();
      }
      if (!Array.isArray(state.supplyChainNodes)) state.supplyChainNodes = [];
      if (!Array.isArray(state.companyLinks)) state.companyLinks = [];

      // 一次性移除：車用電子分類（automotive 及其專屬子節點）與公司 4927（泰鼎-KY）。
      // automotive_pcb 因為同時掛在 pcb 底下（多重上層），保留節點本身，只拿掉跟 automotive 的關聯。
      if (!state.supplyChainRemoveAutomotive) {
        const removeIds = new Set(['automotive', 'automotive_semiconductor', 'adas', 'ev', 'automotive_power', 'automotive_sensor']);
        state.supplyChainNodes = state.supplyChainNodes
          .filter(n => !removeIds.has(n.id))
          .map(n => removeIds.has(n.id) ? n : { ...n, parentIds: (n.parentIds || []).filter(p => !removeIds.has(p)) });
        state.companyLinks = state.companyLinks.filter(l => !removeIds.has(l.nodeId) && l.symbol !== '4927');
        state.supplyChainRemoveAutomotive = true;
        await save();
      }

      // 一次性升級：標記從單一黃色（布林值 marked）改成雙色（markColor: '' / 'yellow' / 'red'）。
      // 舊資料的 marked === true 一律視為黃色標記，維持原本的意義不變。
      if (!state.markColorMigrated) {
        state.trades = state.trades.map(t => t.marked && !t.markColor ? { ...t, markColor: 'yellow' } : t);
        state.markColorMigrated = true;
        await save();
      }

      // 一次性改名：策略B「沿線上行」改叫「動能延續」
      if (!state.strategyRenameMomentumV1) {
        state.trades = state.trades.map(t => t.strategy === '沿線上行' ? { ...t, strategy: '動能延續' } : t);
        state.strategyRenameMomentumV1 = true;
        await save();
      }

      if (!Array.isArray(state.watchlist)) state.watchlist = [];
      if (!Array.isArray(state.holdings)) state.holdings = [];
      if (!Array.isArray(state.futures)) state.futures = [];
      if (!Array.isArray(state.fcmTokens)) state.fcmTokens = [];
      if (migrateHoldings()) await save();

      if (ensureMonthlyReviews()) await save();
    } catch (e) {
      console.error('loadFromCloud failed', e);
      if (!cloudLoaded) {
        setSyncStatus('讀取失敗・點此重試');
        syncStatusEl?.classList.add('sync-retry');
        alert('讀取雲端資料失敗（' + (e.code || e.message) + '），請檢查網路後點右上角「點此重試」。');
      } else {
        setSyncStatus('同步失敗');
      }
    }
    renderTrades(); renderStats();
  }

  async function save() {
    if (!currentUser) return;
    if (!cloudLoaded) {
      alert('雲端資料還沒讀取成功，這次修改不會儲存。請先點右上角「點此重試」。');
      return;
    }
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
  const fmtWan = (n, digits = 2) => n == null ? '–' : (n >= 0 ? '+' : '') + n.toFixed(digits) + '萬';
  const isExitAction = (a) => EXIT_ACTIONS.has(a) || a === '當沖';
  const displayProfitWan = (t) => t.profitWan != null ? t.profitWan : null;

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
      if (target === 'holdings') { renderMarketLevel(); renderHoldings(); }
      if (target === 'stats') { renderStats(); renderChainResults(); renderChainDetail(); }
      if (target === 'review') renderMonthlyReview();
      if (target === 'chain') import(GROUPS_JS).then(m => m.renderGroups(document.getElementById('groups-root')));
      if (target === 'signals') { renderBattleCard(); renderSignals(); renderParallel(); }
      if (target === 'watchlist') renderWatchlist();
    });
  });

  // ================= SIGNALS =================
  let signalsLoaded = false;

  function signalGroupHtml(s) {
    if (!s.industry && !s.sub_group) return '–';
    if (s.industry && s.sub_group) {
      return `${escapeHtml(s.industry)} <span style="color:var(--text-muted)">· ${escapeHtml(s.sub_group)}</span>`;
    }
    return escapeHtml(s.industry || s.sub_group);
  }

  function signalRowsHtml(signals) {
    return signals.map(s => {
      const changeClass = s.daily_change_pct == null ? 'pnl-zero' : s.daily_change_pct > 0 ? 'pnl-pos' : s.daily_change_pct < 0 ? 'pnl-neg' : 'pnl-zero';
      const changeText = s.daily_change_pct == null ? '–' : (s.daily_change_pct > 0 ? '+' : '') + s.daily_change_pct + '%';
      const vcpHtml = s.consolidation_days != null
        ? `<br><span style="color:var(--text-muted)">整理${s.consolidation_days}天 · 收縮${s.contraction_count}次 · 突破價${s.breakout_level} · 前低${s.last_contraction_low}</span>`
        : '';
      return `
        <tr>
          <td><strong>${escapeHtml(s.code)}</strong> <span style="color:var(--text-muted)">${escapeHtml(s.name)}</span></td>
          <td class="num">${s.close != null ? s.close : '–'}</td>
          <td class="num ${changeClass}">${changeText}</td>
          <td class="num">${s.volume != null ? Math.round(s.volume / 1000).toLocaleString('zh-TW') + '張' : '–'}</td>
          <td>${signalGroupHtml(s)}${vcpHtml}</td>
        </tr>
      `;
    }).join('');
  }

  function signalSetHtml(set) {
    const bodyHtml = set.signals.length
      ? `<div class="table-wrap">
          <table class="trade-table">
            <thead>
              <tr>
                <th>股票</th><th class="num">收盤價</th><th class="num">當日漲幅</th><th class="num">成交量</th><th>族群</th>
              </tr>
            </thead>
            <tbody>${signalRowsHtml(set.signals)}</tbody>
          </table>
        </div>`
      : `<p class="empty-state">今天沒有符合條件的訊號。</p>`;
    return `
      <div class="chart-card">
        <div class="chart-head"><h2>${escapeHtml(set.label)}</h2></div>
        ${bodyHtml}
      </div>
    `;
  }

  function groupRotationSetHtml(groups) {
    const rowsHtml = groups.map(g => {
      const stocksLine = g.stocks.map(s =>
        `<strong>${escapeHtml(s.code)}</strong> ${escapeHtml(s.name)} <span class="pnl-pos">${s.daily_change_pct > 0 ? '+' : ''}${s.daily_change_pct}%</span>`
      ).join('　');
      return `
        <tr>
          <td>${escapeHtml(g.group)}</td>
          <td class="num">${g.triggered_count}/${g.total_in_group}</td>
          <td>${stocksLine}</td>
        </tr>
      `;
    }).join('');
    const bodyHtml = groups.length
      ? `<div class="table-wrap">
          <table class="trade-table">
            <thead><tr><th>族群</th><th class="num">家數</th><th>股票</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>`
      : `<p class="empty-state">今天沒有族群同步噴出。</p>`;
    return `
      <div class="chart-card">
        <div class="chart-head"><h2>族群同步噴出</h2></div>
        ${bodyHtml}
      </div>
    `;
  }

  async function renderSignals() {
    if (signalsLoaded) return;
    signalsLoaded = true;

    const metaEl = document.getElementById('signals-meta');
    const setsEl = document.getElementById('signals-sets');

    try {
      const res = await fetch('signals/latest.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();

      const dateText = data.markets_in_sync === false
        ? `上市 ${data.twse_date}／上櫃 ${data.tpex_date}（尚未同步，其中一邊還沒發布最新資料）`
        : `資料日期 ${data.scan_date}`;
      metaEl.textContent = `${dateText}　更新於 ${new Date(data.generated_at).toLocaleString('zh-TW')}`;
      const groups = data.group_rotation ? data.group_rotation.groups : [];
      setsEl.innerHTML = data.sets.map(signalSetHtml).join('') + groupRotationSetHtml(groups);
    } catch (e) {
      metaEl.textContent = '';
      setsEl.innerHTML = `<p class="empty-state">讀取訊號失敗：${escapeHtml(e.message)}</p>`;
      signalsLoaded = false; // 失敗的話下次切回這個 tab 要重試
    }
  }

  // ================= 盤前作戰卡 =================
  const jsonCache = {};
  function fetchJsonCached(path) {
    if (!jsonCache[path]) jsonCache[path] = fetch(path, { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(e => { delete jsonCache[path]; throw e; });
    return jsonCache[path];
  }

  // 庫存出場規則（10/25 版）：用均價當成本，資料是最近 7 個交易日的高低收
  function holdingExitChecks(h, rec) {
    const st = rec.stocks[h.symbol];
    if (!st) return null;
    const { h: H, l: L, c: C } = st;
    const n = C.length - 1;
    const cost = holdingTotals(h).avgEntryPrice;
    const hits = [];
    if (C[n] != null && L[n - 1] != null && C[n] < L[n - 1]) hits.push('收破前日低');
    const maxH = (a, b) => Math.max(...H.slice(a, b).filter(v => v != null));
    if (n >= 6 && H[n] != null && H[n - 1] != null && H[n] <= maxH(n - 5, n) && H[n - 1] <= maxH(n - 6, n - 1)) hits.push('連兩天沒創5日新高');
    const idx = st.m === 'T' ? TWI_INDEX_CLOSE : OTC_INDEX_CLOSE;
    const i1 = idx[rec.dates[n]], i0 = idx[rec.dates[n - 1]];
    if (i1 && i0 && C[n] != null && C[n - 1]) {
      const lag = (C[n] / C[n - 1] - 1) * 100 - (i1 / i0 - 1) * 100;
      if (lag <= -5) hits.push('落後指數5%');
    }
    if (cost > 0 && L[n] != null && L[n] <= cost * 0.93) hits.push('觸及成本−7%');
    else if (cost > 0 && C[n] != null && C[n] < cost * 0.95) hits.push('收破成本−5%');
    return { hits, close: C[n], pnl: cost > 0 && C[n] != null ? (C[n] / cost - 1) * 100 : null };
  }

  async function renderBattleCard() {
    const el = document.getElementById('battle-card');
    if (!el) return;
    let latest, rec, groups;
    try {
      [latest, rec, groups] = await Promise.all([
        fetchJsonCached('signals/latest.json'), fetchJsonCached('signals/recent_ohlc.json'),
        fetchJsonCached('signals/groups.json').catch(() => null), ensureTwiData(), ensureOtcData(),
      ]);
    } catch (e) { el.innerHTML = ''; return; }

    const lv = [['加權', indexLevel(TWI_INDEX_CLOSE)], ['櫃買', indexLevel(OTC_INDEX_CLOSE)]].filter(r => r[1]);
    const dd = computeDrawdown(equityCurveItems());
    const tiles = lv.map(([name, r]) => `
        <div class="bc-tile">${lampHtml(r.color)}<span class="bc-k">${name}水位</span><span class="bc-v light-${r.color}">${r.level}</span></div>`).join('') + `
        <div class="bc-tile">${lampHtml(dd.color)}<span class="bc-k">個人回撤</span><span class="bc-v light-${dd.color}">${dd.dd > 0.005 ? '−' + dd.dd.toFixed(1) : '0.0'}%</span></div>`;

    const holdings = sortedHoldings();
    const holdRows = holdings.map(h => {
      const c = holdingExitChecks(h, rec);
      const label = `<strong>${escapeHtml(h.symbol)}</strong> ${escapeHtml(h.name || rec.stocks[h.symbol]?.n || '')}`;
      if (!c) return `<div class="bc-hold">${label}<span class="bc-chip">無資料</span></div>`;
      const pnl = c.pnl == null ? '' : `<span class="${c.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtPct(c.pnl, 1)}</span>`;
      const chips = c.hits.length ? c.hits.map(x => `<span class="bc-chip alert">${x}</span>`).join('') : '<span class="bc-chip ok">續抱</span>';
      return `<div class="bc-hold${c.hits.length ? ' hit' : ''}">${label} ${pnl}<span class="bc-chips">${chips}</span></div>`;
    }).sort((a, b) => b.includes(' hit') - a.includes(' hit')).join('');

    const quad = new Map((groups?.rrg || []).map(g => [g.group, g.quadrant]));
    const strong = q => q === '領先' || q === '改善';
    const setRows = latest.sets.filter(st => st.key !== 'vcp' || st.signal_count).map(st => {
      const name = st.key === 'fast' ? '盤整突破' : st.key === 'streak' ? '動能延續' : st.key === 'vcp' ? '量縮突破' : st.label;
      const list = [...st.signals].sort((a, b) => strong(quad.get(b.sub_group)) - strong(quad.get(a.sub_group)));
      const items = list.slice(0, 10).map(x => {
        const q = quad.get(x.sub_group);
        return `<span class="bc-sig${strong(q) ? ' strong' : ''}">${escapeHtml(x.code)} ${escapeHtml(x.name)}${x.sub_group ? `<em>${escapeHtml(x.sub_group)}${q ? '·' + q : ''}</em>` : ''}</span>`;
      }).join('');
      return `<div class="bc-set"><div class="bc-set-head">${name}<b>${st.signal_count}</b></div><div class="bc-sigs">${items || '<span class="bc-chip">無</span>'}${list.length > 10 ? `<span class="bc-more">+${list.length - 10}</span>` : ''}</div></div>`;
    }).join('');

    const today = taipeiDateStr();
    const due = sortedWatchlist().filter(w => !w.notified && w.reminderDate <= today);

    el.innerHTML = `<div class="chart-card bc-card">
      <div class="chart-head"><h2>盤前作戰卡</h2><span class="ml-date">${latest.scan_date}</span></div>
      <div class="bc-tiles">${tiles}</div>
      <div class="bc-sec"><h3>庫存出場檢查</h3>${holdRows || '<span class="bc-chip">無庫存</span>'}</div>
      <div class="bc-sec"><h3>今日訊號</h3>${setRows}</div>
      ${due.length ? `<div class="bc-sec"><h3>觀察清單到期</h3><div class="bc-sigs">${due.map(w => `<span class="bc-sig">${escapeHtml(w.code)} ${escapeHtml(w.name || '')}</span>`).join('')}</div></div>` : ''}
    </div>`;
  }

  // ================= 平行宇宙 =================
  async function renderParallel() {
    const el = document.getElementById('parallel-universe');
    if (!el) return;
    let pu;
    try { [pu] = await Promise.all([fetchJsonCached('signals/parallel.json'), ensureTwiData()]); }
    catch (e) { el.innerHTML = ''; return; }
    const st = pu.stats;
    // 個人實際：9/1 起已實現累計（與報酬累計曲線同口徑），補成每日階梯
    const items = equityCurveItems().sort((a, b) => a.date > b.date ? 1 : -1);
    let cum = 0, k = 0;
    const days = pu.curve.map(p => p.d);
    const actual = days.map(d => { while (k < items.length && items[k].date <= d) cum += items[k++].contrib; return cum; });
    const twiBase = TWI_INDEX_CLOSE[days[0]] || TWI_INDEX_CLOSE[Object.keys(TWI_INDEX_CLOSE).sort().filter(d => d < days[0]).pop()];
    let lastTwi = null;
    const twi = days.map(d => { if (TWI_INDEX_CLOSE[d]) lastTwi = (TWI_INDEX_CLOSE[d] / twiBase - 1) * 100; return lastTwi; });
    const sim = pu.curve.map(p => p.v);
    const gap = actual[actual.length - 1] - sim[sim.length - 1];

    const W = Math.max(320, Math.min(1100, Math.round(el.clientWidth - 48) || 900)), H = W < 600 ? 220 : 260, P = { t: 14, r: 10, b: 30, l: 46 };
    const all = [...sim, ...actual, ...twi.filter(v => v != null)];
    const lim = Math.max(5, Math.ceil(Math.max(...all.map(Math.abs)) * 1.15 / 5) * 5);
    const x = i => P.l + i / Math.max(1, days.length - 1) * (W - P.l - P.r);
    const y = v => P.t + (lim - v) / (2 * lim) * (H - P.t - P.b);
    const path = arr => arr.map((v, i) => v == null ? '' : `${i && arr[i - 1] != null ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    let grid = '';
    const step = lim <= 20 ? 5 : 10;
    for (let v = -lim; v <= lim; v += step) grid += `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--gridline)"/><text x="${P.l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--text-muted)" ${v === 0 ? 'font-weight="700"' : ''}>${v > 0 ? '+' : ''}${v}%</text>`;
    let ticks = '';
    days.forEach((d, i) => { if (d.endsWith('-01') || d.endsWith('-15') || i === 0) ticks += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${+d.slice(5, 7)}/${+d.slice(8)}</text>`; });

    const fmtN = v => v == null ? '–' : v.toFixed(2);
    const reasons = Object.entries(pu.exit_reasons).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<span class="bc-chip">${k} ${n}</span>`).join('');
    const rows = pu.trades.slice(0, 30).map(t => `<tr>
        <td><strong>${t.code}</strong> ${escapeHtml(t.name)}</td><td>${t.setup === 'A' ? '盤整突破' : '動能延續'}</td>
        <td class="num">${t.entry_d.slice(5)}</td><td class="num">${t.exit_d.slice(5)}</td>
        <td>${t.reason}</td><td class="num ${t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtPct(t.pnl, 2)}</td></tr>`).join('');
    const openRows = pu.open.map(t => `<span class="bc-sig">${t.code} ${escapeHtml(t.name)} <b class="${t.pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtPct(t.pnl, 1)}</b></span>`).join('');

    el.innerHTML = `<div class="chart-card pu-card">
      <div class="chart-head"><h2>平行宇宙</h2><span class="ml-date">${pu.start} ~ ${pu.last_date}</span></div>
      <div class="pu-stats">
        <div><span>規則版</span><b class="${st.ret >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtPct(st.ret, 2)}</b></div>
        <div><span>實際</span><b class="${actual[actual.length - 1] >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtPct(actual[actual.length - 1], 2)}</b></div>
        <div><span>執行落差</span><b class="${gap >= 0 ? 'pnl-pos' : 'pnl-neg'}">${fmtPct(gap, 2)}</b></div>
        <div><span>筆數 / 勝率</span><b>${st.trades} / ${st.winRate ?? '–'}%</b></div>
        <div><span>PF</span><b>${fmtN(st.pf)}</b></div>
        <div><span>最大回撤</span><b>−${fmtN(st.maxDd)}%</b></div>
      </div>
      <div class="legend">
        <div class="legend-item"><span class="legend-swatch" style="background:var(--series-4)"></span>規則版</div>
        <div class="legend-item"><span class="legend-swatch" style="background:var(--series-1)"></span>實際（已實現）</div>
        <div class="legend-item"><span class="legend-swatch" style="background:var(--series-2)"></span>加權指數</div>
      </div>
      <div class="chart-body"><svg viewBox="0 0 ${W} ${H}">${grid}${ticks}
        <path d="${path(twi)}" fill="none" stroke="var(--series-2)" stroke-width="1.5" stroke-dasharray="4,3"/>
        <path d="${path(actual)}" fill="none" stroke="var(--series-1)" stroke-width="2.5"/>
        <path d="${path(sim)}" fill="none" stroke="var(--series-4)" stroke-width="2.5"/>
      </svg></div>
      <div class="bc-sec"><h3>出場原因</h3><div class="bc-sigs">${reasons}</div></div>
      ${openRows ? `<div class="bc-sec"><h3>規則版目前持有</h3><div class="bc-sigs">${openRows}</div></div>` : ''}
      <details class="pu-trades"><summary>規則版交易明細（${pu.trades.length}）</summary>
        <div class="table-wrap"><table class="trade-table"><thead><tr><th>股票</th><th>策略</th><th class="num">進場</th><th class="num">出場</th><th>出場原因</th><th class="num">報酬</th></tr></thead><tbody>${rows}</tbody></table></div>
      </details>
    </div>`;
  }

  // ================= WATCHLIST =================
  // 日期一律用「台北時間的日曆日」字串（YYYY-MM-DD）處理，不用 Date 物件的本地時區，
  // 避免使用者裝置時區跟台北不同時，「隔天」算錯（例如半夜用 UTC-5 的裝置打開網頁）。
  function taipeiDateStr(d = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(d);
  }
  function addDays(dateStr, days) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    return dt.toISOString().slice(0, 10);
  }

  async function addWatchlistItem(code, name, note) {
    const today = taipeiDateStr();
    state.watchlist.push({
      id: uid(),
      code: code.trim(),
      name: (name || '').trim(),
      note: (note || '').trim(),
      createdDate: today,
      reminderDate: addDays(today, 1),
      notified: false,
    });
    await save();
    renderWatchlist();
  }

  function sortedWatchlist() {
    return [...state.watchlist].sort((a, b) => (a.createdDate < b.createdDate ? 1 : a.createdDate > b.createdDate ? -1 : 0));
  }

  function watchlistRowHtml(item, todayStr) {
    const statusText = item.notified ? '已提醒' : (item.reminderDate <= todayStr ? '今日提醒' : '待提醒');
    const statusClass = item.notified ? 'pnl-zero' : (item.reminderDate <= todayStr ? 'pnl-pos' : 'pnl-zero');
    return `
      <tr>
        <td><strong>${escapeHtml(item.code)}</strong> ${item.name ? `<span style="color:var(--text-muted)">${escapeHtml(item.name)}</span>` : ''}</td>
        <td>${item.note ? escapeHtml(item.note) : '–'}</td>
        <td class="num">${item.createdDate}</td>
        <td class="num">${item.reminderDate}</td>
        <td class="${statusClass}">${statusText}</td>
        <td><button class="icon-btn btn-del-watch" data-id="${item.id}" title="刪除">✕</button></td>
      </tr>
    `;
  }

  function renderWatchlist() {
    const tbody = document.getElementById('watchlist-tbody');
    const empty = document.getElementById('watchlist-empty');
    const banner = document.getElementById('watchlist-due-banner');
    const todayStr = taipeiDateStr();
    const items = sortedWatchlist();

    tbody.innerHTML = items.map(item => watchlistRowHtml(item, todayStr)).join('');
    empty.style.display = items.length ? 'none' : '';

    tbody.querySelectorAll('.btn-del-watch').forEach(btn => {
      btn.addEventListener('click', async () => {
        state.watchlist = state.watchlist.filter(w => w.id !== btn.dataset.id);
        await save();
        renderWatchlist();
      });
    });

    const dueToday = items.filter(w => !w.notified && w.reminderDate <= todayStr);
    if (dueToday.length) {
      banner.hidden = false;
      banner.textContent = `今天該複查：${dueToday.map(w => w.code + (w.name ? ' ' + w.name : '')).join('、')}`;
    } else {
      banner.hidden = true;
    }

    updateSymbolDatalist();
  }

  // 打過的股票代號（交易紀錄或觀察清單都算），自動帶出名稱——跟 f-symbol 同一套 symbolLookup()
  document.getElementById('wl-code').addEventListener('input', (e) => {
    const info = symbolLookup().get(e.target.value.trim());
    if (!info || !info.name) return;
    const nameEl = document.getElementById('wl-name');
    if (!nameEl.value) nameEl.value = info.name;
  });

  document.getElementById('watchlist-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const codeInput = document.getElementById('wl-code');
    const code = codeInput.value.trim();
    if (!code) return;
    await addWatchlistItem(code, document.getElementById('wl-name').value, document.getElementById('wl-note').value);
    e.target.reset();
    codeInput.focus();
  });

  // ================= HOLDINGS（庫存股）=================
  // 每一檔股票（symbol）底下可以有多筆「分批買進」的紀錄（lots），各自有自己的份數與
  // 進場價格；畫面上顯示的是加總後的總份數與加權均價。現價是使用者自己輸入、存在
  // holding 本身（不是存在個別 lot 裡，因為現價是這檔股票當下的屬性，不是某一次買進的
  // 屬性），不會自動帶入，使用者想更新幾次就自己改。
  // 份數：使用者自己慣用的部位單位，一份約固定投入 UNIT_AMOUNT_WAN 萬——不是真實股數，
  // 所以損益也是用「每筆 lot 各自固定投入 X 萬」這個近似值反推，不是用實際股數 × 股價
  // 算出來的精確金額。
  const UNIT_AMOUNT_WAN = 8;

  // 一次性欄位搬遷：舊版每筆庫存只有單一 units/entryPrice，沒有 lots 陣列、也沒有
  // currentPrice（現價以前是自動抓的，不存在資料裡）。把舊欄位包成第一筆 lot，現價留空
  // 讓使用者自己填，其餘資料不動。
  function migrateHoldings() {
    let changed = false;
    state.holdings = state.holdings.map(h => {
      if (Array.isArray(h.lots)) return h;
      changed = true;
      return {
        id: h.id, symbol: h.symbol, name: h.name || '', currentPrice: null,
        lots: [{ id: uid(), units: h.units, entryPrice: h.entryPrice }],
      };
    });
    return changed;
  }

  function findHolding(symbol) {
    return state.holdings.find(h => h.symbol === symbol);
  }

  async function addHoldingLot(symbol, name, units, entryPrice) {
    symbol = symbol.trim();
    let holding = findHolding(symbol);
    if (!holding) {
      holding = { id: uid(), symbol, name: (name || '').trim(), currentPrice: null, lots: [] };
      state.holdings.push(holding);
    } else if (name && name.trim() && !holding.name) {
      holding.name = name.trim();
    }
    holding.lots.push({ id: uid(), units, entryPrice });
    await save();
    renderHoldings();
  }

  function sortedHoldings() {
    return [...state.holdings].sort((a, b) => a.symbol.localeCompare(b.symbol));
  }

  // 損益逐份計算：每一份買進的價格不同，不能用加權均價去算整體報酬率
  // （均價法會讓不同份數/價格的組合在數學上失真）；改成每一份各自算報酬率跟損益(萬)，
  // 整體損益(萬) = 各份損益(萬)加總，整體報酬率 = 整體損益(萬) ÷ 總投入(萬)（換算成資金加權的報酬率）。
  function holdingTotals(h) {
    const totalUnits = h.lots.reduce((s, l) => s + l.units, 0);
    const investedWan = totalUnits * UNIT_AMOUNT_WAN;
    const avgEntryPrice = totalUnits > 0 ? h.lots.reduce((s, l) => s + l.units * l.entryPrice, 0) / totalUnits : 0;
    const currentPrice = h.currentPrice;
    const lotPnls = h.lots.map(l => {
      const investedWan = l.units * UNIT_AMOUNT_WAN;
      const pnlPct = (currentPrice != null && l.entryPrice > 0) ? (currentPrice / l.entryPrice - 1) * 100 : null;
      const pnlWan = pnlPct != null ? investedWan * (pnlPct / 100) : null;
      return { ...l, investedWan, pnlPct, pnlWan };
    });
    const pnlWan = currentPrice != null ? lotPnls.reduce((s, l) => s + (l.pnlWan || 0), 0) : null;
    const pnlPct = (pnlWan != null && investedWan > 0) ? (pnlWan / investedWan) * 100 : null;
    return { totalUnits, avgEntryPrice, investedWan, currentPrice, pnlPct, pnlWan, lotPnls };
  }

  function holdingLotRowsHtml(h, lotPnls) {
    return lotPnls.map(l => {
      const lotPnlClass = l.pnlPct == null ? 'pnl-zero' : l.pnlPct > 0 ? 'pnl-pos' : l.pnlPct < 0 ? 'pnl-neg' : 'pnl-zero';
      return `
      <tr class="holding-lot-row">
        <td colspan="4" style="color:var(--text-muted);font-size:12px;padding-left:24px;">↳ ${l.units} 份 @ ${l.entryPrice}</td>
        <td class="num ${lotPnlClass}" style="font-size:12px;">${fmtPct(l.pnlPct, 2)}</td>
        <td><button class="icon-btn btn-del-lot" data-holding="${h.id}" data-lot="${l.id}" title="刪除這筆買進紀錄">✕</button></td>
      </tr>
    `;
    }).join('');
  }

  function holdingRowHtml(h) {
    const { totalUnits, avgEntryPrice, currentPrice, pnlPct, lotPnls } = holdingTotals(h);
    const pnlClass = pnlPct == null ? 'pnl-zero' : pnlPct > 0 ? 'pnl-pos' : pnlPct < 0 ? 'pnl-neg' : 'pnl-zero';
    return `
      <tr>
        <td><strong>${escapeHtml(h.symbol)}</strong> ${h.name ? `<span style="color:var(--text-muted)">${escapeHtml(h.name)}</span>` : ''}</td>
        <td class="num">${totalUnits}</td>
        <td class="num">${avgEntryPrice.toFixed(2)}</td>
        <td class="num"><input type="number" class="holding-current-price-input" data-holding="${h.id}" value="${currentPrice != null ? currentPrice : ''}" placeholder="輸入現價" step="0.01" min="0" style="width:90px;"></td>
        <td class="num ${pnlClass}">${fmtPct(pnlPct, 2)}</td>
        <td><button class="icon-btn btn-del-holding" data-id="${h.id}" title="刪除整檔">✕</button></td>
      </tr>
      ${holdingLotRowsHtml(h, lotPnls)}
    `;
  }

  async function renderHoldings() {
    const tbody = document.getElementById('holdings-tbody');
    const empty = document.getElementById('holdings-empty');
    const items = sortedHoldings();

    tbody.innerHTML = items.map(holdingRowHtml).join('');
    empty.style.display = items.length ? 'none' : '';

    tbody.querySelectorAll('.btn-del-holding').forEach(btn => {
      btn.addEventListener('click', async () => {
        state.holdings = state.holdings.filter(h => h.id !== btn.dataset.id);
        await save();
        renderHoldings();
      });
    });

    tbody.querySelectorAll('.btn-del-lot').forEach(btn => {
      btn.addEventListener('click', async () => {
        const holding = state.holdings.find(h => h.id === btn.dataset.holding);
        if (!holding) return;
        holding.lots = holding.lots.filter(l => l.id !== btn.dataset.lot);
        if (!holding.lots.length) state.holdings = state.holdings.filter(h => h.id !== holding.id);
        await save();
        renderHoldings();
      });
    });

    tbody.querySelectorAll('.holding-current-price-input').forEach(input => {
      input.addEventListener('change', async () => {
        const holding = state.holdings.find(h => h.id === input.dataset.holding);
        if (!holding) return;
        const v = parseFloat(input.value);
        holding.currentPrice = isNaN(v) ? null : v;
        await save();
        renderHoldings();
      });
    });

    const summaryEl = document.getElementById('holdings-summary');
    const totalInvestedWan = items.reduce((s, h) => s + holdingTotals(h).investedWan, 0);
    const totalPnlWan = items.reduce((s, h) => s + (holdingTotals(h).pnlWan || 0), 0);
    const totalValueWan = totalInvestedWan + totalPnlWan;
    const totalPnlPct = totalInvestedWan > 0 ? (totalPnlWan / totalInvestedWan) * 100 : 0;
    const totalPnlClass = totalPnlWan > 0 ? 'pnl-pos' : totalPnlWan < 0 ? 'pnl-neg' : 'pnl-zero';
    summaryEl.innerHTML = items.length ? `
      <div class="stat-tile">
        <span class="stat-label">總投入</span>
        <span class="stat-value">${fmtWan(totalInvestedWan, 2)}</span>
      </div>
      <div class="stat-tile">
        <span class="stat-label">總現值</span>
        <span class="stat-value">${fmtWan(totalValueWan, 2)}</span>
      </div>
      <div class="stat-tile">
        <span class="stat-label">未實現損益率</span>
        <span class="stat-value ${totalPnlClass}">${fmtPct(totalPnlPct, 2)}</span>
      </div>
    ` : '';

    updateSymbolDatalist();
  }

  // 打過的股票代號（交易紀錄或觀察清單都算），自動帶出名稱——跟 f-symbol/wl-code 同一套 symbolLookup()
  document.getElementById('hd-symbol').addEventListener('input', (e) => {
    const info = symbolLookup().get(e.target.value.trim());
    if (!info || !info.name) return;
    const nameEl = document.getElementById('hd-name');
    if (!nameEl.value) nameEl.value = info.name;
  });

  document.getElementById('holding-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const symbolInput = document.getElementById('hd-symbol');
    const symbol = symbolInput.value.trim();
    const units = parseFloat(document.getElementById('hd-units').value);
    const entryPrice = parseFloat(document.getElementById('hd-entry-price').value);
    if (!symbol || !(units > 0) || !(entryPrice > 0)) return;
    await addHoldingLot(symbol, document.getElementById('hd-name').value, units, entryPrice);
    e.target.reset();
    symbolInput.focus();
  });

  // ---- 推播通知（Firebase Cloud Messaging）----
  // 整個網站是純前端 + GitHub Pages，沒有自己的伺服器；用 FCM 讓瀏覽器就算沒開著頁面
  // 也能收到「隔天 8:30」的提醒，實際送出的排程在 scripts/send_watchlist_reminders.py，
  // 由 .github/workflows/watchlist-reminder.yml 每天台北時間 8:30 觸發。
  // 這裡只負責：跟使用者要通知權限、拿到這台裝置的 FCM token、把 token 存回 Firestore
  // 讓排程腳本知道要推給誰。
  let messaging = null;

  async function setupPushNotifications() {
    if (!VAPID_KEY || VAPID_KEY.startsWith('PASTE_')) return; // 還沒在 push-config.js 填入 VAPID key，先略過
    if (!('serviceWorker' in navigator) || typeof Notification === 'undefined') return;
    try {
      if (!(await isMessagingSupported())) return; // 部分瀏覽器（如較舊的 Safari）不支援 Web Push，略過不影響其他功能
      if (!messaging) messaging = getMessaging(fbApp);

      const permission = await Notification.requestPermission();
      if (permission !== 'granted') return;

      const registration = await navigator.serviceWorker.register('./firebase-messaging-sw.js');
      const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
      if (token && !state.fcmTokens.includes(token)) {
        state.fcmTokens.push(token);
        await save();
      }

      // 頁面開在前景時收到的推播不會自動跳系統通知（瀏覽器行為如此），這裡手動補上，
      // 否則使用者正在用網頁時反而看不到提醒。
      onMessage(messaging, (payload) => {
        const { title, body } = payload.notification || {};
        if (Notification.permission === 'granted') {
          new Notification(title || '觀察清單提醒', { body: body || '', icon: './icon-192.png' });
        }
        renderWatchlist();
      });
    } catch (e) {
      console.error('推播通知設定失敗（不影響其他功能）', e);
    }
  }

  // ================= TRADES =================
  const tbody = document.getElementById('trade-tbody');
  const tradesEmpty = document.getElementById('trades-empty');
  const filterAction = document.getElementById('filter-action');
  const filterStrategy = document.getElementById('filter-strategy');
  const filterSearch = document.getElementById('filter-search');

  [filterAction, filterStrategy, filterSearch].forEach(el => el.addEventListener('input', renderTrades));

  function updateStrategyFilter() {
    const current = filterStrategy.value;
    const names = strategyList();
    filterStrategy.innerHTML = '<option value="all">全部策略</option>' +
      names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
    filterStrategy.value = names.includes(current) ? current : 'all';
  }

  function renderTrades() {
    updateStrategyFilter();
    const list = sortedTrades().filter(t => {
      if (filterAction.value !== 'all' && t.action !== filterAction.value) return false;
      if (filterStrategy.value !== 'all' && t.strategy !== filterStrategy.value) return false;
      const q = filterSearch.value.trim().toLowerCase();
      if (q && !(t.symbol.toLowerCase().includes(q) || (t.name || '').toLowerCase().includes(q) || (t.sector || '').toLowerCase().includes(q))) return false;
      return true;
    });

    tbody.innerHTML = '';
    tradesEmpty.style.display = list.length ? 'none' : 'block';
    // 損益佔淨值：損益（萬）÷ 當月淨值，淨值跟各月份資金加權報酬用同一份 basisMap
    const basisMap = buildMonthlyCapitalBasisMap(state.trades.filter(x => x.returnPct != null));

    for (const t of list) {
      const tr = document.createElement('tr');
      tr.dataset.id = t.id;
      if (t.markColor) tr.classList.add('marked-row-' + t.markColor);
      const pnlClass = t.returnPct == null ? 'pnl-zero' : t.returnPct > 0 ? 'pnl-pos' : t.returnPct < 0 ? 'pnl-neg' : 'pnl-zero';
      const profitWan = displayProfitWan(t);
      const profitClass = profitWan == null ? 'pnl-zero' : profitWan > 0 ? 'pnl-pos' : profitWan < 0 ? 'pnl-neg' : 'pnl-zero';
      const ratingHtml = t.rating ? `<span class="rating-badge rating-${t.rating}">${t.rating}</span>` : '–';
      tr.innerHTML = `
        <td class="mark-col"><button type="button" class="mark-swatch mark-${t.markColor || 'none'}" data-mark="${t.id}" title="點擊切換標記顏色（無 → 黃 → 紅）"></button></td>
        <td class="num">${t.date}</td>
        <td><strong>${escapeHtml(t.symbol)}</strong> ${t.name ? `<span style="color:var(--text-muted)">${escapeHtml(t.name)}</span>` : ''}</td>
        <td><span class="badge ${actionBadgeClass(t.action)}">${escapeHtml(t.action)}</span></td>
        <td>${escapeHtml(t.strategy)}</td>
        <td>${escapeHtml(t.sector || '–')}</td>
        <td class="num ${profitClass}">${fmtWan(profitWan, 2)}</td>
        <td class="num ${pnlClass}">${fmtPct(t.returnPct, 2)}</td>
        <td class="num ${profitClass}">${profitWan == null ? '–' : fmtPct(monthlyProfitPct(profitWan, t.date, basisMap), 2)}</td>
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
        const order = ['', 'yellow', 'red'];
        t.markColor = order[(order.indexOf(t.markColor || '') + 1) % order.length];
        e.target.className = 'mark-swatch mark-' + (t.markColor || 'none');
        tr.classList.remove('marked-row-yellow', 'marked-row-red');
        if (t.markColor) tr.classList.add('marked-row-' + t.markColor);
        save();
      });
    }

    updateSymbolDatalist();
  }

  // ---- 股票代號自動帶出名稱/族群（依最近一筆同代號的紀錄） ----
  // 交易紀錄跟觀察清單共用這一份對照表：交易紀錄優先（有族群資訊，資料也比較新），
  // 觀察清單只在交易紀錄裡沒有這個代號時拿來補名稱（觀察清單本身沒有族群欄位）。
  function symbolLookup() {
    const map = new Map();
    for (const t of sortedTrades()) { // 由新到舊，先出現的（較新）優先，不覆蓋
      if (!map.has(t.symbol)) map.set(t.symbol, { name: t.name || '', sector: t.sector || '' });
    }
    for (const w of sortedWatchlist()) {
      if (w.code && !map.has(w.code)) map.set(w.code, { name: w.name || '', sector: '' });
    }
    for (const h of state.holdings) {
      if (h.symbol && !map.has(h.symbol)) map.set(h.symbol, { name: h.name || '', sector: '' });
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

  // R% = (進場價 − 原始停損價) ÷ 進場價，依策略規則第三點自動算，使用者仍可手動覆蓋
  function recalcRPct() {
    const entry = parseFloat(document.getElementById('f-entry-price').value);
    const stop = parseFloat(document.getElementById('f-stop-price').value);
    if (!entry || isNaN(stop)) return;
    document.getElementById('f-r-pct').value = (((entry - stop) / entry) * 100).toFixed(2);
  }
  document.getElementById('f-entry-price').addEventListener('input', recalcRPct);
  document.getElementById('f-stop-price').addEventListener('input', recalcRPct);

  function openTradeModal(t) {
    document.getElementById('trade-modal-title').textContent = t ? '編輯交易' : '新增交易';
    document.getElementById('trade-id').value = t ? t.id : '';
    document.getElementById('f-marked-color').value = t ? (t.markColor || '') : '';
    document.getElementById('f-date').value = t ? t.date : new Date().toISOString().slice(0, 10);
    document.getElementById('f-symbol').value = t ? t.symbol : '';
    document.getElementById('f-name').value = t ? (t.name || '') : '';
    document.getElementById('f-sector').value = t ? (t.sector || '') : '';
    document.getElementById('f-calc-price').value = t && t.price != null ? t.price : '';
    document.getElementById('f-calc-shares').value = '';
    document.getElementById('f-action').value = t ? t.action : '買進';
    const strategySel = document.getElementById('f-strategy');
    strategySel.querySelectorAll('option[data-legacy]').forEach(o => o.remove());
    if (t && t.strategy && !STRATEGIES.includes(t.strategy)) {
      const opt = document.createElement('option');
      opt.value = t.strategy; opt.textContent = t.strategy; opt.dataset.legacy = '1';
      strategySel.appendChild(opt);
    }
    strategySel.value = t ? t.strategy : '';
    document.getElementById('f-position-pct').value = t && t.positionPct != null ? t.positionPct : '';
    document.getElementById('f-return-pct').value = t && t.returnPct != null ? t.returnPct : '';
    document.getElementById('f-profit-wan').value = t && t.profitWan != null ? t.profitWan : '';
    document.getElementById('f-lot-number').value = t && t.lotNumber != null ? t.lotNumber : '';
    document.getElementById('f-entry-price').value = t && t.entryPrice != null ? t.entryPrice : '';
    document.getElementById('f-stop-price').value = t && t.stopPrice != null ? t.stopPrice : '';
    document.getElementById('f-r-pct').value = t && t.rPct != null ? t.rPct : '';
    document.getElementById('f-position-r-pct').value = t && t.positionRPct != null ? t.positionRPct : '';
    document.getElementById('f-max-gain-pct').value = t && t.maxGainPct != null ? t.maxGainPct : '';
    document.getElementById('f-exit-reason').value = t ? (t.exitReason || '') : '';
    document.getElementById('f-profit-r').value = t && t.profitR != null ? t.profitR : '';
    document.getElementById('f-rebound-3r').value = t ? (t.reboundTo3R || '') : '';
    document.getElementById('f-market-level').value = t ? (t.marketLevelAtEntry || '') : '';
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
    const profitWanVal = document.getElementById('f-profit-wan').value;
    const priceVal = document.getElementById('f-calc-price').value;
    const lotNumberVal = document.getElementById('f-lot-number').value;
    const entryPriceVal = document.getElementById('f-entry-price').value;
    const stopPriceVal = document.getElementById('f-stop-price').value;
    const rPctVal = document.getElementById('f-r-pct').value;
    const positionRPctVal = document.getElementById('f-position-r-pct').value;
    const maxGainPctVal = document.getElementById('f-max-gain-pct').value;
    const profitRVal = document.getElementById('f-profit-r').value;
    const rec = {
      id,
      markColor: document.getElementById('f-marked-color').value,
      date: document.getElementById('f-date').value,
      symbol: document.getElementById('f-symbol').value.trim(),
      name: document.getElementById('f-name').value.trim(),
      sector: document.getElementById('f-sector').value.trim(),
      action: document.getElementById('f-action').value,
      strategy: document.getElementById('f-strategy').value,
      price: priceVal === '' ? null : parseFloat(priceVal),
      positionPct: posVal === '' ? null : parseFloat(posVal),
      returnPct: retVal === '' ? null : parseFloat(retVal),
      profitWan: profitWanVal === '' ? null : parseFloat(profitWanVal),
      lotNumber: lotNumberVal === '' ? null : parseInt(lotNumberVal, 10),
      entryPrice: entryPriceVal === '' ? null : parseFloat(entryPriceVal),
      stopPrice: stopPriceVal === '' ? null : parseFloat(stopPriceVal),
      rPct: rPctVal === '' ? null : parseFloat(rPctVal),
      positionRPct: positionRPctVal === '' ? null : parseFloat(positionRPctVal),
      maxGainPct: maxGainPctVal === '' ? null : parseFloat(maxGainPctVal),
      exitReason: document.getElementById('f-exit-reason').value,
      profitR: profitRVal === '' ? null : parseFloat(profitRVal),
      reboundTo3R: document.getElementById('f-rebound-3r').value,
      marketLevelAtEntry: document.getElementById('f-market-level').value.trim(),
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
  function median(nums) {
    if (!nums.length) return 0;
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function computeStats(realized) {
    const wins = realized.filter(t => t.returnPct > 0);
    const losses = realized.filter(t => t.returnPct < 0);
    // weighted 的 contrib 欄位永遠是「相對於固定兩段式基準」的 %（資金加權累計報酬曲線／總計用這個）；
    // 各月份資金加權報酬要改用當月真實總資產當分母時，直接從 profitWan 重新算，不要用這裡的 contrib。
    const weighted = realized
      .filter(t => t.profitWan != null)
      .map(t => ({ ...t, contrib: profitPct(t.profitWan, t.date, fixedCapitalBasis) }));
    const totalWeighted = weighted.reduce((s, t) => s + t.contrib, 0);
    const totalProfitWan = weighted.reduce((s, t) => s + t.profitWan, 0);
    const winRate = realized.length ? (wins.length / realized.length) * 100 : 0;
    // 部位加權平均獲利/虧損：總損益 ÷ 總投入。每筆投入 = 損益（萬）÷ 報酬率，
    // 所以大部位影響大、小部位影響小，數字又跟報酬率同一個量級。報酬率與損益同號才算得出投入。
    const positionWeightedReturn = (list) => {
      const profit = list.reduce((a, t) => a + t.profitWan, 0);
      const invested = list.reduce((a, t) => a + t.profitWan / (t.returnPct / 100), 0);
      return invested > 0 ? (profit / invested) * 100 : 0;
    };
    const avgWin = positionWeightedReturn(weighted.filter(t => t.profitWan > 0 && t.returnPct > 0));
    const avgLoss = positionWeightedReturn(weighted.filter(t => t.profitWan < 0 && t.returnPct < 0));
    const medianWin = median(wins.map(t => t.returnPct));
    const medianLoss = median(losses.map(t => t.returnPct));
    // 加權獲利因子 = 賺錢單損益（萬）總和 ÷ 賠錢單損益（萬）總和
    const grossWin = weighted.filter(t => t.profitWan > 0).reduce((a, t) => a + t.profitWan, 0);
    const grossLoss = -weighted.filter(t => t.profitWan < 0).reduce((a, t) => a + t.profitWan, 0);
    const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
    const maxWin = realized.length ? Math.max(...realized.map(t => t.returnPct)) : 0;
    const maxLoss = realized.length ? Math.min(...realized.map(t => t.returnPct)) : 0;
    return { realized, wins, losses, weighted, totalWeighted, totalProfitWan, winRate, avgWin, avgLoss, medianWin, medianLoss, pf, maxWin, maxLoss };
  }

  function equityCurveItems(weighted) {
    if (!weighted) weighted = computeStats(sortedTrades().filter(t => t.returnPct != null)).weighted;
    return weighted
      .filter(t => t.date >= EQUITY_CURVE_START)
      .map(t => ({ ...t, contrib: profitPct(t.profitWan, t.date, () => EQUITY_CURVE_CAPITAL) }));
  }

  async function renderStats() {
    await ensureOtcData();
    await ensureTwiData();
    const allRealized = sortedTrades().filter(t => t.returnPct != null);
    const s = computeStats(allRealized);

    document.getElementById('stat-total-pnl').textContent = fmtPct(s.totalWeighted, 2);
    document.getElementById('stat-total-pnl').style.color = s.totalWeighted > 0 ? 'var(--good)' : s.totalWeighted < 0 ? 'var(--critical)' : '';
    document.getElementById('stat-total-profit-wan').textContent = fmtWan(s.totalProfitWan, 2);
    document.getElementById('stat-total-profit-wan').style.color = s.totalProfitWan > 0 ? 'var(--good)' : s.totalProfitWan < 0 ? 'var(--critical)' : '';
    document.getElementById('stat-winrate').textContent = s.realized.length ? s.winRate.toFixed(1) + '%' : '–';
    document.getElementById('stat-count').textContent = s.realized.length;
    document.getElementById('stat-count-sub').textContent = `${s.wins.length} 勝 / ${s.losses.length} 敗`;
    document.getElementById('stat-avg').textContent = `${fmtPct(s.avgWin, 2)} / ${fmtPct(s.avgLoss, 2)}`;
    document.getElementById('stat-median').textContent = `${fmtPct(s.medianWin, 2)} / ${fmtPct(s.medianLoss, 2)}`;
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
    const equityItems = equityCurveItems(s.weighted);
    renderEquityCurve(equityItems, { startDate: EQUITY_CURVE_START, autoY: true });
    renderDrawdownLight(equityItems);
    renderMonthlyChart(s.weighted);
    renderStrategyChart(s.realized);
    renderSectorChart(s.realized);
  }

  // 月度回顧要把「當月損益最好/最差的 2 筆交易」連同完整欄位一起凍結進快照，
  // 所以在這裡存一份獨立的欄位副本（不是存 trade id）——這樣之後就算原始那筆交易
  // 被編輯或刪除，快照裡留存的數字跟文字也不會跟著變動，維持「凍結快照」一貫的原則。
  function snapshotTradeFields(t) {
    return {
      date: t.date, symbol: t.symbol, name: t.name || '', sector: t.sector || '',
      action: t.action, strategy: t.strategy || '',
      profitWan: displayProfitWan(t), returnPct: t.returnPct,
      rating: t.rating || '', reason: t.reason || '',
    };
  }

  function computeTopBottomTrades(realized) {
    const withProfit = realized.filter(t => displayProfitWan(t) != null);
    const sorted = [...withProfit].sort((a, b) => displayProfitWan(b) - displayProfitWan(a));
    return {
      topTrades: sorted.slice(0, 2).map(snapshotTradeFields),
      bottomTrades: sorted.slice(-2).reverse().map(snapshotTradeFields),
    };
  }

  // ---- monthly stats breakdown table ----
  // 算出某個月份的統計列，給「月度統計明細」即時表格跟「月度回顧」的凍結快照共用，
  // 確保兩邊算法永遠一致。pf 是 Infinity 時存成 null（而不是 JS 的 Infinity），避免存進
  // Firestore/JSON 時出現序列化邊界問題；顯示時 null 一律當「∞」處理。
  function computeMonthRow(m, byMonth, basisMap) {
    const s = computeStats(byMonth[m]);
    const realReturn = s.weighted.reduce((sum, t) => sum + monthlyProfitPct(t.profitWan, t.date, basisMap), 0);
    return {
      month: m,
      realReturn,
      totalProfitWan: s.totalProfitWan,
      winRate: s.winRate,
      realizedCount: s.realized.length,
      wins: s.wins.length,
      losses: s.losses.length,
      avgWin: s.avgWin,
      avgLoss: s.avgLoss,
      medianWin: s.medianWin,
      medianLoss: s.medianLoss,
      pf: s.pf === Infinity ? null : s.pf,
      maxWin: s.maxWin,
      maxLoss: s.maxLoss,
      ...computeTopBottomTrades(s.realized),
    };
  }

  function monthRowHtml(row, { withMonth = true } = {}) {
    const pnlClass = row.realReturn > 0 ? 'pnl-pos' : row.realReturn < 0 ? 'pnl-neg' : 'pnl-zero';
    return `
      ${withMonth ? `<td><strong>${row.month.replace('-', '/')}</strong></td>` : ''}
      <td class="num ${pnlClass}">${fmtPct(row.realReturn, 2)}</td>
      <td class="num">${row.winRate.toFixed(1)}%</td>
      <td class="num">${row.realizedCount}（${row.wins}勝${row.losses}敗）</td>
      <td class="num">${fmtPct(row.avgWin, 2)} / ${fmtPct(row.avgLoss, 2)}</td>
      <td class="num">${row.pf == null ? '∞' : row.pf.toFixed(2)}</td>
      <td class="num">${fmtPct(row.maxWin, 2)} / ${fmtPct(row.maxLoss, 2)}</td>
    `;
  }

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
    // 5 月樣本數太少（只有 2 筆），數字容易失真誤導，月度明細表不顯示
    const months = Object.keys(byMonth).filter(m => m !== '2026-05').sort().reverse();
    const basisMap = buildMonthlyCapitalBasisMap(allRealized);

    for (const m of months) {
      const tr = document.createElement('tr');
      tr.innerHTML = monthRowHtml(computeMonthRow(m, byMonth, basisMap));
      tbody.appendChild(tr);
    }
  }

  // ---- 月度回顧：統計數字即時計算 ----
  // 跟統計分析分頁的月度統計明細一樣，每次顯示都用目前的交易紀錄重算（computeMonthRow），
  // 交易新增/編輯/刪除後數字會跟著變。舊版存在 review.statsSnapshot 的凍結快照保留在資料裡，但不再讀取。
  function realizedByMonth() {
    const allRealized = state.trades.filter(t => t.returnPct != null);
    const byMonth = {};
    allRealized.forEach(t => {
      const m = t.date.slice(0, 7);
      (byMonth[m] = byMonth[m] || []).push(t);
    });
    return { allRealized, byMonth };
  }

  function liveMonthRow(month) {
    const { allRealized, byMonth } = realizedByMonth();
    if (!byMonth[month]) return null;
    return computeMonthRow(month, byMonth, buildMonthlyCapitalBasisMap(allRealized));
  }

  // 有已實現交易的月份（含進行中的當月）若還沒有月度回顧紀錄，自動建一筆空的，讓統計有地方顯示。
  function ensureMonthlyReviews() {
    const { byMonth } = realizedByMonth();
    let changed = false;
    for (const m of Object.keys(byMonth)) {
      if (m === '2026-05') continue; // 跟月度統計明細表同一條規則：樣本太少不列入
      if (!findReview(m)) {
        state.monthlyReviews.push({ month: m, entries: [], reflections: [] });
        changed = true;
      }
    }
    return changed;
  }

  // ---- weighted cumulative return curve (SVG line chart) ----
  function parseDateTs(dateStr) { return new Date(dateStr + 'T00:00:00').getTime(); }

  // opts.startDate：指定起點時，個人曲線在起點補一個 0% 的點，兩條指數線也從起點收盤重新算 0%。
  // opts.autoY：縱軸依資料自動縮放（起點較晚、波動較小時比較看得清楚），否則固定 ±50%。
  function renderEquityCurve(weighted, opts = {}) {
    const el = document.getElementById(opts.elId || 'equity-chart');
    if (!el) return;
    el.innerHTML = '';
    const startDate = opts.startDate || null;
    if (!weighted.length && !startDate) {
      el.innerHTML = '<p class="empty-state">尚無帶有損益（萬）的已實現紀錄，無法繪製曲線。</p>';
      return;
    }
    const sorted = [...weighted].sort((a, b) => a.date > b.date ? 1 : -1);
    let cum = 0;
    const raw = sorted.map(t => { cum += t.contrib; return { date: t.date, ts: parseDateTs(t.date), value: cum, symbol: t.symbol, contrib: t.contrib }; });
    const anchor = startDate ? { date: startDate, ts: parseDateTs(startDate), value: 0, symbol: '起點', contrib: 0, count: 1, isAnchor: true } : null;
    if (anchor) raw.unshift(anchor);

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
    // 跟指數線一樣：起點那一桶固定畫 0%，不被同一桶裡較晚的交易蓋掉（累計值會在下一桶接上）
    if (anchor) bins.set(0, anchor);
    // binTs：每個桶固定用「桶的起始時間」當作繪圖 x 座標（而非桶內最後一筆的實際日期），
    // 這樣個人曲線跟櫃買指數線只要落在同一個桶，x 座標就會完全一致、對得齊。
    const points = [...bins.keys()].sort((a, b) => a - b).map(k => ({ ...bins.get(k), binTs: binStart + k * binMs }));

    const otcSeries = computeOtcSeries(binStart, BIN_DAYS, startDate);
    const otcBinsByIdx = new Map(otcSeries.map(p => [Math.round((p.binTs - binStart) / binMs), p]));
    const twiSeries = computeTwiSeries(binStart, BIN_DAYS, startDate);
    const twiBinsByIdx = new Map(twiSeries.map(p => [Math.round((p.binTs - binStart) / binMs), p]));

    const W = 900, H = 280, PAD = { top: 16, right: 16, bottom: 36, left: 56 };
    const innerW = W - PAD.left - PAD.right, innerH = H - PAD.top - PAD.bottom;

    // 縱軸固定為 -50% ~ +50%，每 10% 一格；autoY 時依三條線的最大振幅縮放（至少 ±10%）
    let min = -50, max = 50, gridStep = 10;
    if (opts.autoY) {
      const peak = Math.max(...[...points, ...otcSeries, ...twiSeries].map(p => Math.abs(p.value)), 0);
      const lim = Math.max(10, Math.ceil(peak * 1.15 / 5) * 5);
      min = -lim; max = lim; gridStep = lim <= 20 ? 5 : 10;
    }

    // 用「原始交易」的日期範圍當作 X 軸範圍（而非合併後的區間點），
    // 這樣月初/月中標記線才不會因為合併時取區間內最後一筆而被誤判裁掉
    // 同時涵蓋櫃買指數／加權指數對照線的日期範圍（可能比交易紀錄更早開始，例如 6/1）
    const tMin = Math.min(raw[0].ts, otcSeries.length ? otcSeries[0].ts : raw[0].ts, twiSeries.length ? twiSeries[0].ts : raw[0].ts);
    const tMax = Math.max(raw[raw.length - 1].ts, otcSeries.length ? otcSeries[otcSeries.length - 1].ts : raw[raw.length - 1].ts, twiSeries.length ? twiSeries[twiSeries.length - 1].ts : raw[raw.length - 1].ts);
    const tSpan = tMax - tMin || 1; // 同一天的資料時避免除以 0

    const x = (ts) => PAD.left + ((ts - tMin) / tSpan) * innerW;
    const y = (v) => PAD.top + innerH - ((v - min) / (max - min)) * innerH;

    const zeroY = y(0);
    const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.binTs).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L ${x(points[points.length - 1].binTs).toFixed(1)} ${zeroY.toFixed(1)} L ${x(points[0].binTs).toFixed(1)} ${zeroY.toFixed(1)} Z`;

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
          const point = bins.get(idx) || otcBinsByIdx.get(idx) || twiBinsByIdx.get(idx); // 個人紀錄沒有該區間資料時，改用對照指數的資料點定位
          if (!point || usedBins.has(idx)) return; // 該 6 天區間內兩邊都沒有資料，或已被同月另一個標記用掉，就不標示
          usedBins.add(idx);
          // 用 idx 直接算區間時間，不要用 point.binTs——bins（個人資料）裡存的物件沒有 binTs 這個欄位
          // （binTs 是後面組 points 陣列時才另外加上去的，bins 本身沒有），point.binTs 會是 undefined，
          // 算出來的 x 座標就是 NaN，全部標籤都疊到 (0,0) 附近，看起來像擠在左下角。
          const gx = x(binStart + idx * binMs);
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

    const twiLinePath = twiSeries.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(p.binTs).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
    const twiDots = twiSeries.map((p, i) => `<circle class="twi-dot" data-i="${i}" cx="${x(p.binTs).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.5" fill="var(--series-2)" stroke="var(--surface-1)" stroke-width="1.5" style="cursor:pointer"/>`).join('');

    const legend = (otcSeries.length || twiSeries.length) ? `
      <div class="legend" style="margin-bottom:6px;">
        <div class="legend-item"><span class="legend-swatch" style="background:var(--series-1)"></span>${opts.startDate ? `個人報酬（${opts.startDate} 起，以 ${EQUITY_CURVE_CAPITAL / 10000} 萬為分母）` : '個人資金加權報酬'}</div>
        ${otcSeries.length ? `<div class="legend-item"><span class="legend-swatch" style="background:var(--series-3)"></span>櫃買指數（${otcSeries[0].date} 起，基準 0%，資料經核對）</div>` : ''}
        ${twiSeries.length ? `<div class="legend-item"><span class="legend-swatch" style="background:var(--series-2)"></span>加權指數（${twiSeries[0].date} 起，基準 0%，資料經核對）</div>` : ''}
      </div>
    ` : '';

    const svg = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="aspect-ratio:${W}/${H}">
        ${gridLines}
        ${monthTicks}
        <line x1="${PAD.left}" y1="${zeroY.toFixed(1)}" x2="${W - PAD.right}" y2="${zeroY.toFixed(1)}" stroke="var(--baseline)" stroke-width="1.5"/>
        <path d="${areaPath}" fill="var(--series-1)" opacity="0.10" stroke="none"/>
        ${otcLinePath ? `<path d="${otcLinePath}" fill="none" stroke="var(--series-3)" stroke-width="2" stroke-dasharray="5,4" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
        ${twiLinePath ? `<path d="${twiLinePath}" fill="none" stroke="var(--series-2)" stroke-width="2" stroke-dasharray="2,3" stroke-linejoin="round" stroke-linecap="round"/>` : ''}
        <path d="${linePath}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        ${dots}
        ${otcDots}
        ${twiDots}
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
        tooltip.innerHTML = p.isAnchor
          ? `<div class="tt-title">${p.date}</div><div>起點 0%</div>`
          : `<div class="tt-title">${p.date}${p.count > 1 ? `（近 ${BIN_DAYS} 天內 ${p.count} 筆）` : ''}</div><div>最新一筆：${p.symbol}</div><div>累計 ${fmtPct(p.value, 2)}</div>`;
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
    wrap.querySelectorAll('.twi-dot').forEach(dot => {
      dot.addEventListener('mouseenter', () => {
        const p = twiSeries[+dot.dataset.i];
        tooltip.innerHTML = `<div class="tt-title">${p.date}</div><div>加權指數 ${fmtPct(p.value, 2)}</div>`;
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
    if (!weighted.length) {
      el.innerHTML = '<p class="empty-state">尚無帶有損益（萬）的已實現紀錄，無法繪製月度統計。</p>';
      return;
    }
    // 各月份長條圖跟月度統計表用同一套「當月真實總資產」當分母，見 buildMonthlyCapitalBasisMap
    const basisMap = buildMonthlyCapitalBasisMap(weighted);
    const byMonth = {};
    weighted.forEach(t => {
      const m = t.date.slice(0, 7); // YYYY-MM
      byMonth[m] = (byMonth[m] || 0) + monthlyProfitPct(t.profitWan, t.date, basisMap);
    });
    const months = Object.keys(byMonth).sort();
    const otcMonthly = computeOtcMonthlyReturns();
    const twiMonthly = computeTwiMonthlyReturns();
    const data = months.map(m => ({ name: m.replace('-', '/'), value: byMonth[m], otc: otcMonthly[m], twi: twiMonthly[m] }));

    const W = 900, H = 240, PAD = { top: 16, right: 16, bottom: 40, left: 56 };
    const innerW = W - PAD.left - PAD.right, innerH = H - PAD.top - PAD.bottom;
    const values = data.flatMap(d => [d.value, d.otc, d.twi].filter(v => v != null));
    let min = Math.min(0, ...values), max = Math.max(0, ...values);
    if (min === max) { max += 1; }
    const padV = (max - min) * 0.15 || 1;
    min -= (min < 0 ? padV : 0); max += padV;
    const y = (v) => PAD.top + innerH - ((v - min) / (max - min)) * innerH;
    const zeroY = y(0);

    const n = data.length;
    const gap = 20;
    const groupW = Math.min(90, (innerW - gap * (n - 1)) / n);
    const barGap = 4;
    const barW = (groupW - barGap * 2) / 3;
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

      if (d.twi != null) {
        const wx = gx + (barW + barGap) * 2;
        const twiY = Math.min(y(d.twi), zeroY);
        const twiH = Math.max(2, Math.abs(y(d.twi) - zeroY));
        const wTop = d.twi >= 0 ? 4 : 0;
        const wBot = d.twi < 0 ? 4 : 0;
        bars += `<path class="bar" data-i="${i}" data-type="twi" d="${roundedBarPath(wx, twiY, barW, twiH, wTop, wBot)}" fill="var(--series-2)" style="cursor:pointer"/>`;
        const wValY = d.twi >= 0 ? twiY - 6 : twiY + twiH + 14;
        labels += `<text x="${(wx + barW / 2).toFixed(1)}" y="${wValY.toFixed(1)}" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--series-2)">${fmtPct(d.twi, 1)}</text>`;
      }

      labels += `<text x="${(gx + groupW / 2).toFixed(1)}" y="${H - PAD.bottom + 18}" text-anchor="middle" font-size="12" fill="var(--text-secondary)">${d.name}</text>`;
    });

    const legend = `
      <div class="legend" style="margin-bottom:6px;">
        <div class="legend-item"><span class="legend-swatch" style="background:var(--good)"></span>個人資金加權報酬</div>
        <div class="legend-item"><span class="legend-swatch" style="background:var(--series-3)"></span>櫃買指數當月報酬</div>
        <div class="legend-item"><span class="legend-swatch" style="background:var(--series-2)"></span>加權指數當月報酬</div>
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
        const type = bar.dataset.type;
        tooltip.innerHTML = type === 'otc'
          ? `<div class="tt-title">${d.name}</div><div>櫃買指數當月報酬 ${fmtPct(d.otc, 2)}</div>`
          : type === 'twi'
          ? `<div class="tt-title">${d.name}</div><div>加權指數當月報酬 ${fmtPct(d.twi, 2)}</div>`
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
    const byStrategy = strategyList().map((name, i) => {
      const trades = realized.filter(t => t.strategy === name);
      // 平均獲利 = 總獲利（報酬率加總）÷ 總次數，不看資金佔比/資金加權貢獻
      const totalProfit = trades.reduce((s, t) => s + t.returnPct, 0);
      const avg = trades.length ? totalProfit / trades.length : 0;
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
        tooltip.innerHTML = `<div class="tt-title">${s.name}</div><div>平均獲利 ${fmtPct(s.avg, 2)}</div><div>${s.count} 筆紀錄</div>`;
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
      // 平均獲利 = 總獲利（報酬率加總）÷ 總次數，不看資金佔比/資金加權貢獻
      const totalProfit = trades.reduce((s, t) => s + t.returnPct, 0);
      const avg = trades.length ? totalProfit / trades.length : 0;
      return { name, avg, count: trades.length };
    }).filter(s => s.count > 0).sort((a, b) => b.avg - a.avg);

    if (!bySectorAll.length) { el.innerHTML = '<p class="empty-state">尚無資料。</p>'; return; }

    const totalPages = Math.max(1, Math.ceil(bySectorAll.length / SECTOR_PAGE_SIZE));
    if (sectorChartPage >= totalPages) sectorChartPage = totalPages - 1;
    if (sectorChartPage < 0) sectorChartPage = 0;
    const bySector = bySectorAll.slice(sectorChartPage * SECTOR_PAGE_SIZE, (sectorChartPage + 1) * SECTOR_PAGE_SIZE);

    const W = 900, H = 240, PAD = { top: 16, right: 16, bottom: 40, left: 56 };
    const innerW = W - PAD.left - PAD.right, innerH = H - PAD.top - PAD.bottom;
    const values = bySectorAll.map(s => s.avg);
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
      const barY = Math.min(y(s.avg), zeroY);
      const barH = Math.max(2, Math.abs(y(s.avg) - zeroY));
      const color = s.avg >= 0 ? 'var(--good)' : 'var(--critical)';
      bars += `<path class="bar" data-i="${i}" d="${roundedBarPath(bx, barY, barW, barH, s.avg >= 0 ? 4 : 0, s.avg < 0 ? 4 : 0)}" fill="${color}" style="cursor:pointer"/>`;
      labels += `<text x="${(bx + barW / 2).toFixed(1)}" y="${H - PAD.bottom + 18}" text-anchor="middle" font-size="12" fill="var(--text-secondary)">${escapeHtml(s.name)}</text>`;
      const valY = s.avg >= 0 ? barY - 6 : barY + barH + 14;
      labels += `<text x="${(bx + barW / 2).toFixed(1)}" y="${valY.toFixed(1)}" text-anchor="middle" font-size="11" font-weight="700" fill="${color}">${fmtPct(s.avg, 1)}</text>`;
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
        tooltip.innerHTML = `<div class="tt-title">${escapeHtml(s.name)}</div><div>平均獲利 ${fmtPct(s.avg, 2)}</div><div>${s.count} 筆紀錄</div>`;
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

  // ================= MONTHLY REVIEW =================
  let reviewSelectedMonth = null; // 'YYYY-MM'

  function sortedReviews() { return [...state.monthlyReviews].sort((a, b) => b.month.localeCompare(a.month)); }
  function findReview(month) { return state.monthlyReviews.find(r => r.month === month); }
  function monthLabel(m) {
    const [y, mo] = m.split('-');
    return `${y}年${parseInt(mo, 10)}月`;
  }

  function renderMonthlyReview() {
    if (ensureMonthlyReviews()) save();
    const tabsEl = document.getElementById('review-month-tabs');
    const reviews = sortedReviews();
    if (reviewSelectedMonth && !findReview(reviewSelectedMonth)) reviewSelectedMonth = null;
    if (!reviewSelectedMonth && reviews.length) reviewSelectedMonth = reviews[0].month;

    tabsEl.innerHTML = reviews.map(r => `
      <button type="button" class="review-month-chip${r.month === reviewSelectedMonth ? ' active' : ''}" data-month="${r.month}">${monthLabel(r.month)}</button>
    `).join('');
    tabsEl.querySelectorAll('.review-month-chip').forEach(chip => {
      chip.addEventListener('click', () => { reviewSelectedMonth = chip.dataset.month; renderMonthlyReview(); });
    });

    const emptyEl = document.getElementById('review-empty');
    const contentEl = document.getElementById('review-content');
    if (!reviews.length) {
      emptyEl.style.display = 'block';
      contentEl.hidden = true;
      return;
    }
    emptyEl.style.display = 'none';
    contentEl.hidden = false;

    const review = findReview(reviewSelectedMonth);
    document.getElementById('review-month-title').textContent = `${monthLabel(review.month)}月度回顧`;
    renderReviewStatsSnapshot(review);
    renderReviewEntries(review);
    renderReviewReflections(review);
  }

  function renderReviewStatsSnapshot(review) {
    const el = document.getElementById('review-stats-snapshot');
    const row = liveMonthRow(review.month);
    if (!row) { el.innerHTML = ''; return; }
    const pctClass = row.realReturn > 0 ? 'pnl-pos' : row.realReturn < 0 ? 'pnl-neg' : 'pnl-zero';
    const wanClass = row.totalProfitWan > 0 ? 'pnl-pos' : row.totalProfitWan < 0 ? 'pnl-neg' : 'pnl-zero';
    const winPct = row.realizedCount ? (row.wins / row.realizedCount) * 100 : 0;
    el.innerHTML = `
      <div class="stat-grid">
        <div class="stat-tile">
          <span class="stat-label">總報酬率</span>
          <span class="stat-value ${pctClass}">${fmtPct(row.realReturn, 2)}</span>
        </div>
        <div class="stat-tile">
          <span class="stat-label">總損益</span>
          <span class="stat-value ${wanClass}">${fmtWan(row.totalProfitWan, 2)}</span>
        </div>
        <div class="stat-tile">
          <span class="stat-label">勝率</span>
          <span class="stat-value">${row.winRate.toFixed(1)}%</span>
          <div class="winloss-bar"><div class="win" style="width:${winPct}%"></div><div class="loss" style="width:${100 - winPct}%"></div></div>
        </div>
        <div class="stat-tile">
          <span class="stat-label">已實現次數</span>
          <span class="stat-value">${row.realizedCount}</span>
          <span class="stat-sub">${row.wins} 勝 / ${row.losses} 敗</span>
        </div>
        <div class="stat-tile">
          <span class="stat-label">加權平均獲利 / 虧損</span>
          <span class="stat-value">${fmtPct(row.avgWin, 2)} / ${fmtPct(row.avgLoss, 2)}</span>
        </div>
        <div class="stat-tile">
          <span class="stat-label">獲利 / 虧損中位數</span>
          <span class="stat-value">${fmtPct(row.medianWin, 2)} / ${fmtPct(row.medianLoss, 2)}</span>
        </div>
        <div class="stat-tile">
          <span class="stat-label">Profit Factor（加權）</span>
          <span class="stat-value">${row.pf == null ? '∞' : row.pf.toFixed(2)}</span>
        </div>
        <div class="stat-tile">
          <span class="stat-label">最大單筆獲利 / 虧損</span>
          <span class="stat-value">${fmtPct(row.maxWin, 2)} / ${fmtPct(row.maxLoss, 2)}</span>
        </div>
      </div>
      ${row.topTrades ? topBottomTradesHtml(row) : ''}
    `;
  }

  function topBottomTradesTableRowsHtml(trades) {
    return trades.map(t => {
      const profitClass = t.profitWan == null ? 'pnl-zero' : t.profitWan > 0 ? 'pnl-pos' : t.profitWan < 0 ? 'pnl-neg' : 'pnl-zero';
      const pnlClass = t.returnPct == null ? 'pnl-zero' : t.returnPct > 0 ? 'pnl-pos' : t.returnPct < 0 ? 'pnl-neg' : 'pnl-zero';
      const ratingHtml = t.rating ? `<span class="rating-badge rating-${t.rating}">${t.rating}</span>` : '–';
      return `
        <tr>
          <td class="num">${t.date}</td>
          <td><strong>${escapeHtml(t.symbol)}</strong> ${t.name ? `<span style="color:var(--text-muted)">${escapeHtml(t.name)}</span>` : ''}</td>
          <td><span class="badge ${actionBadgeClass(t.action)}">${escapeHtml(t.action)}</span></td>
          <td>${escapeHtml(t.strategy)}</td>
          <td>${escapeHtml(t.sector || '–')}</td>
          <td class="num ${profitClass}">${fmtWan(t.profitWan, 2)}</td>
          <td class="num ${pnlClass}">${fmtPct(t.returnPct, 2)}</td>
          <td>${ratingHtml}</td>
          <td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary)">${escapeHtml(t.reason || '')}</td>
        </tr>
      `;
    }).join('');
  }

  function topBottomTradesHtml(row) {
    const headHtml = `
      <thead>
        <tr>
          <th>日期</th><th>股票</th><th>操作</th><th>策略</th><th>族群</th>
          <th>損益 (萬)</th><th>報酬率</th><th>評級</th><th>理由</th>
        </tr>
      </thead>
    `;
    return `
      <div class="chart-card">
        <div class="chart-head"><h2>當月最佳 2 筆</h2></div>
        <div class="table-wrap">
          <table class="trade-table">${headHtml}<tbody>${topBottomTradesTableRowsHtml(row.topTrades)}</tbody></table>
        </div>
      </div>
      <div class="chart-card">
        <div class="chart-head"><h2>當月最差 2 筆</h2></div>
        <div class="table-wrap">
          <table class="trade-table">${headHtml}<tbody>${topBottomTradesTableRowsHtml(row.bottomTrades)}</tbody></table>
        </div>
      </div>
    `;
  }

  function renderReviewEntries(review) {
    const listEl = document.getElementById('review-entry-list');
    const emptyEl = document.getElementById('review-entry-empty');
    listEl.innerHTML = '';
    emptyEl.style.display = review.entries.length ? 'none' : 'block';
    review.entries.forEach(entry => {
      const card = document.createElement('div');
      card.className = 'review-entry-card';
      card.innerHTML = `
        <div class="review-entry-head">
          <div class="review-entry-title">${escapeHtml(entry.name || '（未命名）')}${entry.symbol ? `<span class="muted">${escapeHtml(entry.symbol)}</span>` : ''}</div>
          <span class="review-entry-badge ${entry.entered ? 'entered' : 'not-entered'}">${entry.entered ? '已進場' : '未進場'}</span>
        </div>
        ${entry.source ? `<div class="review-entry-row"><strong>消息來源：</strong>${escapeHtml(entry.source)}</div>` : ''}
        ${entry.entryPoint ? `<div class="review-entry-row"><strong>進場點位：</strong>${escapeHtml(entry.entryPoint)}</div>` : ''}
        ${entry.indicator ? `<div class="review-entry-row"><strong>指標：</strong>${escapeHtml(entry.indicator)}</div>` : ''}
        ${entry.strategy ? `<div class="review-entry-row"><strong>${entry.entered ? '策略' : '未進場原因'}：</strong>${escapeHtml(entry.strategy)}</div>` : ''}
        ${entry.result ? `<div class="review-entry-row"><strong>結果：</strong>${escapeHtml(entry.result)}</div>` : ''}
        ${entry.meaning ? `<div class="review-entry-row"><strong>意義：</strong>${escapeHtml(entry.meaning)}</div>` : ''}
      `;
      card.addEventListener('click', () => openReviewEntryModal(review, entry));
      listEl.appendChild(card);
    });
  }

  function renderReviewReflections(review) {
    const listEl = document.getElementById('review-reflection-list');
    listEl.innerHTML = review.reflections.length ? review.reflections.map((text, i) => `
      <div class="review-reflection-item">
        <span class="bullet">•</span>
        <span class="reflection-text">${escapeHtml(text)}</span>
        <button type="button" class="row-del" data-del-reflection="${i}" title="刪除">✕</button>
      </div>
    `).join('') : '<p class="empty-state">尚無反思紀錄。</p>';
    listEl.querySelectorAll('[data-del-reflection]').forEach(btn => {
      btn.addEventListener('click', () => {
        review.reflections.splice(+btn.dataset.delReflection, 1);
        save(); renderReviewReflections(review);
      });
    });
  }

  document.getElementById('review-reflection-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const review = findReview(reviewSelectedMonth);
    if (!review) return;
    const textEl = document.getElementById('f-new-reflection');
    const text = textEl.value.trim();
    if (!text) return;
    review.reflections.push(text);
    textEl.value = '';
    save(); renderReviewReflections(review);
  });

  document.getElementById('btn-del-review-month').addEventListener('click', () => {
    const review = findReview(reviewSelectedMonth);
    if (!review) return;
    if (confirm(`確定刪除「${monthLabel(review.month)}」整個月度回顧？`)) {
      state.monthlyReviews = state.monthlyReviews.filter(r => r.month !== review.month);
      reviewSelectedMonth = null;
      save(); renderMonthlyReview();
    }
  });

  // ---- review entry modal ----
  const reviewEntryModal = document.getElementById('review-entry-modal');
  const reviewEntryForm = document.getElementById('review-entry-form');
  const btnDeleteReviewEntry = document.getElementById('btn-delete-review-entry');
  let reviewEntryContextMonth = null;

  document.getElementById('btn-add-review-entry').addEventListener('click', () => {
    const review = findReview(reviewSelectedMonth);
    if (review) openReviewEntryModal(review, null);
  });

  function updateReviewEntryStrategyLabel() {
    const entered = document.getElementById('re-entered').checked;
    document.getElementById('re-strategy-label').firstChild.textContent = entered ? '策略 ' : '未進場原因 ';
  }
  document.getElementById('re-entered').addEventListener('change', updateReviewEntryStrategyLabel);

  function openReviewEntryModal(review, entry) {
    reviewEntryContextMonth = review.month;
    document.getElementById('review-entry-modal-title').textContent = entry ? '編輯單筆' : '新增單筆';
    document.getElementById('re-id').value = entry ? entry.id : '';
    document.getElementById('re-name').value = entry ? (entry.name || '') : '';
    document.getElementById('re-symbol').value = entry ? (entry.symbol || '') : '';
    document.getElementById('re-source').value = entry ? (entry.source || '') : '';
    document.getElementById('re-entry-point').value = entry ? (entry.entryPoint || '') : '';
    document.getElementById('re-indicator').value = entry ? (entry.indicator || '') : '';
    document.getElementById('re-entered').checked = entry ? !!entry.entered : true;
    document.getElementById('re-strategy').value = entry ? (entry.strategy || '') : '';
    document.getElementById('re-result').value = entry ? (entry.result || '') : '';
    document.getElementById('re-meaning').value = entry ? (entry.meaning || '') : '';
    updateReviewEntryStrategyLabel();
    btnDeleteReviewEntry.hidden = !entry;
    reviewEntryModal.classList.add('open');
  }

  reviewEntryForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const review = findReview(reviewEntryContextMonth);
    if (!review) return;
    const id = document.getElementById('re-id').value || uid();
    const rec = {
      id,
      name: document.getElementById('re-name').value.trim(),
      symbol: document.getElementById('re-symbol').value.trim(),
      source: document.getElementById('re-source').value.trim(),
      entryPoint: document.getElementById('re-entry-point').value.trim(),
      indicator: document.getElementById('re-indicator').value.trim(),
      entered: document.getElementById('re-entered').checked,
      strategy: document.getElementById('re-strategy').value.trim(),
      result: document.getElementById('re-result').value.trim(),
      meaning: document.getElementById('re-meaning').value.trim(),
    };
    const idx = review.entries.findIndex(x => x.id === id);
    if (idx >= 0) review.entries[idx] = rec; else review.entries.push(rec);
    save(); closeModals(); renderMonthlyReview();
  });

  btnDeleteReviewEntry.addEventListener('click', () => {
    const review = findReview(reviewEntryContextMonth);
    const id = document.getElementById('re-id').value;
    if (review && id && confirm('確定刪除這筆單筆紀錄？')) {
      review.entries = review.entries.filter(x => x.id !== id);
      save(); closeModals(); renderMonthlyReview();
    }
  });

  // ---- add / paste-import month ----
  const reviewImportModal = document.getElementById('review-import-modal');
  document.getElementById('btn-add-review-month').addEventListener('click', () => {
    document.getElementById('ri-month').value = reviewSelectedMonth || new Date().toISOString().slice(0, 7);
    document.getElementById('ri-text').value = '';
    reviewImportModal.classList.add('open');
  });

  // 解析「一、單筆：」「二、反思：」格式的月度回顧文字。
  // 對格式很寬鬆：找不到標頭就整段當單筆區塊；辨識不了的欄位行會被忽略而不是中斷整筆解析，
  // 避免使用者貼上的內容跟範例有些微出入（多空白、全形/半形冒號、缺欄位）就整段匯入失敗。
  function parseMonthlyReviewText(raw) {
    const text = (raw || '').replace(/\r\n/g, '\n');
    if (!text.trim()) return { month: null, entries: [], reflections: [] };

    let month = null;
    const monthMatch = text.match(/(\d{4})[^\d]{0,3}(\d{1,2})\s*月/);
    if (monthMatch) month = `${monthMatch[1]}-${monthMatch[2].padStart(2, '0')}`;

    const entryHeaderRe = /^[一二三四五六七八九十]*[、.\s]*單筆[：:]?\s*$/;
    const reflectHeaderRe = /^[一二三四五六七八九十]*[、.\s]*反思[：:]?\s*$/;
    const lines = text.split('\n');
    let mode = 'preamble';
    const entryLines = [], reflectionLines = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (entryHeaderRe.test(trimmed)) { mode = 'entries'; continue; }
      if (reflectHeaderRe.test(trimmed)) { mode = 'reflections'; continue; }
      if (mode === 'entries') entryLines.push(line);
      else if (mode === 'reflections') reflectionLines.push(line);
    }
    if (mode === 'preamble') entryLines.push(...lines); // 沒有標頭時，整段當單筆區塊

    const FIELD_MAP = {
      '消息來源': 'source', '消息来源': 'source',
      '進場點位': 'entryPoint', '进场点位': 'entryPoint',
      '指標': 'indicator', '指标': 'indicator',
      '策略': 'strategy', '未進場原因': 'strategy', '未进场原因': 'strategy',
      '結果': 'result', '结果': 'result',
      '意義': 'meaning', '意义': 'meaning',
    };

    const entries = [];
    let block = [];
    const flushBlock = () => {
      const nonEmpty = block.map(l => l.trim()).filter(Boolean);
      block = [];
      if (!nonEmpty.length) return;
      const entry = { name: '', symbol: '', source: '', entryPoint: '', indicator: '', entered: true, strategy: '', result: '', meaning: '' };
      let sawStrategyLabel = null;
      let lastKey = null;
      let first = true;
      for (const line of nonEmpty) {
        const fieldMatch = line.match(/^([^:：]{1,12})[:：]\s*(.*)$/);
        if (first && !fieldMatch) {
          const parts = line.split(/\s+/).filter(Boolean);
          if (parts.length > 1 && /^\d{3,6}[A-Za-z]?$/.test(parts[parts.length - 1])) {
            entry.symbol = parts.pop();
            entry.name = parts.join(' ');
          } else {
            // 名稱與代號中間沒有空格時（例如「南亞1303」），改用結尾數字回退切開
            const noSpaceMatch = line.match(/^(.*?)(\d{3,6}[A-Za-z]?)$/);
            if (noSpaceMatch && noSpaceMatch[1]) { entry.name = noSpaceMatch[1]; entry.symbol = noSpaceMatch[2]; }
            else entry.name = line;
          }
          first = false;
          continue;
        }
        first = false;
        const label = fieldMatch ? fieldMatch[1].trim() : null;
        const key = label ? FIELD_MAP[label] : null;
        if (key) {
          if (key === 'strategy') sawStrategyLabel = /未進場|未进场/.test(label) ? '未進場原因' : '策略';
          // 欄位值裡若殘留重複冒號（例如使用者誤打「消息來源:：xxx」），一併清掉
          entry[key] = fieldMatch[2].trim().replace(/^[：:]+\s*/, '');
          lastKey = key;
        } else if (lastKey) {
          // 辨識不出「標籤：」開頭的行，視為上一個欄位換行接續的內容，直接接在後面，不能靜默丟棄
          entry[lastKey] += line.trim();
        }
      }
      if (sawStrategyLabel) entry.entered = sawStrategyLabel === '策略';
      if (entry.name || entry.symbol || entry.source || entry.result) entries.push(entry);
    };
    for (const line of entryLines) {
      if (!line.trim()) { flushBlock(); continue; }
      block.push(line);
    }
    flushBlock();

    const reflections = reflectionLines.map(l => l.trim()).filter(Boolean);
    return { month, entries, reflections };
  }

  document.getElementById('review-import-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = document.getElementById('ri-text').value;
    const parsed = parseMonthlyReviewText(raw);
    const month = document.getElementById('ri-month').value || parsed.month || new Date().toISOString().slice(0, 7);

    let review = findReview(month);
    if (review && (parsed.entries.length || parsed.reflections.length)) {
      if (!confirm(`「${monthLabel(month)}」已存在回顧紀錄，貼上的內容會附加進去（不會覆蓋原有紀錄），確定繼續？`)) return;
    }
    if (!review) {
      review = { month, entries: [], reflections: [] };
      state.monthlyReviews.push(review);
    }
    parsed.entries.forEach(en => review.entries.push({ id: uid(), ...en }));
    review.reflections.push(...parsed.reflections);

    reviewSelectedMonth = month;
    save(); closeModals(); renderMonthlyReview();
    if (parsed.entries.length || parsed.reflections.length) {
      alert(`已匯入 ${parsed.entries.length} 筆單筆紀錄、${parsed.reflections.length} 條反思。`);
    }
  });

  // ================= SUPPLY CHAIN =================
  // 節點/公司關聯查詢輔助函式：一律從 state.supplyChainNodes / state.companyLinks 現查，不快取，
  // 因為編輯區隨時可能新增/刪除節點，快取容易跟畫面不同步。
  // （供應鏈節點搜尋/瀏覽功能已移除，這裡只留 scNode/scNodesForSymbol 給「所屬供應鏈」
  // 這個資訊顯示用，不再提供節點本身的搜尋或瀏覽入口。）
  function scNode(id) { return state.supplyChainNodes.find(n => n.id === id); }
  function scNodesForSymbol(symbol) {
    return state.companyLinks
      .filter(l => l.symbol === symbol)
      .map(l => ({ ...l, node: scNode(l.nodeId) }))
      .filter(l => l.node);
  }

  let chainQuery = '';
  let chainSelection = null; // { kind: 'sector' | 'symbol', id, label }

  const CHAIN_KIND_LABEL = { sector: '族群', symbol: '標的' };

  // 搜尋只比對「交易紀錄」裡使用者自己輸入過的資料：族群標籤、股票代號／名稱——
  // 不搜供應鏈節點（AI、半導體…那套是另外維護的分類體系，不是使用者在交易紀錄裡打的）。
  function chainSearchMatches(query) {
    const q = query.trim().toLowerCase();
    const matches = [];
    if (!q) return matches; // 沒輸入關鍵字就不顯示任何建議，保持空白

    [...new Set(state.trades.map(t => (t.sector || '').trim()).filter(Boolean))].sort().forEach(sec => {
      if (sec.toLowerCase().includes(q)) matches.push({ kind: 'sector', id: sec, label: sec });
    });

    const symbolNames = new Map();
    state.trades.forEach(t => { if (t.symbol) symbolNames.set(t.symbol, t.name || symbolNames.get(t.symbol) || ''); });
    [...symbolNames.keys()].sort().forEach(sym => {
      const name = symbolNames.get(sym) || '';
      if (sym.toLowerCase().includes(q) || name.toLowerCase().includes(q)) {
        matches.push({ kind: 'symbol', id: sym, label: `${sym} ${name}`.trim() });
      }
    });

    return matches;
  }

  function chainTradesFor(sel) {
    if (!sel) return [];
    if (sel.kind === 'symbol') return sortedTrades().filter(t => t.symbol === sel.id);
    return sortedTrades().filter(t => (t.sector || '').trim() === sel.id);
  }

  // 跟「統計分析」分頁頂部同一組統計卡片，直接吃 computeStats() 的結果
  function statTilesHtml(s) {
    const pctClass = s.totalWeighted > 0 ? 'pnl-pos' : s.totalWeighted < 0 ? 'pnl-neg' : 'pnl-zero';
    const wanClass = s.totalProfitWan > 0 ? 'pnl-pos' : s.totalProfitWan < 0 ? 'pnl-neg' : 'pnl-zero';
    const winPct = s.realized.length ? (s.wins.length / s.realized.length) * 100 : 0;
    return `
      <div class="stat-grid">
        <div class="stat-tile">
          <span class="stat-label">總報酬率</span>
          <span class="stat-value ${pctClass}">${fmtPct(s.totalWeighted, 2)}</span>
          <span class="stat-sub">Σ（報酬率 × 資金佔比）</span>
        </div>
        <div class="stat-tile">
          <span class="stat-label">總損益</span>
          <span class="stat-value ${wanClass}">${fmtWan(s.totalProfitWan, 2)}</span>
        </div>
        <div class="stat-tile">
          <span class="stat-label">勝率</span>
          <span class="stat-value">${s.realized.length ? s.winRate.toFixed(1) + '%' : '–'}</span>
          <div class="winloss-bar"><div class="win" style="width:${winPct}%"></div><div class="loss" style="width:${100 - winPct}%"></div></div>
        </div>
        <div class="stat-tile">
          <span class="stat-label">已實現次數</span>
          <span class="stat-value">${s.realized.length}</span>
          <span class="stat-sub">${s.wins.length} 勝 / ${s.losses.length} 敗</span>
        </div>
        <div class="stat-tile">
          <span class="stat-label">加權平均獲利 / 虧損</span>
          <span class="stat-value">${fmtPct(s.avgWin, 2)} / ${fmtPct(s.avgLoss, 2)}</span>
        </div>
        <div class="stat-tile">
          <span class="stat-label">Profit Factor（加權）</span>
          <span class="stat-value">${s.pf === Infinity ? '∞' : s.realized.length ? s.pf.toFixed(2) : '–'}</span>
        </div>
        <div class="stat-tile">
          <span class="stat-label">最大單筆獲利 / 虧損</span>
          <span class="stat-value">${fmtPct(s.maxWin, 2)} / ${fmtPct(s.maxLoss, 2)}</span>
        </div>
      </div>
    `;
  }

  function renderChainResults() {
    const el = document.getElementById('chain-results');
    if (!el) return;
    const matches = chainSearchMatches(chainQuery);
    if (!matches.length) {
      el.innerHTML = chainQuery.trim() ? '<p class="empty-state" style="padding:12px 0;">找不到符合的族群或標的。</p>' : '';
      return;
    }
    const shown = matches.slice(0, 40);
    el.innerHTML = shown.map((m, i) => {
      const isActive = chainSelection && chainSelection.kind === m.kind && chainSelection.id === m.id;
      return `
        <button type="button" class="chain-chip${isActive ? ' active' : ''}" data-i="${i}">
          <span class="chain-chip-kind">${CHAIN_KIND_LABEL[m.kind]}</span>${escapeHtml(m.label)}
        </button>
      `;
    }).join('');
    el.querySelectorAll('.chain-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        chainSelection = shown[+btn.dataset.i];
        renderChainResults();
        renderChainDetail();
      });
    });
  }

  function chainTradeTableHtml(trades) {
    return `
      <div class="table-wrap">
        <table class="trade-table">
          <thead><tr><th>日期</th><th>操作</th><th>策略</th><th>損益 (萬)</th><th>報酬率</th></tr></thead>
          <tbody>${trades.map(t => {
            const c = displayProfitWan(t);
            const cClass = c == null ? 'pnl-zero' : c > 0 ? 'pnl-pos' : c < 0 ? 'pnl-neg' : 'pnl-zero';
            const rClass = t.returnPct == null ? 'pnl-zero' : t.returnPct > 0 ? 'pnl-pos' : t.returnPct < 0 ? 'pnl-neg' : 'pnl-zero';
            return `
              <tr>
                <td class="num">${t.date}</td>
                <td><span class="badge ${actionBadgeClass(t.action)}">${escapeHtml(t.action)}</span></td>
                <td>${escapeHtml(t.strategy)}</td>
                <td class="num ${cClass}">${fmtWan(c, 2)}</td>
                <td class="num ${rClass}">${fmtPct(t.returnPct, 2)}</td>
              </tr>`;
          }).join('')}</tbody>
        </table>
      </div>
    `;
  }

  function renderChainDetail() {
    const el = document.getElementById('chain-detail');
    if (!el) return;

    if (!chainSelection) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }
    el.hidden = false;

    if (chainSelection.kind === 'symbol') {
      const symbol = chainSelection.id;
      const trades = chainTradesFor(chainSelection);
      const s = computeStats(trades.filter(t => t.returnPct != null));
      const nodeLinks = scNodesForSymbol(symbol);
      const name = trades[0]?.name || nodeLinks.find(l => l.name)?.name || '';
      const sector = (trades.find(t => t.sector)?.sector) || '–';
      el.innerHTML = `
        <div class="chain-detail-head"><h2>${escapeHtml(symbol)} ${escapeHtml(name)}</h2></div>
        <div class="chain-detail-meta">
          <div><span class="chain-meta-label">所屬族群</span>${escapeHtml(sector)}</div>
          <div><span class="chain-meta-label">所屬供應鏈</span>${nodeLinks.length ? nodeLinks.map(l => `${escapeHtml(l.node.name)}${l.role ? `（${escapeHtml(l.role)}）` : ''}`).join('、') : '尚未建立供應鏈資料'}</div>
        </div>
        ${statTilesHtml(s)}
        <h3 class="chain-companies-title">交易紀錄（${trades.length}）</h3>
        ${chainTradeTableHtml(trades)}
      `;
      return;
    }

    if (chainSelection.kind === 'sector') {
      const trades = chainTradesFor(chainSelection);
      const s = computeStats(trades.filter(t => t.returnPct != null));
      const symbols = [...new Set(trades.map(t => t.symbol))];
      el.innerHTML = `
        <div class="chain-detail-head"><h2>${escapeHtml(chainSelection.label)}</h2></div>
        ${statTilesHtml(s)}
        <h3 class="chain-companies-title">相關標的（${symbols.length}）</h3>
        <div class="chain-company-list">
          ${symbols.map(sym => {
            const name = trades.find(t => t.symbol === sym)?.name || '';
            return `<div class="chain-company-row" data-symbol="${escapeHtml(sym)}"><strong>${escapeHtml(sym)}</strong> ${escapeHtml(name)}</div>`;
          }).join('')}
        </div>
        <h3 class="chain-companies-title">交易紀錄（${trades.length}）</h3>
        ${chainTradeTableHtml(trades)}
      `;
      el.querySelectorAll('.chain-company-row').forEach(row => {
        row.addEventListener('click', () => {
          const sym = row.dataset.symbol;
          const name = trades.find(t => t.symbol === sym)?.name || '';
          chainSelection = { kind: 'symbol', id: sym, label: `${sym} ${name}`.trim() };
          renderChainResults();
          renderChainDetail();
        });
      });
    }
  }

  document.getElementById('chain-search').addEventListener('input', (e) => {
    chainQuery = e.target.value;
    if (!chainQuery.trim()) chainSelection = null; // 清空搜尋欄時，下面選到的結果也一併收起來
    renderChainResults();
    renderChainDetail();
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

  // 彈窗登入（signInWithPopup）在瀏覽器把第三方儲存空間分割/封鎖時會失敗
  // （常見於 Safari、開了嚴格第三方 cookie 封鎖的 Chrome 等），因為 Firebase 需要在
  // 這個網站的網域跟 authDomain（*.firebaseapp.com，跟 GitHub Pages 不同網域）之間
  // 共用一份暫存狀態。除了使用者自己關掉彈窗以外，失敗時改用整頁導向登入（signInWithRedirect）
  // 當備援——導向登入只需要同一個分頁的儲存空間在導回時還在，比彈窗需要兩個視窗同時能存取
  // 儲存空間更容易在這類設定下成功。
  // 登入轉接檔跟 App 同網域（authDomain＝enyou0828-wq.github.io），不受第三方儲存空間封鎖影響。
  // 手機與「加到主畫面」的 App 彈窗常常回不來，直接用整頁導向；電腦用彈窗、失敗再導向。
  const preferRedirect = window.matchMedia('(display-mode: standalone)').matches
    || navigator.standalone === true
    || /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
  document.getElementById('btn-google-signin').addEventListener('click', async () => {
    loginStatus.textContent = '登入中…';
    if (preferRedirect) {
      try { await signInWithRedirect(auth, new GoogleAuthProvider()); }
      catch (e) { console.error('signIn (redirect) failed', e); loginStatus.textContent = '登入失敗：' + (e.code || e.message); }
      return;
    }
    try {
      await signInWithPopup(auth, new GoogleAuthProvider());
    } catch (e) {
      console.error('signIn (popup) failed', e);
      if (e.code === 'auth/popup-closed-by-user' || e.code === 'auth/cancelled-popup-request') {
        loginStatus.textContent = '';
        return;
      }
      loginStatus.textContent = '彈窗登入失敗，改用整頁導向登入…';
      try {
        await signInWithRedirect(auth, new GoogleAuthProvider());
      } catch (e2) {
        console.error('signIn (redirect) failed', e2);
        loginStatus.textContent = '登入失敗：' + (e2.code || e2.message);
      }
    }
  });

  // 處理 signInWithRedirect 導回後的結果：成功的話 onAuthStateChanged 會自動接手，
  // 這裡主要是要在導向登入本身失敗時把錯誤訊息顯示出來（否則會無聲失敗，卡在登入畫面）。
  getRedirectResult(auth).catch(e => {
    console.error('getRedirectResult failed', e);
    loginStatus.textContent = '登入失敗：' + (e.code || e.message);
  });

  document.getElementById('btn-signout').addEventListener('click', () => signOut(auth));

  onAuthStateChanged(auth, async (user) => {
    if (user) {
      currentUser = user;
      loginGate.style.display = 'none';
      appRoot.hidden = false;
      userChip.textContent = user.displayName || user.email || '';
      await loadFromCloud(user.uid);
      setupPushNotifications(); // 不 await：推播是附加功能，失敗也不該擋住主要畫面載入
    } else {
      currentUser = null;
      cloudLoaded = false;
      loginGate.style.display = 'flex';
      appRoot.hidden = true;
      loginStatus.textContent = '';
    }
  });

  // ================= init =================
  renderTrades();
})();
