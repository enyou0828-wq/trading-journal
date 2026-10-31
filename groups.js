// 族群分頁：熱力圖、相對輪動圖、上下游、網球 vs 雞蛋。
// 資料由 scripts/group_analytics.py 每日收盤後產出 signals/groups.json。
import { treemap, hierarchy, treemapSquarify } from "https://cdn.jsdelivr.net/npm/d3-hierarchy@3.1.2/+esm";

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sign = v => (v > 0 ? '+' : '') + v.toFixed(2) + '%';
const pct = v => (v == null ? '–' : sign(v));
const cls = v => (v == null || v === 0 ? '' : v > 0 ? 'pnl-pos' : 'pnl-neg');

let data = null;
let view = 'heat';
let heatPeriod = 'c1';
let rrgIndustry = 'all';
let rrgFocus = null;
let tennisGroup = 'all';

export async function renderGroups(root) {
  if (!data) {
    root.innerHTML = '<p class="empty-state">讀取中…</p>';
    try {
      const res = await fetch('signals/groups.json', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } catch (e) {
      root.innerHTML = `<p class="empty-state">讀取族群資料失敗：${esc(e.message)}</p>`;
      return;
    }
  }
  root.innerHTML = `
    <p class="gx-meta">資料日期 ${esc(data.asOf)}　全市場等權 今日 <span class="${cls(data.market.c1)}">${pct(data.market.c1)}</span>　5日 <span class="${cls(data.market.c5)}">${pct(data.market.c5)}</span>　20日 <span class="${cls(data.market.c20)}">${pct(data.market.c20)}</span></p>
    <div class="gx-seg" role="tablist">
      ${[['heat', '熱力圖'], ['rrg', '輪動'], ['baton', '上下游'], ['tennis', '網球 vs 雞蛋']]
        .map(([k, t]) => `<button class="gx-seg-btn${view === k ? ' active' : ''}" data-view="${k}">${t}</button>`).join('')}
    </div>
    <div id="gx-body"></div>`;
  root.querySelectorAll('.gx-seg-btn').forEach(b => b.addEventListener('click', () => { view = b.dataset.view; renderGroups(root); }));
  const body = root.querySelector('#gx-body');
  ({ heat: renderHeat, rrg: renderRrg, baton: renderBaton, tennis: renderTennis })[view](body);
}

// ---------------------------------------------------------------- 熱力圖
function heatColor(v, period) {
  if (v == null) return 'var(--fill)';
  const full = { c1: 6, c5: 15, c20: 30 }[period];
  const k = Math.min(1, Math.abs(v) / full);
  const base = v >= 0 ? 'var(--good-bg)' : 'var(--critical)';
  return `color-mix(in srgb, ${base} ${Math.round(18 + k * 82)}%, var(--gx-neutral))`;
}

function renderHeat(body) {
  body.innerHTML = `
    <div class="chart-card">
      <div class="gx-row">
        <div class="gx-chips">${[['c1', '今日'], ['c5', '5日'], ['c20', '20日']]
          .map(([k, t]) => `<button class="gx-chip${heatPeriod === k ? ' active' : ''}" data-p="${k}">${t}</button>`).join('')}</div>
        <span class="gx-pick" id="gx-heat-pick"></span>
      </div>
      <div class="gx-heat" id="gx-heat"></div>
    </div>
    <div class="chart-card">
      <div class="chart-head"><h2>族群漲跌排行</h2></div>
      <div id="gx-heat-rank"></div>
    </div>`;
  body.querySelectorAll('.gx-chip').forEach(b => b.addEventListener('click', () => { heatPeriod = b.dataset.p; renderHeat(body); }));

  const box = body.querySelector('#gx-heat');
  const W = box.clientWidth || 360;
  const H = W < 600 ? Math.round(W * 1.5) : Math.round(W * 0.62);
  box.style.height = H + 'px';
  const byGroup = new Map();
  for (const s of data.heatmap) {
    if (!byGroup.has(s.group)) byGroup.set(s.group, []);
    byGroup.get(s.group).push(s);
  }
  const root = hierarchy({ children: [...byGroup].map(([g, list]) => ({ name: g, children: list })) })
    .sum(d => (d.value ? Math.sqrt(d.value) : 0))
    .sort((a, b) => b.value - a.value);
  treemap().tile(treemapSquarify).size([W, H]).paddingOuter(2).paddingTop(d => (d.depth === 1 ? 16 : 0)).paddingInner(1).round(true)(root);

  let html = '';
  for (const g of root.children) {
    const gw = g.x1 - g.x0;
    const gs = data.groups.find(x => x.group === g.data.name);
    const gv = gs ? gs[heatPeriod] : null;
    html += `<div class="gx-hg" style="left:${g.x0}px;top:${g.y0}px;width:${gw}px;height:${g.y1 - g.y0}px">
      <span class="gx-hg-label">${gw > 46 ? esc(g.data.name) : ''}${gw > 110 && gv != null ? ` <b class="${cls(gv)}">${sign(gv)}</b>` : ''}</span></div>`;
    for (const leaf of g.children) {
      const s = leaf.data, w = leaf.x1 - leaf.x0, h = leaf.y1 - leaf.y0, v = s[heatPeriod];
      const showName = w > 34 && h > 18, showPct = w > 40 && h > 32;
      html += `<div class="gx-tile" data-code="${s.code}" style="left:${leaf.x0}px;top:${leaf.y0}px;width:${w}px;height:${h}px;background:${heatColor(v, heatPeriod)}">
        ${showName ? `<span class="gx-tile-name" style="font-size:${Math.max(9, Math.min(15, w / 5))}px">${esc(s.name)}</span>` : ''}
        ${showPct ? `<span class="gx-tile-pct">${pct(v)}</span>` : ''}</div>`;
    }
  }
  box.innerHTML = html;
  const pick = body.querySelector('#gx-heat-pick');
  box.addEventListener('click', e => {
    const t = e.target.closest('.gx-tile');
    if (!t) return;
    const s = data.heatmap.find(x => x.code === t.dataset.code);
    box.querySelectorAll('.gx-tile.sel').forEach(x => x.classList.remove('sel'));
    t.classList.add('sel');
    pick.innerHTML = `<b>${esc(s.name)}</b> ${s.code}・${esc(s.group)}　<span class="${cls(s[heatPeriod])}">${pct(s[heatPeriod])}</span>　${s.close}`;
  });

  const ranked = [...data.groups].filter(g => g[heatPeriod] != null).sort((a, b) => b[heatPeriod] - a[heatPeriod]);
  const maxAbs = Math.max(1, ...ranked.map(g => Math.abs(g[heatPeriod])));
  body.querySelector('#gx-heat-rank').innerHTML = ranked.map(g => {
    const v = g[heatPeriod], w = Math.abs(v) / maxAbs * 50;
    return `<div class="gx-bar-row"><span class="gx-bar-name">${esc(g.group)}</span>
      <span class="gx-bar-track"><span class="gx-bar ${v >= 0 ? 'up' : 'down'}" style="${v >= 0 ? 'left:50%' : `left:${50 - w}%`};width:${w}%"></span></span>
      <span class="gx-bar-val ${cls(v)}">${sign(v)}</span></div>`;
  }).join('');
}

// ---------------------------------------------------------------- 輪動
const QUAD = { 領先: 'var(--good)', 轉弱: 'var(--series-3)', 落後: 'var(--critical)', 改善: 'var(--series-1)' };

function renderRrg(body) {
  const industries = [...new Set(data.rrg.map(r => r.industry))];
  body.innerHTML = `
    <div class="chart-card">
      <div class="gx-row">
        <select id="gx-rrg-ind" class="gx-select">
          <option value="all">全部產業</option>
          ${industries.map(i => `<option value="${esc(i)}"${rrgIndustry === i ? ' selected' : ''}>${esc(i)}</option>`).join('')}
        </select>
        <span class="gx-pick" id="gx-rrg-pick"></span>
      </div>
      <div class="gx-rrg" id="gx-rrg"></div>
    </div>
    <div class="gx-quads" id="gx-quads"></div>`;
  body.querySelector('#gx-rrg-ind').addEventListener('change', e => { rrgIndustry = e.target.value; rrgFocus = null; renderRrg(body); });

  const list = data.rrg.filter(r => rrgIndustry === 'all' || r.industry === rrgIndustry);
  const box = body.querySelector('#gx-rrg');
  const W = Math.min(box.clientWidth || 360, 760);
  const H = Math.round(W * (W < 600 ? 1.05 : 0.72));
  // 座標範圍依各族群「目前位置」決定（取第 90 百分位，避免單一極端值把其他族群擠在中間），超出的尾巴截在邊緣
  const p90 = arr => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] ?? 2; };
  const heads = list.map(r => r.tail[r.tail.length - 1]);
  const dx = Math.max(1.5, p90(heads.map(p => Math.abs(p.x - 100)))) * 1.35;
  const dy = Math.max(1.5, p90(heads.map(p => Math.abs(p.y - 100)))) * 1.35;
  const pad = 26;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const X = x => pad + (clamp(x, 100 - dx, 100 + dx) - (100 - dx)) / (2 * dx) * (W - 2 * pad);
  const Y = y => H - pad - (clamp(y, 100 - dy, 100 + dy) - (100 - dy)) / (2 * dy) * (H - 2 * pad);
  const cx = X(100), cy = Y(100);

  let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="gx-rrg-svg">
    <rect x="${cx}" y="${pad}" width="${W - pad - cx}" height="${cy - pad}" fill="${QUAD['領先']}" opacity=".07"/>
    <rect x="${cx}" y="${cy}" width="${W - pad - cx}" height="${H - pad - cy}" fill="${QUAD['轉弱']}" opacity=".08"/>
    <rect x="${pad}" y="${cy}" width="${cx - pad}" height="${H - pad - cy}" fill="${QUAD['落後']}" opacity=".07"/>
    <rect x="${pad}" y="${pad}" width="${cx - pad}" height="${cy - pad}" fill="${QUAD['改善']}" opacity=".07"/>
    <line x1="${cx}" y1="${pad}" x2="${cx}" y2="${H - pad}" stroke="var(--baseline)"/>
    <line x1="${pad}" y1="${cy}" x2="${W - pad}" y2="${cy}" stroke="var(--baseline)"/>
    <text x="${W - pad - 4}" y="${pad + 14}" text-anchor="end" class="gx-q-label" fill="${QUAD['領先']}">領先</text>
    <text x="${W - pad - 4}" y="${H - pad - 6}" text-anchor="end" class="gx-q-label" fill="${QUAD['轉弱']}">轉弱</text>
    <text x="${pad + 4}" y="${H - pad - 6}" class="gx-q-label" fill="${QUAD['落後']}">落後</text>
    <text x="${pad + 4}" y="${pad + 14}" class="gx-q-label" fill="${QUAD['改善']}">改善</text>
    <text x="${W - pad}" y="${cy - 4}" text-anchor="end" class="gx-axis">相對強度 →</text>
    <text x="${cx + 4}" y="${pad - 8}" class="gx-axis">動能 ↑</text>`;
  // 有選定族群或已篩選產業時才畫清楚的尾巴；全部族群時尾巴淡化，避免整片糊在一起
  const showTails = !!rrgFocus || rrgIndustry !== 'all';
  // 手機寬度且顯示全部族群時，只標改善／領先象限與選定的族群，其他點一下才顯示名稱
  const narrow = W < 600;
  const showLabel = r => !narrow || rrgIndustry !== 'all' || rrgFocus === r.group || r.quadrant === '領先' || r.quadrant === '改善';
  const ordered = [...list].sort((a, b) => (a.group === rrgFocus) - (b.group === rrgFocus));
  for (const r of ordered) {
    const dim = rrgFocus && rrgFocus !== r.group;
    const c = QUAD[r.quadrant];
    const path = r.tail.map(p => `${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join(' ');
    const head = r.tail[r.tail.length - 1];
    const tailOpacity = showTails ? 0.6 : 0.18;
    svg += `<g class="gx-rrg-g${dim ? ' dim' : ''}" data-g="${esc(r.group)}">
      <polyline points="${path}" fill="none" stroke="${c}" stroke-width="${rrgFocus === r.group ? 2.5 : 1.4}" opacity="${tailOpacity}"/>
      ${showTails ? r.tail.slice(0, -1).map(p => `<circle cx="${X(p.x).toFixed(1)}" cy="${Y(p.y).toFixed(1)}" r="1.6" fill="${c}" opacity=".5"/>`).join('') : ''}
      <circle cx="${X(head.x).toFixed(1)}" cy="${Y(head.y).toFixed(1)}" r="${rrgFocus === r.group ? 6 : 4.5}" fill="${c}" stroke="var(--surface-1)" stroke-width="1.2"/>
      ${showLabel(r) ? (X(head.x) > W * 0.72
        ? `<text x="${(X(head.x) - 7).toFixed(1)}" y="${(Y(head.y) - 6).toFixed(1)}" text-anchor="end" class="gx-rrg-label">${esc(r.group)}</text>`
        : `<text x="${(X(head.x) + 6).toFixed(1)}" y="${(Y(head.y) - 5).toFixed(1)}" class="gx-rrg-label">${esc(r.group)}</text>`) : ''}
      <circle cx="${X(head.x).toFixed(1)}" cy="${Y(head.y).toFixed(1)}" r="14" fill="transparent"/>
    </g>`;
  }
  svg += '</svg>';
  box.innerHTML = svg;
  box.querySelectorAll('.gx-rrg-g').forEach(g => g.addEventListener('click', () => {
    rrgFocus = rrgFocus === g.dataset.g ? null : g.dataset.g;
    renderRrg(body);
  }));
  if (rrgFocus) {
    const r = list.find(x => x.group === rrgFocus);
    const gs = data.groups.find(x => x.group === rrgFocus);
    if (r) body.querySelector('#gx-rrg-pick').innerHTML = `<b>${esc(r.group)}</b>・${r.quadrant} ${r.entered} 天　5日 <span class="${cls(gs?.c5)}">${pct(gs?.c5)}</span>　20日 <span class="${cls(gs?.c20)}">${pct(gs?.c20)}</span>`;
  }

  body.querySelector('#gx-quads').innerHTML = ['改善', '領先', '轉弱', '落後'].map(q => {
    const items = list.filter(r => r.quadrant === q).sort((a, b) => a.entered - b.entered);
    return `<div class="chart-card gx-quad">
      <div class="chart-head"><h2 style="color:${QUAD[q]}">${q}</h2><span class="gx-count">${items.length}</span></div>
      ${items.length ? items.map(r => `<div class="gx-quad-item"><span>${esc(r.group)}</span><span class="gx-days${r.entered <= 3 && (q === '改善' || q === '領先') ? ' new' : ''}">${r.entered <= 3 ? '剛進入' : r.entered + ' 天'}</span></div>`).join('') : '<p class="gx-none">–</p>'}
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------- 上下游
function renderBaton(body) {
  const { summary: s, paths } = data.baton;
  const edge = p => p.hit != null && p.baseHit != null ? p.hit - p.baseHit : -999;
  const active = paths.filter(p => p.active);
  const near = paths.filter(p => !p.active && p.a5 != null && p.b5 != null && p.a5 >= s.hotPct * 0.6 && p.b5 <= s.lagPct)
    .sort((a, b) => b.a5 - a.a5);
  const ranked = paths.filter(p => p.n >= 3).sort((a, b) => edge(b) - edge(a));

  const DIR = { down: '上游帶下游', up: '下游帶上游' };
  const dirTag = p => `<span class="gx-tag">${DIR[p.dir]}</span>`;
  const dirShort = p => `<span class="gx-tag">${p.dir === 'up' ? '下→上' : '上→下'}</span>`;
  const card = (p, tag) => `<div class="gx-baton">
      <div class="gx-baton-path"><b>${esc(p.from)}</b><span class="gx-arrow">→</span><b>${esc(p.to)}</b><span class="gx-item">${esc(p.item)}</span>${dirTag(p)}${tag}</div>
      <div class="gx-baton-stats">
        <span>${esc(p.from)} 5日超額 <b class="${cls(p.a5)}">${pct(p.a5)}</b></span>
        <span>${esc(p.to)} 5日超額 <b class="${cls(p.b5)}">${pct(p.b5)}</b></span>
        ${p.since != null ? `<span>觸發後 <b class="${cls(p.since)}">${pct(p.since)}</b></span>` : ''}
        <span>歷史 ${p.n} 次・命中 ${p.hit == null ? '–' : p.hit + '%'}（基準 ${p.baseHit ?? '–'}%）</span>
      </div></div>`;

  body.innerHTML = `
    <div class="chart-card">
      <div class="gx-dirgrid">
        <span></span><span>次數</span><span>命中／基準</span><span>${s.fwdDays}日超額／基準</span>
        ${[['全部', s], ['上→下', s.byDir?.down], ['下→上', s.byDir?.up]].filter(([, x]) => x).map(([k, x]) => `
          <b>${k}</b><b>${x.events}</b>
          <b><i class="${x.hit > x.baseHit ? 'pnl-pos' : 'pnl-neg'}">${x.hit ?? '–'}%</i>／${x.baseHit ?? '–'}%</b>
          <b><i class="${cls(x.avg)}">${pct(x.avg)}</i>／${pct(x.baseAvg)}</b>`).join('')}
      </div>
      <p class="gx-rule">領漲端 5 日超額 ≥ ${s.hotPct}%・落後端 ≤ ${s.lagPct}%</p>
    </div>
    <div class="chart-card">
      <div class="chart-head"><h2>目前觸發</h2><span class="gx-count">${active.length}</span></div>
      ${active.length ? active.map(p => card(p, `<span class="gx-tag hot">${esc(p.active.slice(5))}</span>`)).join('') : '<p class="gx-none">–</p>'}
    </div>
    <div class="chart-card">
      <div class="chart-head"><h2>接近觸發</h2><span class="gx-count">${near.length}</span></div>
      ${near.length ? near.map(p => card(p, '')).join('') : '<p class="gx-none">–</p>'}
    </div>
    <div class="chart-card">
      <div class="chart-head"><h2>路徑歷史</h2></div>
      <div class="table-wrap"><table class="trade-table gx-table">
        <thead><tr><th>路徑</th><th class="num">次數</th><th class="num">命中</th><th class="num">基準</th><th class="num">平均超額</th><th class="num">基準超額</th></tr></thead>
        <tbody>${ranked.map(p => `<tr>
          <td>${esc(p.from)} → ${esc(p.to)} ${dirShort(p)}</td>
          <td class="num">${p.n}</td>
          <td class="num ${p.hit > p.baseHit ? 'pnl-pos' : 'pnl-neg'}">${p.hit}%</td>
          <td class="num">${p.baseHit}%</td>
          <td class="num ${cls(p.avg)}">${pct(p.avg)}</td>
          <td class="num">${pct(p.baseAvg)}</td></tr>`).join('')}</tbody>
      </table></div>
    </div>`;
}

// ---------------------------------------------------------------- 網球 vs 雞蛋
function tennisBadge(t) {
  if (!t.pulled) return '<span class="gx-tag">未拉回</span>';
  if (t.rec >= 80) return '<span class="gx-tag ball">🎾 網球</span>';
  if (t.rec < 30 && t.state === '5日線下') return '<span class="gx-tag egg">🥚 雞蛋</span>';
  return '';
}

function tennisRows(list) {
  return list.map(t => `<tr>
    <td><strong>${esc(t.name)}</strong> <span class="gx-code">${t.code}</span></td>
    <td>${esc(t.group)}</td>
    <td class="num pnl-neg">${pct(t.pull)}</td>
    <td class="num"><span class="gx-rec"><span style="width:${Math.max(0, Math.min(100, t.rec))}%"></span></span>${t.rec}%</td>
    <td class="num">${t.daysLow}</td>
    <td class="num">${t.reclaim ?? '–'}</td>
    <td>${esc(t.state)} ${tennisBadge(t)}</td></tr>`).join('');
}

const TENNIS_HEAD = '<thead><tr><th>股票</th><th>族群</th><th class="num">拉回</th><th class="num">收復</th><th class="num">低點後天數</th><th class="num">站回5日線</th><th>狀態</th></tr></thead>';

function renderTennis(body) {
  const groups = [...new Set(data.tennis.map(t => t.group))];
  const sortRec = (a, b) => b.rec - a.rec || a.daysLow - b.daysLow;
  let content;
  if (tennisGroup === 'all') {
    const pulled = data.tennis.filter(t => t.pulled).sort(sortRec);
    const balls = pulled.slice(0, 20);
    const eggs = pulled.filter(t => t.state === '5日線下').sort((a, b) => a.rec - b.rec || a.pull - b.pull).slice(0, 20);
    const gScore = groups.map(g => {
      const m = data.tennis.filter(t => t.pulled && (t.group === g || t.also.includes(g)));
      return { g, n: m.length, rec: m.length ? m.reduce((a, t) => a + t.rec, 0) / m.length : null };
    }).filter(x => x.n >= 2).sort((a, b) => b.rec - a.rec);
    content = `
      <div class="chart-card"><div class="chart-head"><h2>族群收復排行</h2></div>
        ${gScore.map(x => `<div class="gx-bar-row"><span class="gx-bar-name">${esc(x.g)}</span>
          <span class="gx-bar-track"><span class="gx-bar ${x.rec >= 50 ? 'up' : 'down'}" style="left:0;width:${x.rec}%"></span></span>
          <span class="gx-bar-val">${x.rec.toFixed(0)}%</span></div>`).join('')}
      </div>
      <div class="chart-card"><div class="chart-head"><h2>🎾 網球</h2></div>
        <div class="table-wrap"><table class="trade-table gx-table">${TENNIS_HEAD}<tbody>${tennisRows(balls)}</tbody></table></div></div>
      <div class="chart-card"><div class="chart-head"><h2>🥚 雞蛋</h2></div>
        <div class="table-wrap"><table class="trade-table gx-table">${TENNIS_HEAD}<tbody>${tennisRows(eggs)}</tbody></table></div></div>`;
  } else {
    const list = data.tennis.filter(t => t.group === tennisGroup || t.also.includes(tennisGroup))
      .sort((a, b) => (b.pulled - a.pulled) || sortRec(a, b));
    content = `<div class="chart-card"><div class="table-wrap"><table class="trade-table gx-table">${TENNIS_HEAD}<tbody>${tennisRows(list)}</tbody></table></div></div>`;
  }
  body.innerHTML = `
    <div class="gx-row" style="margin-bottom:12px">
      <select id="gx-tennis-g" class="gx-select">
        <option value="all">全部族群</option>
        ${groups.map(g => `<option value="${esc(g)}"${tennisGroup === g ? ' selected' : ''}>${esc(g)}</option>`).join('')}
      </select>
    </div>${content}`;
  body.querySelector('#gx-tennis-g').addEventListener('change', e => { tennisGroup = e.target.value; renderTennis(body); });
}
