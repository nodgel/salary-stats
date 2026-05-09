/* Salary Atlas — interactive dashboard for rs.ge income statistics. */
(function () {
  "use strict";

  const D = window.SALARY_DATA;
  if (!D) { console.error("SALARY_DATA missing"); return; }

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  /* ─── Format helpers ───────────────────────────────────── */
  const nfInt = new Intl.NumberFormat("en-US");
  const fmtMoney = (n) => {
    if (n === null || !isFinite(n)) return "—";
    if (n >= 1e6) return "₾" + (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return "₾" + nfInt.format(Math.round(n));
    return "₾" + n.toFixed(0);
  };
  const fmtMoneyExact = (n) => "₾" + nfInt.format(Math.round(n));
  const fmtPeople = (n) => {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return nfInt.format(n);
  };
  const fmtPct = (n, digits = 1) => (n * 100).toFixed(digits) + "%";
  const fmtRange = (r) => {
    const lo = nfInt.format(r.lo);
    if (r.hi === null) return "≥ ₾" + lo;
    return "₾" + lo + "–" + nfInt.format(r.hi);
  };
  const shortRange = (r) => {
    const k = (n) => n >= 1000 ? (n / 1000).toFixed(n % 1000 ? 1 : 0) + "k" : String(n);
    if (r.hi === null) return k(r.lo) + "+";
    return k(r.lo) + "–" + k(r.hi);
  };

  /* ─── Data lookup ──────────────────────────────────────── */
  const recordIndex = new Map();
  for (const r of D.records) recordIndex.set(`${r.y}|${r.m}|${r.t}`, r);
  const findRecord = (y, m, t) => recordIndex.get(`${y}|${m}|${t}`);

  /* ─── Stats engine ─────────────────────────────────────── */
  function totals(buckets) {
    let n = 0, inc = 0;
    for (const [c, i] of buckets) { n += c; inc += i; }
    return { n, inc };
  }

  // Pareto α for the open-ended top bucket: mean = α·lo / (α-1) → α = mean/(mean-lo)
  function topBucketAlpha(lo, count, income) {
    if (count <= 0) return 2;
    const mean = income / count;
    if (mean <= lo) return 5;
    const alpha = mean / (mean - lo);
    return Math.max(1.05, Math.min(alpha, 6));
  }

  // Percentile: p in [0,100] → value (GEL). Linear within finite brackets, Pareto in top bracket.
  function percentile(buckets, ranges, p) {
    const { n } = totals(buckets);
    if (n === 0) return null;
    const target = n * p / 100;
    let cum = 0;
    for (let i = 0; i < buckets.length; i++) {
      const [c] = buckets[i];
      if (c === 0) continue;
      if (cum + c >= target) {
        const r = ranges[i];
        const frac = Math.max(0, Math.min(1, (target - cum) / c));
        if (r.hi === null) {
          const alpha = topBucketAlpha(r.lo, c, buckets[i][1]);
          if (frac >= 0.999) return r.lo * 10;
          return r.lo / Math.pow(1 - frac, 1 / alpha);
        }
        return r.lo + frac * (r.hi - r.lo);
      }
      cum += c;
    }
    const last = ranges[ranges.length - 1];
    return last.hi || last.lo * 2;
  }

  function rankOf(buckets, ranges, income) {
    const { n } = totals(buckets);
    if (n === 0 || !isFinite(income) || income <= 0) return null;
    let cum = 0;
    for (let i = 0; i < buckets.length; i++) {
      const r = ranges[i];
      const [c] = buckets[i];
      const within = r.hi === null ? income >= r.lo : (income >= r.lo && income < r.hi);
      if (within) {
        let frac;
        if (r.hi === null) {
          const alpha = topBucketAlpha(r.lo, c, buckets[i][1]);
          frac = 1 - Math.pow(r.lo / income, alpha);
          frac = Math.max(0, Math.min(0.999, frac));
        } else {
          frac = (income - r.lo) / (r.hi - r.lo);
        }
        return ((cum + frac * c) / n) * 100;
      }
      cum += c;
    }
    if (income <= 0) return 0;
    return 99.99;
  }

  function lorenz(buckets, ranges) {
    const { n, inc } = totals(buckets);
    if (n === 0 || inc === 0) return { pts: [[0, 0], [1, 1]], gini: 0 };
    const pts = [[0, 0]];
    let cumPop = 0, cumInc = 0;
    for (let i = 0; i < buckets.length; i++) {
      const [c, ii] = buckets[i];
      if (c === 0) continue;
      cumPop += c / n;
      cumInc += ii / inc;
      pts.push([cumPop, cumInc]);
    }
    let area = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0];
      const avgY = (pts[i][1] + pts[i - 1][1]) / 2;
      area += dx * avgY;
    }
    const gini = 1 - 2 * area;
    return { pts, gini: Math.max(0, Math.min(1, gini)) };
  }

  function topShare(buckets, ranges, fraction) {
    const { n, inc } = totals(buckets);
    if (n === 0 || inc === 0) return 0;
    const target = n * (1 - fraction);
    let cum = 0, cumInc = 0;
    for (let i = 0; i < buckets.length; i++) {
      const [c, ii] = buckets[i];
      if (c === 0) continue;
      const start = cum, end = cum + c;
      if (end <= target) {
        cum = end; cumInc += ii;
        continue;
      }
      const within = Math.max(0, target - start);
      const fracIncluded = 1 - within / c;
      cumInc += ii * fracIncluded;
      cum = end;
    }
    return 1 - cumInc / inc;
  }

  function bottomShare(buckets, ranges, fraction) {
    const { n, inc } = totals(buckets);
    if (n === 0 || inc === 0) return 0;
    const target = n * fraction;
    let cum = 0, cumInc = 0;
    for (let i = 0; i < buckets.length; i++) {
      const [c, ii] = buckets[i];
      if (c === 0) continue;
      const end = cum + c;
      if (end <= target) {
        cum = end; cumInc += ii;
      } else {
        const within = (target - cum) / c;
        cumInc += ii * within;
        cum = target;
        break;
      }
    }
    return cumInc / inc;
  }

  function summarize(record, ranges) {
    if (!record) return null;
    const b = record.b;
    const t = totals(b);
    const mean = t.n ? t.inc / t.n : 0;
    const median = percentile(b, ranges, 50);
    const p10 = percentile(b, ranges, 10);
    const p25 = percentile(b, ranges, 25);
    const p75 = percentile(b, ranges, 75);
    const p90 = percentile(b, ranges, 90);
    const p99 = percentile(b, ranges, 99);
    const lc = lorenz(b, ranges);
    const top10 = topShare(b, ranges, 0.10);
    const top1 = topShare(b, ranges, 0.01);
    const bot50 = bottomShare(b, ranges, 0.50);
    return {
      n: t.n, totalIncome: t.inc, mean, median, p10, p25, p75, p90, p99,
      gini: lc.gini, lorenzPts: lc.pts, top10, top1, bot50,
    };
  }

  // Color palette for income types (used by the comparison chart).
  const TYPE_COLORS = {
    "All":         "#7c5cff",
    "Salary":      "#00e0c6",
    "Dividend":    "#ff5d8f",
    "Profit":      "#ffb547",
    "Interest":    "#4ade80",
    "Royalty":     "#22d3ee",
    "Lease Fee":   "#a855f7",
    "Service Fee": "#f97316",
    "Stipend":     "#fb7185",
    "Property":    "#fde047",
    "Partnership": "#94a3b8",
    "Social Tax":  "#e879f9",
    "Other":       "#64748b",
  };
  const colorFor = (t) => TYPE_COLORS[t] || "#9ca3af";

  /* ─── State ────────────────────────────────────────────── */
  function pickDefault() {
    const candidates = [
      { y: 2026, m: "March", t: "Salary" },
      { y: 2026, m: "February", t: "Salary" },
      { y: 2025, m: "December", t: "Salary" },
      { y: 2025, m: "March", t: "Salary" },
      { y: D.years[D.years.length - 1], m: "All", t: "All" },
    ];
    for (const c of candidates) {
      const r = recordIndex.get(`${c.y}|${c.m}|${c.t}`);
      if (r) {
        let n = 0;
        for (const [count] of r.b) n += count;
        if (n > 1000) return c;
      }
    }
    const last = D.records[D.records.length - 1];
    return { y: last.y, m: last.m, t: last.t };
  }
  const _def = pickDefault();
  const state = {
    year: _def.y,
    month: _def.m,
    type: _def.t,
    standIncome: null,
    activeBracket: null,
    trendMetric: "median",
    compareMetric: "median",
    compareTypes: new Set(["Salary", "Profit", "Dividend"].filter((t) => D.types.includes(t))),
  };

  /* ─── Filter wiring ────────────────────────────────────── */
  function populateSelect(sel, items, current, formatter = String) {
    sel.innerHTML = "";
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item;
      opt.textContent = formatter(item);
      if (String(item) === String(current)) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function refreshFilters() {
    populateSelect($("#filterYear"), D.years, state.year);
    const monthsForYear = new Set();
    for (const r of D.records) if (r.y === state.year) monthsForYear.add(r.m);
    const months = D.months.filter((m) => monthsForYear.has(m));
    if (!months.includes(state.month)) state.month = months.includes("All") ? "All" : months[0];
    populateSelect($("#filterMonth"), months, state.month);
    const typesAvail = new Set();
    for (const r of D.records) if (r.y === state.year && r.m === state.month) typesAvail.add(r.t);
    const types = D.types.filter((t) => typesAvail.has(t));
    if (!types.includes(state.type)) state.type = types.includes("Salary") ? "Salary" : (types.includes("All") ? "All" : types[0]);
    populateSelect($("#filterType"), types, state.type);
  }

  /* ─── SVG chart helpers ────────────────────────────────── */
  const SVG = "http://www.w3.org/2000/svg";
  function svgEl(name, attrs = {}, parent = null) {
    const el = document.createElementNS(SVG, name);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  /* ─── Tooltip ──────────────────────────────────────────── */
  const tip = $("#tooltip");
  function showTip(html, evt) {
    tip.innerHTML = html;
    tip.hidden = false;
    const x = (evt.touches ? evt.touches[0].clientX : evt.clientX);
    const y = (evt.touches ? evt.touches[0].clientY : evt.clientY);
    tip.style.left = x + "px";
    tip.style.top = (y - 8) + "px";
  }
  function hideTip() { tip.hidden = true; }
  document.addEventListener("scroll", hideTip, { passive: true });
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".bar") && !e.target.closest(".dot") && !e.target.closest(".lorenz-point")) hideTip();
  });

  /* ─── Histogram ────────────────────────────────────────── */
  function drawHistogram(buckets, ranges, summary) {
    const svg = $("#histChart");
    clear(svg);
    const rect = svg.getBoundingClientRect();
    const W = Math.max(320, Math.round(rect.width || 800));
    const H = Math.max(280, Math.round(rect.height || 360));
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const padL = W < 480 ? 44 : 56, padR = 12, padT = 12, padB = W < 480 ? 56 : 64;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const defs = svgEl("defs", {}, svg);
    let g = svgEl("linearGradient", { id: "barGrad", x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
    svgEl("stop", { offset: "0%", "stop-color": "#a18cff", "stop-opacity": 1 }, g);
    svgEl("stop", { offset: "100%", "stop-color": "#7c5cff", "stop-opacity": 0.65 }, g);
    g = svgEl("linearGradient", { id: "barGradActive", x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
    svgEl("stop", { offset: "0%", "stop-color": "#5cffe7", "stop-opacity": 1 }, g);
    svgEl("stop", { offset: "100%", "stop-color": "#00e0c6", "stop-opacity": 0.85 }, g);

    const max = Math.max(1, ...buckets.map(([c]) => c));
    const N = buckets.length;
    const gap = 2;
    const barW = (innerW - (N - 1) * gap) / N;

    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const y = padT + innerH - (i / ticks) * innerH;
      svgEl("line", { class: "gridline", x1: padL, x2: padL + innerW, y1: y, y2: y }, svg);
      const v = Math.round((i / ticks) * max);
      svgEl("text", { x: padL - 6, y: y + 4, "text-anchor": "end" }, svg).textContent = fmtPeople(v);
    }
    const yTitle = svgEl("text", { class: "axis-title", x: -((padT + innerH / 2)), y: 14, transform: "rotate(-90)" }, svg);
    yTitle.textContent = "PEOPLE";

    const medianVal = summary.median;
    let medianX = null;
    let cumCount = 0;
    const total = summary.n || 1;
    for (let i = 0; i < N; i++) {
      const [c] = buckets[i];
      const x = padL + i * (barW + gap);
      const h = (c / max) * innerH;
      const y = padT + innerH - h;
      const r = ranges[i];
      const rect = svgEl("rect", {
        class: "bar" + (state.activeBracket === i ? " active" : ""),
        x, y, width: Math.max(1, barW), height: Math.max(0, h),
        rx: 2,
        "data-i": i,
      }, svg);
      if (state.activeBracket !== null && state.activeBracket !== i) rect.classList.add("muted");
      rect.addEventListener("click", (e) => {
        state.activeBracket = state.activeBracket === i ? null : i;
        drawHistogram(buckets, ranges, summary);
        renderBracketDetail(buckets, ranges, summary);
        e.stopPropagation();
      });
      const showBucketTip = (e) => {
        const pct = c / total;
        const avg = c > 0 ? buckets[i][1] / c : 0;
        showTip(
          `<div><strong>${fmtRange(r)}</strong></div>` +
          `<div class="tt-row"><span class="tt-key">People</span><span>${nfInt.format(c)}</span></div>` +
          `<div class="tt-row"><span class="tt-key">Share</span><span>${fmtPct(pct, 2)}</span></div>` +
          `<div class="tt-row"><span class="tt-key">Avg in bracket</span><span>${fmtMoney(avg)}</span></div>`,
          e
        );
      };
      rect.addEventListener("mousemove", showBucketTip);
      rect.addEventListener("mouseleave", hideTip);
      rect.addEventListener("touchstart", showBucketTip, { passive: true });

      if (medianX === null && medianVal !== null) {
        if ((r.hi === null && medianVal >= r.lo) || (r.hi !== null && medianVal >= r.lo && medianVal < r.hi)) {
          const within = r.hi === null ? Math.min(1, (medianVal - r.lo) / Math.max(1, r.lo)) : (medianVal - r.lo) / (r.hi - r.lo);
          medianX = x + within * barW;
        }
      }
      cumCount += c;
    }

    const labelStep = N <= 16 ? 1 : (N <= 24 ? 2 : 3);
    for (let i = 0; i < N; i++) {
      if (i % labelStep !== 0 && i !== N - 1) continue;
      const r = ranges[i];
      const x = padL + i * (barW + gap) + barW / 2;
      const t = svgEl("text", {
        x, y: padT + innerH + 14,
        "text-anchor": "end",
        transform: `rotate(-45 ${x} ${padT + innerH + 14})`,
      }, svg);
      t.textContent = shortRange(r);
    }

    if (medianX !== null) {
      svgEl("line", { x1: medianX, x2: medianX, y1: padT, y2: padT + innerH, stroke: "#ffb547", "stroke-width": 1.5, "stroke-dasharray": "4 3" }, svg);
      const lbl = svgEl("text", { x: medianX, y: padT + 12, "text-anchor": "middle", fill: "#ffb547", "font-weight": "700", "font-size": "11" }, svg);
      lbl.textContent = "median " + fmtMoney(medianVal);
    }
  }

  function renderBracketDetail(buckets, ranges, summary) {
    const el = $("#bracketDetail");
    if (state.activeBracket === null) { el.hidden = true; return; }
    const i = state.activeBracket;
    const r = ranges[i];
    const [c, inc] = buckets[i];
    const avg = c > 0 ? inc / c : 0;
    const share = c / Math.max(1, summary.n);
    const incShare = inc / Math.max(1, summary.totalIncome);
    el.hidden = false;
    el.innerHTML = `
      <div class="bd-row"><span class="bd-label">Bracket</span><span class="bd-val">${fmtRange(r)}</span></div>
      <div class="bd-row"><span class="bd-label">People</span><span class="bd-val">${nfInt.format(c)} (${fmtPct(share, 2)})</span></div>
      <div class="bd-row"><span class="bd-label">Total income</span><span class="bd-val">${fmtMoneyExact(inc)} (${fmtPct(incShare, 2)})</span></div>
      <div class="bd-row"><span class="bd-label">Avg in bracket</span><span class="bd-val">${fmtMoneyExact(avg)}</span></div>
    `;
  }

  /* ─── Lorenz curve ─────────────────────────────────────── */
  function drawLorenz(summary) {
    const svg = $("#lorenzChart");
    clear(svg);
    const W = 400, H = 400;
    const pad = 36;
    const innerW = W - 2 * pad;
    const innerH = H - 2 * pad;

    const defs = svgEl("defs", {}, svg);
    const g = svgEl("linearGradient", { id: "lorenzGrad", x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
    svgEl("stop", { offset: "0%", "stop-color": "#7c5cff", "stop-opacity": 0.6 }, g);
    svgEl("stop", { offset: "100%", "stop-color": "#7c5cff", "stop-opacity": 0 }, g);

    svgEl("rect", { x: pad, y: pad, width: innerW, height: innerH, fill: "rgba(255,255,255,0.02)", stroke: "rgba(255,255,255,0.08)", rx: 8 }, svg);

    svgEl("line", {
      class: "equality-line",
      x1: pad, y1: pad + innerH, x2: pad + innerW, y2: pad,
    }, svg);

    const ticks = 4;
    for (let i = 1; i < ticks; i++) {
      const xt = pad + (i / ticks) * innerW;
      const yt = pad + (i / ticks) * innerH;
      svgEl("line", { class: "gridline", x1: pad, x2: pad + innerW, y1: yt, y2: yt }, svg);
      svgEl("line", { class: "gridline", x1: xt, x2: xt, y1: pad, y2: pad + innerH }, svg);
    }
    svgEl("text", { class: "axis-title", x: pad + innerW / 2, y: H - 8, "text-anchor": "middle" }, svg)
      .textContent = "CUMULATIVE % OF PEOPLE →";
    const yLbl = svgEl("text", {
      class: "axis-title", x: -(pad + innerH / 2), y: 14,
      "text-anchor": "middle", transform: "rotate(-90)",
    }, svg);
    yLbl.textContent = "← CUMULATIVE % OF INCOME";

    svgEl("text", { x: pad, y: H - 22, "text-anchor": "middle" }, svg).textContent = "0";
    svgEl("text", { x: pad + innerW, y: H - 22, "text-anchor": "middle" }, svg).textContent = "100%";
    svgEl("text", { x: pad - 8, y: pad + innerH + 4, "text-anchor": "end" }, svg).textContent = "0";
    svgEl("text", { x: pad - 8, y: pad + 4, "text-anchor": "end" }, svg).textContent = "100%";

    const pts = summary.lorenzPts.map(([x, y]) => [pad + x * innerW, pad + innerH - y * innerH]);
    const path = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + "," + p[1].toFixed(1)).join(" ");
    const areaPath = path + ` L${pad + innerW},${pad + innerH} L${pad},${pad + innerH} Z`;
    svgEl("path", { class: "lorenz-area", d: areaPath }, svg);
    svgEl("path", { class: "lorenz-line", d: path }, svg);

    const giniGroup = svgEl("g", {}, svg);
    svgEl("rect", { x: pad + 10, y: pad + 10, width: 110, height: 36, rx: 8, fill: "rgba(124,92,255,0.18)", stroke: "rgba(124,92,255,0.4)" }, giniGroup);
    svgEl("text", { x: pad + 18, y: pad + 24, fill: "#c8b8ff", "font-size": 10, "font-weight": 700 }, giniGroup).textContent = "GINI";
    svgEl("text", { x: pad + 18, y: pad + 40, fill: "#fff", "font-size": 16, "font-weight": 800 }, giniGroup).textContent = summary.gini.toFixed(3);

    const midPt = pts.find((p, i) => summary.lorenzPts[i][0] >= 0.5) || pts[pts.length - 1];
    if (midPt) {
      svgEl("line", { x1: midPt[0], y1: midPt[1], x2: midPt[0], y2: pad + innerH, stroke: "rgba(255,181,71,0.7)", "stroke-dasharray": "3 3" }, svg);
      const halfShare = summary.lorenzPts.find((p) => p[0] >= 0.5);
      if (halfShare) {
        svgEl("text", { x: midPt[0] + 4, y: midPt[1] - 4, fill: "#ffb547", "font-size": 10, "font-weight": 700 }, svg)
          .textContent = `bottom 50% → ${(halfShare[1] * 100).toFixed(1)}% of income`;
      }
    }

    const ls = $("#lorenzStats");
    ls.innerHTML = `
      <div><div class="ls-label">Top 1%</div><div class="ls-val">${fmtPct(summary.top1, 1)}</div></div>
      <div><div class="ls-label">Top 10%</div><div class="ls-val">${fmtPct(summary.top10, 1)}</div></div>
      <div><div class="ls-label">Bottom 50%</div><div class="ls-val">${fmtPct(summary.bot50, 1)}</div></div>
    `;
  }

  /* ─── Trend chart ──────────────────────────────────────── */
  function computeTrendSeries() {
    const series = [];
    for (const y of D.years) {
      const r = findRecord(y, state.month, state.type);
      if (!r) continue;
      const s = summarize(r, D.ranges);
      let val;
      switch (state.trendMetric) {
        case "median": val = s.median; break;
        case "mean": val = s.mean; break;
        case "gini": val = s.gini; break;
        case "people": val = s.n; break;
        case "p90": val = s.p90; break;
      }
      if (val !== null && isFinite(val)) series.push({ y, val });
    }
    return series;
  }

  function drawTrend() {
    const svg = $("#trendChart");
    clear(svg);
    const rect = svg.getBoundingClientRect();
    const W = Math.max(320, Math.round(rect.width || 800));
    const H = Math.max(240, Math.round(rect.height || 320));
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const padL = W < 480 ? 50 : 64, padR = 18, padT = 18, padB = 36;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const defs = svgEl("defs", {}, svg);
    const g = svgEl("linearGradient", { id: "trendGrad", x1: 0, x2: 0, y1: 0, y2: 1 }, defs);
    svgEl("stop", { offset: "0%", "stop-color": "#00e0c6", "stop-opacity": 0.5 }, g);
    svgEl("stop", { offset: "100%", "stop-color": "#00e0c6", "stop-opacity": 0 }, g);

    const series = computeTrendSeries();
    if (series.length === 0) {
      svgEl("text", { x: W / 2, y: H / 2, "text-anchor": "middle", fill: "var(--text-mute)" }, svg).textContent = "No data for this slice";
      return;
    }
    const minV = 0;
    const maxV = Math.max(...series.map((s) => s.val)) * 1.1 || 1;

    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const y = padT + innerH - (i / ticks) * innerH;
      svgEl("line", { class: "gridline", x1: padL, x2: padL + innerW, y1: y, y2: y }, svg);
      const v = (i / ticks) * maxV;
      const lbl = state.trendMetric === "gini" ? v.toFixed(2)
                : state.trendMetric === "people" ? fmtPeople(v)
                : fmtMoney(v);
      svgEl("text", { x: padL - 8, y: y + 4, "text-anchor": "end" }, svg).textContent = lbl;
    }

    const xOf = (i) => series.length === 1 ? padL + innerW / 2 : padL + (i / (series.length - 1)) * innerW;
    const yOf = (v) => padT + innerH - ((v - minV) / (maxV - minV)) * innerH;

    series.forEach((s, i) => {
      svgEl("text", { x: xOf(i), y: padT + innerH + 18, "text-anchor": "middle" }, svg).textContent = s.y;
    });

    if (series.length > 1) {
      const path = series.map((s, i) => (i === 0 ? "M" : "L") + xOf(i).toFixed(1) + "," + yOf(s.val).toFixed(1)).join(" ");
      const area = path + ` L${xOf(series.length - 1).toFixed(1)},${padT + innerH} L${xOf(0).toFixed(1)},${padT + innerH} Z`;
      svgEl("path", { d: area, fill: "url(#trendGrad)" }, svg);
      svgEl("path", { d: path, class: "line", stroke: "#00e0c6" }, svg);
    }

    series.forEach((s, i) => {
      const cx = xOf(i), cy = yOf(s.val);
      const dot = svgEl("circle", { cx, cy, r: 5, class: "dot" }, svg);
      dot.style.fill = "#00e0c6";
      dot.style.stroke = "#0a0c1a";
      dot.style.strokeWidth = "2";
      dot.addEventListener("mousemove", (e) => {
        const lbl = state.trendMetric === "gini" ? s.val.toFixed(3)
                  : state.trendMetric === "people" ? nfInt.format(s.val)
                  : fmtMoneyExact(s.val);
        showTip(`<div><strong>${s.y}</strong></div><div>${lbl}</div>`, e);
      });
      dot.addEventListener("mouseleave", hideTip);
      dot.addEventListener("touchstart", (e) => {
        const lbl = state.trendMetric === "gini" ? s.val.toFixed(3)
                  : state.trendMetric === "people" ? nfInt.format(s.val)
                  : fmtMoneyExact(s.val);
        showTip(`<div><strong>${s.y}</strong></div><div>${lbl}</div>`, e);
      }, { passive: true });
    });

    $("#trendSlice").textContent = state.month + " · " + state.type;
  }

  /* ─── Compare income types YoY (multi-line) ────────────── */
  function metricValue(summary, key) {
    switch (key) {
      case "median": return summary.median;
      case "mean": return summary.mean;
      case "gini": return summary.gini;
      case "people": return summary.n;
      case "p90": return summary.p90;
      case "totalIncome": return summary.totalIncome;
    }
    return null;
  }
  function metricFmt(v, key) {
    if (v == null || !isFinite(v)) return "—";
    if (key === "gini") return v.toFixed(3);
    if (key === "people") return nfInt.format(v);
    if (key === "totalIncome") return fmtMoney(v);
    return fmtMoneyExact(v);
  }

  function buildCompareSeries() {
    const out = [];
    for (const t of state.compareTypes) {
      const pts = [];
      for (const y of D.years) {
        const r = findRecord(y, state.month, t);
        if (!r) continue;
        const s = summarize(r, D.ranges);
        const v = metricValue(s, state.compareMetric);
        if (v !== null && isFinite(v) && (state.compareMetric === "gini" ? s.n > 50 : v > 0)) {
          pts.push({ y, val: v });
        }
      }
      if (pts.length) out.push({ type: t, color: colorFor(t), pts });
    }
    return out;
  }

  function renderTypePills() {
    const root = $("#typePills");
    root.innerHTML = "";
    const available = new Set();
    for (const r of D.records) if (r.m === state.month) available.add(r.t);
    const ordered = D.types.filter((t) => available.has(t));
    for (const t of ordered) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "type-pill" + (state.compareTypes.has(t) ? " active" : "");
      pill.style.color = colorFor(t);
      pill.innerHTML = `<span class="pill-swatch"></span><span>${t}</span>`;
      pill.addEventListener("click", () => {
        if (state.compareTypes.has(t)) state.compareTypes.delete(t);
        else state.compareTypes.add(t);
        renderTypePills();
        drawCompareChart();
      });
      root.appendChild(pill);
    }
  }

  function drawCompareChart() {
    const svg = $("#compareChart");
    clear(svg);
    const empty = $("#compareEmpty");
    $("#compareMonth").textContent = state.month;
    const series = buildCompareSeries();
    if (series.length === 0 || series.every((s) => s.pts.length === 0)) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    const rect = svg.getBoundingClientRect();
    const W = Math.max(320, Math.round(rect.width || 800));
    const H = Math.max(280, Math.round(rect.height || 360));
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    const padL = W < 480 ? 50 : 64, padR = 18, padT = 26, padB = 36;
    const innerW = W - padL - padR;
    const innerH = H - padT - padB;

    const allVals = series.flatMap((s) => s.pts.map((p) => p.val));
    const allYears = [...new Set(series.flatMap((s) => s.pts.map((p) => p.y)))].sort((a, b) => a - b);
    if (allVals.length === 0 || allYears.length === 0) { empty.hidden = false; return; }

    const maxV = Math.max(...allVals) * 1.1 || 1;
    const minV = state.compareMetric === "gini" ? Math.max(0, Math.min(...allVals) - 0.05) : 0;
    const yMin = allYears[0], yMax = allYears[allYears.length - 1];

    const xOf = (y) => yMax === yMin ? padL + innerW / 2 : padL + ((y - yMin) / (yMax - yMin)) * innerW;
    const yOf = (v) => padT + innerH - ((v - minV) / (maxV - minV)) * innerH;

    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const yPos = padT + innerH - (i / ticks) * innerH;
      svgEl("line", { class: "gridline", x1: padL, x2: padL + innerW, y1: yPos, y2: yPos }, svg);
      const v = minV + (i / ticks) * (maxV - minV);
      svgEl("text", { x: padL - 8, y: yPos + 4, "text-anchor": "end" }, svg).textContent = metricFmt(v, state.compareMetric);
    }

    const labelStep = allYears.length > 8 ? 2 : 1;
    allYears.forEach((y, i) => {
      if (i % labelStep !== 0 && i !== allYears.length - 1) return;
      svgEl("text", { x: xOf(y), y: padT + innerH + 18, "text-anchor": "middle" }, svg).textContent = y;
    });

    for (const s of series) {
      if (s.pts.length === 0) continue;
      const path = s.pts.map((p, i) => (i === 0 ? "M" : "L") + xOf(p.y).toFixed(1) + "," + yOf(p.val).toFixed(1)).join(" ");
      svgEl("path", { class: "cmp-line", d: path, stroke: s.color, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      for (const p of s.pts) {
        const cx = xOf(p.y), cy = yOf(p.val);
        const dot = svgEl("circle", { cx, cy, r: 4, class: "cmp-dot", fill: s.color }, svg);
        const showDotTip = (e) => {
          showTip(
            `<div><strong>${s.type}</strong> · ${p.y}</div>` +
            `<div>${metricFmt(p.val, state.compareMetric)}</div>`,
            e
          );
        };
        dot.addEventListener("mousemove", showDotTip);
        dot.addEventListener("mouseleave", hideTip);
        dot.addEventListener("touchstart", showDotTip, { passive: true });
      }
      const last = s.pts[s.pts.length - 1];
      if (xOf(last.y) <= padL + innerW - 70) {
        svgEl("text", {
          x: xOf(last.y) + 6, y: yOf(last.val) + 4,
          fill: s.color, "font-size": 11, "font-weight": 700,
        }, svg).textContent = s.type;
      }
    }
  }

  /* ─── Type breakdown ───────────────────────────────────── */
  function drawTypeBreakdown() {
    const root = $("#typeBreakdown");
    root.innerHTML = "";
    const items = [];
    for (const t of D.types) {
      if (t === "All") continue;
      const r = findRecord(state.year, state.month, t);
      if (!r) continue;
      const tot = totals(r.b);
      if (tot.n === 0) continue;
      items.push({ t, n: tot.n, inc: tot.inc, mean: tot.n ? tot.inc / tot.n : 0 });
    }
    items.sort((a, b) => b.n - a.n);
    if (items.length === 0) {
      root.innerHTML = `<div class="card-sub">No type breakdown for this slice.</div>`;
      return;
    }
    const max = items[0].n;
    for (const it of items) {
      const row = document.createElement("div");
      row.className = "tb-row";
      row.innerHTML = `
        <div class="tb-name" title="${it.t}">${it.t}</div>
        <div class="tb-bar"><div class="tb-fill" style="width:${(it.n / max * 100).toFixed(1)}%"></div></div>
        <div class="tb-val">${fmtPeople(it.n)}</div>
      `;
      row.title = `${it.t}\nPeople: ${nfInt.format(it.n)}\nMean: ${fmtMoneyExact(it.mean)}`;
      root.appendChild(row);
    }
  }

  /* ─── KPIs & 'where do you stand' ──────────────────────── */
  function refreshKPIs(summary) {
    $("#kpiPeople").textContent = fmtPeople(summary.n);
    $("#kpiPeopleSub").textContent = "in " + state.month + " " + state.year;
    $("#kpiMedian").textContent = fmtMoneyExact(summary.median);
    $("#kpiMean").textContent = fmtMoneyExact(summary.mean);
    $("#kpiGini").textContent = summary.gini.toFixed(3);
    $("#kpiTop10").textContent = fmtPct(summary.top10, 1);
    $("#kpiBottom50").textContent = fmtPct(summary.bot50, 1);

    let giniMood;
    if (summary.gini < 0.30) giniMood = "low inequality";
    else if (summary.gini < 0.40) giniMood = "moderate inequality";
    else if (summary.gini < 0.50) giniMood = "high inequality";
    else giniMood = "very high inequality";
    $("#kpiGiniSub").textContent = giniMood;
  }

  function refreshStand(summary, record) {
    const fill = $("#standBarFill");
    const marker = $("#standBarMarker");
    const result = $("#standResult");
    if (!state.standIncome) {
      fill.style.right = "100%";
      marker.classList.remove("visible");
      result.innerHTML = `<span class="stand-pct">—</span><span class="stand-msg">enter an amount</span>`;
      return;
    }
    const pct = rankOf(record.b, D.ranges, state.standIncome);
    if (pct === null) {
      result.innerHTML = `<span class="stand-pct">—</span><span class="stand-msg">no data</span>`;
      return;
    }
    fill.style.right = (100 - pct).toFixed(2) + "%";
    marker.classList.add("visible");
    marker.style.left = pct.toFixed(2) + "%";
    let msg;
    const round = Math.round(pct);
    if (round >= 99) msg = `top ${(100 - pct).toFixed(2)}% — wow`;
    else if (round >= 90) msg = `top ${(100 - pct).toFixed(1)}% earner`;
    else if (round >= 75) msg = `upper quartile`;
    else if (round >= 50) msg = `above the median`;
    else if (round >= 25) msg = `lower-middle bracket`;
    else if (round >= 10) msg = `bottom quartile`;
    else msg = `bottom ${pct.toFixed(1)}%`;
    result.innerHTML = `<span class="stand-pct">p${pct.toFixed(1)}</span><span class="stand-msg">${msg}</span>`;
  }

  /* ─── Insights ─────────────────────────────────────────── */
  function generateInsights(summary) {
    const ul = $("#insights");
    ul.innerHTML = "";
    const tag = (cls, html) => {
      const li = document.createElement("li");
      li.className = cls;
      li.innerHTML = html;
      ul.appendChild(li);
    };

    const prevR = findRecord(state.year - 1, state.month, state.type);
    if (prevR) {
      const prev = summarize(prevR, D.ranges);
      const dMed = (summary.median - prev.median) / Math.max(1, prev.median);
      const dirM = dMed >= 0 ? "up" : "down";
      tag(dirM, `Median <strong>${state.type.toLowerCase()}</strong> is ${dMed >= 0 ? "<strong>up</strong>" : "<strong>down</strong>"} <strong>${(Math.abs(dMed) * 100).toFixed(1)}%</strong> vs ${state.year - 1}, from ${fmtMoneyExact(prev.median)} → ${fmtMoneyExact(summary.median)}.`);
      const dGini = summary.gini - prev.gini;
      const dirG = dGini > 0.005 ? "warn" : dGini < -0.005 ? "up" : "";
      if (Math.abs(dGini) >= 0.005) {
        tag(dirG, `Inequality (Gini) ${dGini > 0 ? "<strong>rose</strong>" : "<strong>fell</strong>"} by <strong>${Math.abs(dGini).toFixed(3)}</strong> compared to last year.`);
      }
    }

    if (summary.median > 0) {
      const ratio = summary.mean / summary.median;
      if (ratio > 1.5) {
        tag("warn", `The mean (<strong>${fmtMoneyExact(summary.mean)}</strong>) is <strong>${ratio.toFixed(2)}×</strong> the median — the distribution is heavily skewed by high earners.`);
      } else if (ratio > 1.2) {
        tag("", `The mean exceeds the median by <strong>${((ratio - 1) * 100).toFixed(0)}%</strong>, indicating a right-skewed income distribution.`);
      }
    }

    if (summary.top10 > 0 && summary.bot50 > 0) {
      const ratio = summary.top10 / summary.bot50;
      tag("", `The <strong>top 10%</strong> earn <strong>${fmtPct(summary.top10, 1)}</strong> of all income — ${ratio.toFixed(1)}× more than what the <strong>bottom half</strong> takes home.`);
    }

    const above5k = summary.n - countBelow(findRecord(state.year, state.month, state.type).b, D.ranges, 5000);
    if (summary.n > 0) {
      const pct = above5k / summary.n;
      tag("", `Only <strong>${fmtPct(pct, 1)}</strong> of people in this slice earn above <strong>₾5,000</strong>.`);
    }

    if (state.type === "Salary") {
      tag("", `Tip: switch <em>Type</em> to <strong>All</strong> to include other income sources like dividends, royalties and lease fees.`);
    }
  }

  function countBelow(buckets, ranges, x) {
    let total = 0;
    for (let i = 0; i < buckets.length; i++) {
      const r = ranges[i];
      const [c] = buckets[i];
      if (r.hi !== null && r.hi <= x) { total += c; continue; }
      if (r.lo >= x) break;
      if (r.hi === null) {
        if (c > 0) {
          const alpha = topBucketAlpha(r.lo, c, buckets[i][1]);
          const frac = 1 - Math.pow(r.lo / x, alpha);
          total += c * Math.max(0, Math.min(1, frac));
        }
      } else {
        const frac = (x - r.lo) / (r.hi - r.lo);
        total += c * Math.max(0, Math.min(1, frac));
      }
    }
    return total;
  }

  /* ─── Filter meta line ─────────────────────────────────── */
  function refreshFilterMeta(summary) {
    const tot = summary;
    $("#filterMeta").textContent = `${state.type} income · ${state.month} ${state.year} · ${fmtPeople(tot.n)} people · ${fmtMoneyExact(tot.totalIncome)} total`;
  }

  /* ─── Table renderers (one per chart) ──────────────────── */
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderHistTable(buckets, ranges, summary) {
    const root = $("#histTable");
    const total = summary.n || 1;
    const totalInc = summary.totalIncome || 1;
    let html = `<table class="data-table"><caption>${state.type} · ${state.month} ${state.year} — ${nfInt.format(summary.n)} people across ${ranges.length} brackets</caption>`;
    html += `<thead><tr><th>Bracket (₾)</th><th>People</th><th>Share</th><th>Avg in bracket</th><th>Total income</th><th>Income share</th></tr></thead><tbody>`;
    for (let i = 0; i < buckets.length; i++) {
      const r = ranges[i];
      const [c, inc] = buckets[i];
      const avg = c > 0 ? inc / c : 0;
      const cls = state.activeBracket === i ? "highlight" : "";
      html += `<tr class="${cls}">`
        + `<td>${escapeHtml(fmtRange(r))}</td>`
        + `<td>${nfInt.format(c)}</td>`
        + `<td>${fmtPct(c / total, 2)}</td>`
        + `<td>${c > 0 ? fmtMoneyExact(avg) : "—"}</td>`
        + `<td>${fmtMoneyExact(inc)}</td>`
        + `<td>${fmtPct(inc / totalInc, 2)}</td>`
        + `</tr>`;
    }
    html += `</tbody></table>`;
    root.innerHTML = html;
  }

  function renderLorenzTable(buckets, ranges, summary) {
    const root = $("#lorenzTable");
    const { n, inc } = totals(buckets);
    let html = `<table class="data-table"><caption>Cumulative population vs cumulative income — Gini = ${summary.gini.toFixed(3)}</caption>`;
    html += `<thead><tr><th>Up to bracket</th><th>People (cum.)</th><th>Cum. % people</th><th>Income (cum.)</th><th>Cum. % income</th></tr></thead><tbody>`;
    let cumP = 0, cumI = 0;
    for (let i = 0; i < buckets.length; i++) {
      const [c, ii] = buckets[i];
      cumP += c; cumI += ii;
      const r = ranges[i];
      const upTo = r.hi === null ? "≥ ₾" + nfInt.format(r.lo) : "< ₾" + nfInt.format(r.hi);
      html += `<tr>`
        + `<td>${escapeHtml(upTo)}</td>`
        + `<td>${nfInt.format(cumP)}</td>`
        + `<td>${n ? fmtPct(cumP / n, 2) : "—"}</td>`
        + `<td>${fmtMoneyExact(cumI)}</td>`
        + `<td>${inc ? fmtPct(cumI / inc, 2) : "—"}</td>`
        + `</tr>`;
    }
    html += `</tbody></table>`;
    root.innerHTML = html;
  }

  function renderTrendTable() {
    const root = $("#trendTable");
    const series = computeTrendSeries();
    if (series.length === 0) { root.innerHTML = `<div class="table-empty">No data for this slice.</div>`; return; }
    const metricLabel = $("#trendMetric").options[$("#trendMetric").selectedIndex].textContent;
    let html = `<table class="data-table"><caption>${metricLabel} of ${state.type} · ${state.month}, year-by-year</caption>`;
    html += `<thead><tr><th>Year</th><th>${escapeHtml(metricLabel)}</th></tr></thead><tbody>`;
    for (const s of series) {
      const lbl = state.trendMetric === "gini" ? s.val.toFixed(3)
                : state.trendMetric === "people" ? nfInt.format(s.val)
                : fmtMoneyExact(s.val);
      html += `<tr><td>${s.y}</td><td>${lbl}</td></tr>`;
    }
    html += `</tbody></table>`;
    root.innerHTML = html;
  }

  function renderCompareTable() {
    const root = $("#compareTable");
    const series = buildCompareSeries();
    if (series.length === 0) { root.innerHTML = `<div class="table-empty">Pick at least one income type above.</div>`; return; }
    const allYears = [...new Set(series.flatMap((s) => s.pts.map((p) => p.y)))].sort((a, b) => a - b);
    const metricLabel = $("#compareMetric").options[$("#compareMetric").selectedIndex].textContent;
    let html = `<table class="data-table"><caption>${metricLabel} for ${state.month}, by income type</caption>`;
    html += `<thead><tr><th>Year</th>`;
    for (const s of series) {
      html += `<th><span class="swatch" style="background:${s.color}"></span>${escapeHtml(s.type)}</th>`;
    }
    html += `</tr></thead><tbody>`;
    for (const y of allYears) {
      html += `<tr><td>${y}</td>`;
      for (const s of series) {
        const p = s.pts.find((q) => q.y === y);
        html += `<td>${p ? metricFmt(p.val, state.compareMetric) : "—"}</td>`;
      }
      html += `</tr>`;
    }
    html += `</tbody></table>`;
    root.innerHTML = html;
  }

  function renderBreakdownTable() {
    const root = $("#breakdownTable");
    const items = [];
    for (const t of D.types) {
      const r = findRecord(state.year, state.month, t);
      if (!r) continue;
      const tot = totals(r.b);
      if (tot.n === 0) continue;
      const s = summarize(r, D.ranges);
      items.push({ t, n: tot.n, inc: tot.inc, mean: tot.n ? tot.inc / tot.n : 0, median: s.median });
    }
    items.sort((a, b) => b.n - a.n);
    if (items.length === 0) {
      root.innerHTML = `<div class="table-empty">No data for this month.</div>`;
      return;
    }
    const totalPeople = items.find((it) => it.t === "All")?.n || items.reduce((sum, it) => sum + (it.t !== "All" ? it.n : 0), 0);
    let html = `<table class="data-table"><caption>${state.month} ${state.year} · all available income types</caption>`;
    html += `<thead><tr><th>Type</th><th>People</th><th>% of "All"</th><th>Median</th><th>Mean</th><th>Total income</th></tr></thead><tbody>`;
    for (const it of items) {
      const swatch = `<span class="swatch" style="background:${colorFor(it.t)}"></span>`;
      const pct = totalPeople ? fmtPct(it.n / totalPeople, 1) : "—";
      html += `<tr>`
        + `<td>${swatch}${escapeHtml(it.t)}</td>`
        + `<td>${nfInt.format(it.n)}</td>`
        + `<td>${pct}</td>`
        + `<td>${fmtMoneyExact(it.median)}</td>`
        + `<td>${fmtMoneyExact(it.mean)}</td>`
        + `<td>${fmtMoney(it.inc)}</td>`
        + `</tr>`;
    }
    html += `</tbody></table>`;
    root.innerHTML = html;
  }

  /* ─── Master render ────────────────────────────────────── */
  function render() {
    refreshFilters();
    const record = findRecord(state.year, state.month, state.type);
    if (!record) {
      console.warn("No record for", state);
      return;
    }
    const summary = summarize(record, D.ranges);
    refreshKPIs(summary);
    refreshFilterMeta(summary);
    drawHistogram(record.b, D.ranges, summary);
    renderBracketDetail(record.b, D.ranges, summary);
    drawLorenz(summary);
    drawTrend();
    renderTypePills();
    drawCompareChart();
    drawTypeBreakdown();
    refreshStand(summary, record);
    generateInsights(summary);
    // Tables — always rebuild so they reflect current slice when toggled.
    renderHistTable(record.b, D.ranges, summary);
    renderLorenzTable(record.b, D.ranges, summary);
    renderTrendTable();
    renderCompareTable();
    renderBreakdownTable();
  }

  /* ─── Wiring ───────────────────────────────────────────── */
  $("#filterYear").addEventListener("change", (e) => { state.year = parseInt(e.target.value, 10); state.activeBracket = null; render(); });
  $("#filterMonth").addEventListener("change", (e) => { state.month = e.target.value; state.activeBracket = null; render(); });
  $("#filterType").addEventListener("change", (e) => { state.type = e.target.value; state.activeBracket = null; render(); });
  $("#trendMetric").addEventListener("change", (e) => { state.trendMetric = e.target.value; drawTrend(); });
  $("#compareMetric").addEventListener("change", (e) => { state.compareMetric = e.target.value; drawCompareChart(); renderCompareTable(); });

  // Trend metric also needs to update its table
  $("#trendMetric").addEventListener("change", () => { renderTrendTable(); });

  // Chart ↔ Table view toggles. Bind directly to each button — more reliable on iOS
  // than delegating through a parent container.
  function setView(card, toggle, btn, view) {
    card.dataset.view = view;
    toggle.querySelectorAll(".vt-btn").forEach((b) => b.classList.toggle("active", b === btn));
    if (view === "chart") {
      const target = toggle.dataset.target;
      const record = findRecord(state.year, state.month, state.type);
      if (!record) return;
      const summary = summarize(record, D.ranges);
      // chart may have rendered with stale dims while container was display:none — redraw.
      if (target === "hist") drawHistogram(record.b, D.ranges, summary);
      else if (target === "lorenz") drawLorenz(summary);
      else if (target === "trend") drawTrend();
      else if (target === "compare") drawCompareChart();
    }
  }

  $$(".vt-btn").forEach((btn) => {
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const toggle = btn.closest(".view-toggle");
      const card = btn.closest(".chartcard");
      if (!toggle || !card) return;
      setView(card, toggle, btn, btn.dataset.view);
    };
    btn.addEventListener("click", handler);
    // Belt-and-braces: also fire on pointerup so iOS can't drop it.
    btn.addEventListener("pointerup", (e) => {
      if (e.pointerType === "touch") handler(e);
    });
  });

  let standDebounce;
  $("#standInput").addEventListener("input", (e) => {
    clearTimeout(standDebounce);
    standDebounce = setTimeout(() => {
      const v = parseFloat(e.target.value);
      state.standIncome = isFinite(v) && v > 0 ? v : null;
      const record = findRecord(state.year, state.month, state.type);
      if (record) refreshStand(summarize(record, D.ranges), record);
    }, 120);
  });

  $("#aboutBtn").addEventListener("click", () => { $("#aboutModal").hidden = false; });
  $("#closeAbout").addEventListener("click", () => { $("#aboutModal").hidden = true; });
  $("#aboutModal").addEventListener("click", (e) => { if (e.target.id === "aboutModal") $("#aboutModal").hidden = true; });

  // Initial render
  render();

  // Resize: re-render charts so sized correctly
  let resizeT;
  window.addEventListener("resize", () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(render, 150);
  });
})();
