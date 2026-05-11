/* Cost-accuracy live: reveal-then-explore SVG.
 *
 * Phases:
 *  1. axes + grid fade in
 *  2. curves draw left-to-right (CI bands fade in alongside)
 *  3. dotted target line fades in at alpha=0.99 of the gap
 *  4. vertical envelope-crossings drop, dots pop, token labels appear
 *  5. headline "PC-WMV uses Nx fewer tokens" fades in
 *  6. hover/touch lets the reader drag the target up/down
 */
(function () {
  const root = document.getElementById("cost-accuracy");
  if (!root) return;

  const SVG_NS = "http://www.w3.org/2000/svg";
  const VIEW_W = 880, VIEW_H = 440;
  const M_LEFT = 70, M_RIGHT = 64, M_TOP = 30, M_BOT = 70;
  const PW = VIEW_W - M_LEFT - M_RIGHT;
  const PH = VIEW_H - M_TOP - M_BOT;

  const TIMING = {
    axes_fade: 250,
    curve_draw: 1500,
    curve_stagger: 200,
    after_curves_pause: 250,
    target_drop: 380,
    cross_stagger: 130,
    cross_draw: 520,
    headline_delay: 280,
  };

  // Animation order: PC last so it renders on top.
  const DRAW_ORDER = [
    "standard_mv",
    "deepconf_tail",
    "p_true_raw",
    "ac_sweep",
    "esc_sweep",
    "prefix_cubic",
  ];
  // Legend order: matches paper Fig 1 (HEADLINE_METHOD_KEYS + NATURAL_FAMILIES).
  const LEGEND_ORDER = [
    "prefix_cubic",
    "standard_mv",
    "deepconf_tail",
    "p_true_raw",
    "ac_sweep",
    "esc_sweep",
  ];

  const svg = root.querySelector("svg.ca-svg");
  const subtitle = root.querySelector(".ca-subtitle");
  const legend = root.querySelector(".ca-legend");
  // Three live-updating headline messages, swapped by regime in updateRatio().
  // Faster: both methods reach target -> show ratio.
  // Beyond_mv: only PC-WMV reaches -> qualitative win, no finite ratio.
  // Out: neither reaches -> hovered above PC-WMV's plateau too.
  const REGIME_HTML = {
    faster: 'PC-WMV uses <span id="ca-ratio">21&times;</span> fewer tokens than Standard MV.',
    beyond_mv: "Standard MV cannot reach this. PC-WMV does.",
    out: "Beyond reach for both.",
  };

  let state = null;

  fetch("static/data/cost_accuracy.json")
    .then(r => r.json())
    .then(boot)
    .catch(err => console.error("[cost-accuracy] load failed:", err));

  // ── DOM helpers ──────────────────────────────────────────────────
  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVG_NS, tag);
    if (attrs) for (const k in attrs) {
      if (k === "class") e.setAttribute("class", attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(e);
    return e;
  }
  const g = (parent, cls) => el("g", { "class": cls || "" }, parent);
  const ln = (parent, x1, y1, x2, y2, cls) =>
    el("line", { x1, y1, x2, y2, "class": cls || "" }, parent);
  const rectEl = (parent, x, y, w, h, cls) =>
    el("rect", { x, y, width: w, height: h, "class": cls || "" }, parent);
  const ci = (parent, cx, cy, r, cls) =>
    el("circle", { cx, cy, r, "class": cls || "" }, parent);
  function txt(parent, x, y, content, cls, attrs) {
    const t = el("text", Object.assign({ x, y, "class": cls || "" }, attrs || {}), parent);
    t.textContent = content;
    return t;
  }
  const pathEl = (parent, d, cls) =>
    el("path", { d, "class": cls || "" }, parent);

  // ── Scales ──────────────────────────────────────────────────────
  function xLog(tok, xlim) {
    const lo = Math.log10(xlim[0]), hi = Math.log10(xlim[1]);
    const f = (Math.log10(tok) - lo) / (hi - lo);
    return M_LEFT + f * PW;
  }
  function yLin(accPct, ylim) {
    const f = (accPct - ylim[0]) / (ylim[1] - ylim[0]);
    return M_TOP + (1 - f) * PH;
  }
  function yInvert(y, ylim) {
    const f = (y - M_TOP) / PH;
    return ylim[1] - f * (ylim[1] - ylim[0]);
  }

  // ── Formatters ──────────────────────────────────────────────────
  function fmtTok(t) {
    if (t >= 1e6) {
      const v = t / 1e6;
      return (v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "")) + "M";
    }
    if (t >= 1e3) return (t / 1e3).toFixed(0) + "k";
    return Math.round(t).toString();
  }
  function fmtPct(p) {
    return (p * 100).toFixed(1) + "%";
  }
  function fmtRatio(r) {
    if (r === null || !isFinite(r)) return "—";
    if (r >= 100) return r.toFixed(0) + "×";
    if (r >= 10) return (Math.round(r * 10) / 10).toFixed(1).replace(/\.0$/, "") + "×";
    return r.toFixed(1) + "×";
  }

  // ── Envelope crossing (matches Python _envelope_crossing) ────────
  function buildEnvelope(points) {
    const tok = points.map(p => p[0]);
    const acc = points.map(p => p[1]);
    const env = new Array(acc.length);
    let m = -Infinity;
    for (let i = 0; i < acc.length; i++) {
      if (acc[i] > m) m = acc[i];
      env[i] = m;
    }
    return { tok, env };
  }
  function crossingFromEnv(envObj, target) {
    const { tok, env } = envObj;
    for (let i = 0; i < env.length; i++) {
      if (env[i] >= target) {
        if (i === 0) return tok[0];
        const t1 = tok[i - 1], a1 = env[i - 1];
        const t2 = tok[i], a2 = env[i];
        if (a2 <= a1) return t2;
        const frac = (target - a1) / (a2 - a1);
        return Math.exp(Math.log(t1) + frac * (Math.log(t2) - Math.log(t1)));
      }
    }
    return null;
  }

  // ── Build SVG once ──────────────────────────────────────────────
  function boot(data) {
    subtitle.textContent = data.model_label + " / " + data.benchmark_label;
    state = buildSvg(data);
    buildLegend(data);

    const io = new IntersectionObserver((entries, obs) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          obs.disconnect();
          play();
        }
      });
    }, { threshold: 0.3 });
    io.observe(root);

    svg.addEventListener("mousemove", onPointer);
    svg.addEventListener("mouseleave", onLeave);
    svg.addEventListener("touchstart", onPointer, { passive: false });
    svg.addEventListener("touchmove", onPointer, { passive: false });
  }

  function buildSvg(data) {
    const xlim = data.xlim;
    const ylim = data.ylim_pct;
    const passAt1 = data.pass_at_1;
    const headlineAlpha = data.headline_alpha_default;

    const mvMethod = data.methods.find(m => m.key === "standard_mv");
    const mvPlateau = mvMethod.points[mvMethod.points.length - 1][1];
    const targetDefault = passAt1 + headlineAlpha * (mvPlateau - passAt1);

    svg.innerHTML = "";

    // ClipPath so curve segments past the axes don't draw outside the plot.
    const defs = el("defs", null, svg);
    const clip = el("clipPath", { id: "ca-plot-clip" }, defs);
    el("rect", { x: M_LEFT, y: M_TOP, width: PW, height: PH }, clip);

    // Grid (minor + major) and axes
    const gridG = g(svg, "ca-grid");
    const axesG = g(svg, "ca-axes");

    const majorX = [];
    for (let p = Math.ceil(Math.log10(xlim[0])); p <= Math.floor(Math.log10(xlim[1])); p++) {
      majorX.push(Math.pow(10, p));
    }
    const minorX = [];
    for (let p = Math.floor(Math.log10(xlim[0])) - 1; p <= Math.ceil(Math.log10(xlim[1])); p++) {
      for (let m = 2; m <= 9; m++) {
        const v = m * Math.pow(10, p);
        if (v >= xlim[0] && v <= xlim[1]) minorX.push(v);
      }
    }
    const yTickStart = Math.ceil(ylim[0] / 2) * 2;
    const yTicks = [];
    for (let v = yTickStart; v <= ylim[1] + 1e-9; v += 2) yTicks.push(v);

    minorX.forEach(v => {
      const x = xLog(v, xlim);
      ln(gridG, x, M_TOP, x, M_TOP + PH, "ca-grid-line minor");
    });
    majorX.forEach(v => {
      const x = xLog(v, xlim);
      ln(gridG, x, M_TOP, x, M_TOP + PH, "ca-grid-line");
    });
    yTicks.forEach(v => {
      const y = yLin(v, ylim);
      ln(gridG, M_LEFT, y, M_LEFT + PW, y, "ca-grid-line");
    });

    ln(axesG, M_LEFT, M_TOP + PH, M_LEFT + PW, M_TOP + PH, "ca-axis-line");
    ln(axesG, M_LEFT, M_TOP, M_LEFT, M_TOP + PH, "ca-axis-line");

    majorX.forEach(v => {
      const x = xLog(v, xlim);
      txt(axesG, x, M_TOP + PH + 16, fmtTok(v), "ca-tick-label", { "text-anchor": "middle" });
    });
    txt(axesG, M_LEFT + PW / 2, M_TOP + PH + 42, "Tokens per problem (log scale)",
        "ca-axis-label", { "text-anchor": "middle" });

    yTicks.forEach(v => {
      const y = yLin(v, ylim);
      txt(axesG, M_LEFT - 8, y + 4, v + "%", "ca-tick-label", { "text-anchor": "end" });
    });
    const yLabelX = M_LEFT - 46;
    const yLabelY = M_TOP + PH / 2;
    txt(axesG, yLabelX, yLabelY, "Accuracy", "ca-axis-label",
        { "text-anchor": "middle",
          "transform": `rotate(-90 ${yLabelX} ${yLabelY})` });

    gridG.style.opacity = "0";
    axesG.style.opacity = "0";
    gridG.style.transition = `opacity ${TIMING.axes_fade}ms ease`;
    axesG.style.transition = `opacity ${TIMING.axes_fade}ms ease`;

    // Layered groups so PC draws on top.
    // Data layers are clipped to the plot rect so segments outside the
    // axes (e.g. token < xlim[0] or acc < ylim[0]) don't bleed over.
    const bandsG = g(svg, "ca-bands");
    const linesG = g(svg, "ca-lines");
    const markersG = g(svg, "ca-markers");
    const pcG = g(svg, "ca-pc-line");
    [bandsG, linesG, markersG, pcG].forEach(node =>
      node.setAttribute("clip-path", "url(#ca-plot-clip)"));
    const targetG = g(svg, "ca-target");
    const crossingsG = g(svg, "ca-crossings");

    // Curves
    const curves = {};
    let orderIdx = 0;
    DRAW_ORDER.forEach(key => {
      const method = data.methods.find(m => m.key === key);
      if (!method) return;
      const delay = orderIdx * TIMING.curve_stagger;
      orderIdx++;

      if (method.kind === "line") {
        const pts = method.points;
        const lineD = pts.map((p, i) => {
          const x = xLog(p[0], xlim);
          const y = yLin(p[1] * 100, ylim);
          return (i === 0 ? "M" : "L") + " " + x.toFixed(2) + " " + y.toFixed(2);
        }).join(" ");

        const bandPts = [];
        for (let i = 0; i < pts.length; i++) {
          const p = pts[i];
          bandPts.push([xLog(p[0], xlim), yLin((p[1] + p[2]) * 100, ylim)]);
        }
        for (let i = pts.length - 1; i >= 0; i--) {
          const p = pts[i];
          bandPts.push([xLog(p[0], xlim), yLin((p[1] - p[2]) * 100, ylim)]);
        }
        const bandD = bandPts.map((q, i) =>
          (i === 0 ? "M" : "L") + " " + q[0].toFixed(2) + " " + q[1].toFixed(2)
        ).join(" ") + " Z";

        const targetGroup = key === "prefix_cubic" ? pcG : linesG;
        const bandPath = pathEl(bandsG, bandD, "ca-band");
        bandPath.style.fill = method.color;
        const linePath = pathEl(targetGroup, lineD, "ca-curve");
        linePath.style.stroke = method.color;
        if (key === "prefix_cubic") linePath.style.strokeWidth = "2.4";

        const totalLen = linePath.getTotalLength();
        linePath.style.strokeDasharray = String(totalLen);
        linePath.style.strokeDashoffset = String(totalLen);

        curves[key] = {
          method, kind: "line", lineEl: linePath, bandEl: bandPath,
          totalLen, delay, envelope: buildEnvelope(pts),
        };
      } else if (method.kind === "errorbar") {
        const grp = g(markersG, "ca-marker-group");
        const pts = method.points;
        pts.forEach(p => {
          const x = xLog(p[0], xlim);
          const y = yLin(p[1] * 100, ylim);
          const yU = yLin((p[1] + p[2]) * 100, ylim);
          const yL = yLin((p[1] - p[2]) * 100, ylim);
          const xL = xLog(Math.max(p[0] - p[3], xlim[0] / 2), xlim);
          const xR = xLog(Math.min(p[0] + p[3], xlim[1] * 2), xlim);
          ln(grp, x, yU, x, yL, "ca-marker-err");
          ln(grp, x - 2.5, yU, x + 2.5, yU, "ca-marker-err");
          ln(grp, x - 2.5, yL, x + 2.5, yL, "ca-marker-err");
          ln(grp, xL, y, xR, y, "ca-marker-err");
          ln(grp, xL, y - 2.5, xL, y + 2.5, "ca-marker-err");
          ln(grp, xR, y - 2.5, xR, y + 2.5, "ca-marker-err");
          const dot = ci(grp, x, y, 3.2, "ca-marker-dot");
          dot.style.fill = method.color;
        });
        const envPts = pts.map(p => [p[0], p[1]]);
        curves[key] = {
          method, kind: "errorbar", group: grp, delay,
          envelope: buildEnvelope(envPts),
        };
      }
    });

    // Target line, handle (right side), and readout next to the handle
    const yT0 = yLin(targetDefault * 100, ylim);
    const targetLine = ln(targetG, M_LEFT, yT0, M_LEFT + PW, yT0, "ca-target-line");
    const targetHandle = rectEl(targetG, M_LEFT + PW + 1, yT0 - 6, 12, 12, "ca-target-handle");
    targetHandle.setAttribute("rx", "3"); targetHandle.setAttribute("ry", "3");
    const targetHandleGlyph = txt(targetG, M_LEFT + PW + 7, yT0 + 3,
        "⇵", "ca-target-handle-glyph", { "text-anchor": "middle" });
    const targetReadout = txt(targetG, M_LEFT + PW + 18, yT0 + 4,
        fmtPct(targetDefault), "ca-target-readout", { "text-anchor": "start" });

    return {
      data, xlim, ylim, passAt1, mvPlateau, targetDefault,
      gridG, axesG, bandsG, linesG, markersG, pcG, targetG, crossingsG,
      targetLine, targetReadout, targetHandle, targetHandleGlyph,
      curves, currentTarget: targetDefault, animating: false,
      lastRegime: "faster",
      // PC-cubic envelope max: hover above this hits the "out" regime
      // ("Beyond reach for both"), which is a dead end. Cap hover here so
      // the line snaps to PC's ceiling instead of floating uselessly above.
      pcMaxAcc: (() => {
        const env = curves.prefix_cubic.envelope.env;
        return env[env.length - 1];
      })(),
    };
  }

  function buildLegend(data) {
    legend.innerHTML = "";
    LEGEND_ORDER.forEach(key => {
      const m = data.methods.find(mm => mm.key === key);
      if (!m) return;
      const item = document.createElement("span");
      item.className = "ca-legend-item";
      const sw = document.createElement("span");
      sw.className = "ca-legend-swatch" + (m.kind === "errorbar" ? " marker" : "");
      if (m.kind === "errorbar") {
        sw.style.background = m.color;
        sw.style.color = m.color;
      } else {
        sw.style.background = m.color;
      }
      const name = document.createElement("span");
      name.className = "ca-legend-name";
      name.textContent = m.display;
      const cite = document.createElement("span");
      cite.className = "ca-legend-cite";
      cite.textContent = m.cite || "";
      item.appendChild(sw);
      item.appendChild(name);
      if (m.cite) item.appendChild(cite);
      legend.appendChild(item);
    });
  }

  // ── Animation ────────────────────────────────────────────────────
  function play() {
    if (!state) return;
    state.animating = true;

    state.gridG.style.opacity = "1";
    state.axesG.style.opacity = "1";

    setTimeout(() => {
      Object.values(state.curves).forEach(c => {
        if (c.kind === "line") {
          c.bandEl.classList.add("visible");
          c.lineEl.style.transition =
            `stroke-dashoffset ${TIMING.curve_draw}ms ease-out ${c.delay}ms`;
          void c.lineEl.getBoundingClientRect();
          c.lineEl.style.strokeDashoffset = "0";
        } else if (c.kind === "errorbar") {
          c.group.style.transitionDelay = `${c.delay}ms`;
          c.group.classList.add("visible");
        }
      });
    }, TIMING.axes_fade);

    const tCurves = TIMING.axes_fade
      + (DRAW_ORDER.length - 1) * TIMING.curve_stagger
      + TIMING.curve_draw;

    setTimeout(() => {
      state.targetLine.classList.add("visible");
      state.targetReadout.classList.add("visible");
      state.targetHandle.classList.add("visible");
      state.targetHandleGlyph.classList.add("visible");
      drawCrossings(state.currentTarget, /*animate*/ true);
    }, tCurves + TIMING.after_curves_pause);

    const tHeadline = tCurves
      + TIMING.after_curves_pause
      + TIMING.target_drop
      + (Object.keys(state.curves).length * TIMING.cross_stagger)
      + TIMING.cross_draw
      + TIMING.headline_delay;

    setTimeout(() => {
      state.animating = false;
    }, tHeadline);
  }

  function setTargetGeometry(target) {
    const y = yLin(target * 100, state.ylim);
    state.targetLine.setAttribute("y1", y);
    state.targetLine.setAttribute("y2", y);
    state.targetReadout.setAttribute("y", y + 4);
    state.targetReadout.textContent = fmtPct(target);
    state.targetHandle.setAttribute("y", y - 6);
    state.targetHandleGlyph.setAttribute("y", y + 3);
  }

  // ── Crossings ────────────────────────────────────────────────────
  function drawCrossings(target, animate) {
    state.crossingsG.innerHTML = "";

    const yTarget = yLin(target * 100, state.ylim);
    const yBottom = M_TOP + PH;

    const crossings = [];
    Object.entries(state.curves).forEach(([key, c]) => {
      const tok = crossingFromEnv(c.envelope, target);
      if (tok === null) return;
      if (tok < state.xlim[0] * 0.999 || tok > state.xlim[1] * 1.001) return;
      const x = Math.max(M_LEFT, Math.min(M_LEFT + PW, xLog(tok, state.xlim)));
      crossings.push({ key, color: c.method.color, tok, x });
    });
    crossings.sort((a, b) => a.tok - b.tok);

    const labels = crossings.map(c => fmtTok(c.tok));
    const labelHWs = labels.map(t => Math.max(t.length * 6 + 8, 18) / 2);
    const PAD = -3;
    const ROW_H = 14;
    const BASE_DY = 5;
    const placed = [];
    const slots = [];
    crossings.forEach((c, i) => {
      const cx = c.x, hw = labelHWs[i];
      let slot = 0;
      while (placed.some(p => p.slot === slot
            && Math.abs(cx - p.cx) < (hw + p.hw + PAD))) {
        slot++;
      }
      placed.push({ slot, cx, hw });
      slots.push(slot);
    });

    function slotOffset(slot) {
      const row = Math.floor(slot / 2);
      const above = (slot % 2 === 0);
      const dy = (BASE_DY + row * ROW_H) * (above ? -1 : 1);
      return { dy, above };
    }

    crossings.forEach((c, i) => {
      const lineEl = ln(state.crossingsG, c.x, yTarget, c.x,
          animate ? yTarget : yBottom, "ca-cross-line");
      lineEl.style.stroke = c.color;
      const dot = ci(state.crossingsG, c.x, yTarget,
          animate ? 0 : 3.2, "ca-cross-dot");
      dot.style.fill = c.color;

      const off = slotOffset(slots[i]);
      const labelY = yTarget + off.dy + (off.above ? -2 : 10);
      const hw = labelHWs[i];
      const bg = rectEl(state.crossingsG,
          c.x - hw, labelY - 11, hw * 2, 14, "ca-cross-label-bg");
      const tEl = txt(state.crossingsG, c.x, labelY,
          labels[i], "ca-cross-label", { "text-anchor": "middle" });
      tEl.style.fill = c.color;

      if (animate) {
        bg.style.opacity = "0";
        tEl.style.opacity = "0";
        const delay = i * TIMING.cross_stagger;
        animY(lineEl, "y2", yTarget, yBottom, TIMING.cross_draw, delay);
        animY(dot, "r", 0, 3.2, TIMING.cross_draw * 0.7, delay + 80);
        setTimeout(() => {
          bg.style.transition = "opacity 250ms ease";
          tEl.style.transition = "opacity 250ms ease";
          bg.style.opacity = "1";
          tEl.style.opacity = "1";
        }, delay + 220);
      }
    });

    updateRatio(target);
  }

  function animY(elt, attr, from, to, durMs, delayMs) {
    setTimeout(() => {
      const t0 = performance.now();
      function step(now) {
        const t = Math.min(1, (now - t0) / durMs);
        const e = 1 - Math.pow(1 - t, 3); // easeOutCubic
        const v = from + (to - from) * e;
        elt.setAttribute(attr, attr === "r" ? v.toFixed(2) : v.toFixed(2));
        if (t < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }, delayMs);
  }

  function updateRatio(target) {
    const mvCross = crossingFromEnv(state.curves.standard_mv.envelope, target);
    const pcCross = crossingFromEnv(state.curves.prefix_cubic.envelope, target);

    let regime;
    if (mvCross !== null && pcCross !== null) regime = "faster";
    else if (pcCross !== null) regime = "beyond_mv";
    else regime = "out";

    if (regime !== state.lastRegime) {
      const msgEl = document.getElementById("ca-msg");
      if (msgEl) msgEl.innerHTML = REGIME_HTML[regime];
      state.lastRegime = regime;
    }
    if (regime === "faster") {
      const ratioEl = document.getElementById("ca-ratio");
      if (ratioEl) ratioEl.textContent = fmtRatio(mvCross / pcCross);
    }
  }

  // ── Pointer interaction ────────────────────────────────────────
  function pointerY(evt) {
    const rect = svg.getBoundingClientRect();
    const ev = (evt.touches && evt.touches[0]) ? evt.touches[0] : evt;
    const localY = (ev.clientY - rect.top) * (VIEW_H / rect.height);
    return localY;
  }

  function onPointer(evt) {
    if (!state || state.animating) return;
    if (evt.cancelable && evt.type.startsWith("touch")) evt.preventDefault();
    const yPx = pointerY(evt);
    if (yPx < M_TOP || yPx > M_TOP + PH) return;
    let target = yInvert(yPx, state.ylim) / 100;
    if (target > state.pcMaxAcc) target = state.pcMaxAcc;
    state.currentTarget = target;
    setTargetGeometry(target);
    drawCrossings(target, /*animate*/ false);
  }

  function onLeave() {
    if (!state || state.animating) return;
    state.currentTarget = state.targetDefault;
    setTargetGeometry(state.targetDefault);
    drawCrossings(state.targetDefault, /*animate*/ false);
  }
})();
