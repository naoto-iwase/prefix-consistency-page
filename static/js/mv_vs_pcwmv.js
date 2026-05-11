/* MV vs PC-WMV section: PC-WMV beats Standard MV at the per-problem level.
   gpt-oss-20b on HMMT February 2026 #5, N=16 samples, tau=0.75, K=1, prefix_cubic.
   Per sample i:
     - MV: votes_MV[orig_i] += 1
     - PC-WMV: weight per answer is (count_in_group / total)^3, group = orig + regens.
       With K=1: consistent (orig==regen) -> 1.0 for orig, inconsistent -> 0.125 each.
       Displayed scaled by (K+1)^3 = 8, so values are integers (8 vs 1). */

(function () {
  "use strict";

  var SECTION_SEL = "#mv-vs-pcwmv";
  var DATA_URL = "static/data/mv_vs_pcwmv.json";

  // Each sample is rendered as three discrete phases (relative to the start
  // of the step). The viewer first reads orig=X, regen=Y, and only then
  // sees the flyer + bars react accordingly.
  var TIMING = {
    initial_delay: 800,
    step_pair_at: 400,         // orig/regen values appear
    step_bar_at: 1200,         // flyers spawn, bars animate, rows pulse
    step_bar_duration: 900,
    step_end_pause: 300,
    after_stream_pause: 1000,
    pick_reveal: 500,
    skip_step: 80               // ms per pure-other sample (just light its dot)
  };

  // Bumped on every runStreaming call. Pending timers/rAF check it via alive()
  // so that clicking replay mid-animation cancels the previous run cleanly.
  var currentRun = 0;

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function renderMath(el) {
    if (!el || !window.renderMathInElement) return;
    window.renderMathInElement(el, {
      delimiters: [
        { left: "$$", right: "$$", display: true },
        { left: "$",  right: "$",  display: false }
      ],
      throwOnError: false
    });
  }

  // ---- Data shaping ----

  function answerClassMap(classes) {
    var byKey = {};
    classes.forEach(function (c) { byKey[c.key] = c; });
    return byKey;
  }

  function classifyAnswer(ans, classMap) {
    if (ans in classMap) return classMap[ans];
    return classMap["_other"];
  }

  // PC-WMV per-sample weight in display scale (K+1)^3 = 8.
  // Consistent: full weight to orig. Inconsistent: 1 each to orig and regen.
  var PC_FULL = 8;
  var PC_SPLIT = 1;

  // For percentage-based bar rendering, find the visual max per panel
  // (so bars are visible at the right scale). Excludes "_other" since it has no bar.
  function visualMax(tally, classes) {
    var max = 0;
    classes.forEach(function (c) {
      if (c.kind === "other") return;
      if (tally[c.key] > max) max = tally[c.key];
    });
    return max || 1;
  }

  // Count the distinct answers that fell into the "_other" bucket
  // across the orig and regen streams. Returned as { mv: int, pc: int }.
  // mv_only samples contribute only to the MV bucket.
  function countOtherDistinct(samples, classMap) {
    var origOther = new Set();
    var pcOther = new Set();
    samples.forEach(function (s) {
      if (!(s.orig in classMap)) {
        origOther.add(s.orig);
        if (!s.mv_only) pcOther.add(s.orig);
      }
      if (!s.mv_only && s.regen != null && !(s.regen in classMap)) {
        pcOther.add(s.regen);
      }
    });
    return { mv: origOther.size, pc: pcOther.size };
  }

  // ---- DOM build ----

  function buildDots(samples, classMap, container) {
    container.innerHTML = "";
    var dividerInserted = false;
    samples.forEach(function (s, i) {
      // When the first mv_only extra appears, insert a divider with a
      // small label so the cost-equivalence boost reads visually as a
      // separate group.
      if (s.mv_only && !dividerInserted) {
        dividerInserted = true;
        var div = document.createElement("span");
        div.className = "mvpc-dot-divider";
        div.innerHTML = '<span class="divider-label">+ MV cost equivalence</span>';
        container.appendChild(div);
      }
      var cls = classifyAnswer(s.orig, classMap);
      var d = document.createElement("span");
      d.className = "mvpc-dot" +
        (s.consistent ? " consistent" : "") +
        (s.mv_only ? " mv-only" : "");
      d.style.setProperty("--dot-color", cls.color);
      d.dataset.idx = String(i);
      d.dataset.tooltip = "sample " + (i + 1) + ": orig=" + s.orig +
        (s.mv_only ? " (MV only, no regen)" : ", regen=" + (s.regen == null ? "—" : s.regen));
      container.appendChild(d);
    });
  }

  function buildLegend(classes, container) {
    container.innerHTML = "";
    classes.forEach(function (c) {
      var item = document.createElement("span");
      item.className = "mvpc-legend-item";
      item.innerHTML =
        '<span class="mvpc-legend-swatch" style="background:' + c.color + '"></span>' +
        '<span>' + c.label + (c.kind === "gold" ? " (gold)" : "") + '</span>';
      container.appendChild(item);
    });

    // Consistency hint, shown as an actual ringed swatch + label.
    var hint = document.createElement("span");
    hint.className = "mvpc-legend-item mvpc-legend-hint";
    hint.innerHTML =
      '<span class="mvpc-legend-swatch ring"></span>' +
      '<span>consistent <span class="hint-paren">(orig = regen)</span></span>';
    container.appendChild(hint);
  }

  function buildVotePanel(kind, title, classes) {
    var p = document.createElement("div");
    p.className = "vote-panel " + kind;
    p.innerHTML =
      '<div class="vote-panel-header">' +
        '<span class="vote-panel-title">' + title + '</span>' +
        (kind === "mv" ? '' : '<span class="vote-panel-rule">consistent answers are amplified</span>') +
      '</div>' +
      '<div class="vote-rows"></div>' +
      '<div class="vote-residual"></div>' +
      '<div class="vote-pick"></div>';
    var rows = $(".vote-rows", p);
    classes.forEach(function (c) {
      // Skip the "_other" bucket in the chart; it is summarized as text below.
      if (c.kind === "other") return;
      var row = document.createElement("div");
      row.className = "vote-row";
      row.dataset.key = c.key;
      // --row-color drives the bar fill, label color, and answer-tinted pulse.
      row.style.setProperty("--row-color", c.color);
      row.innerHTML =
        '<span class="vote-key">' + c.label + '</span>' +
        '<span class="vote-bar-track"><span class="vote-bar-fill"></span></span>' +
        '<span class="vote-val">0</span>';
      rows.appendChild(row);
    });
    return p;
  }

  // ---- Animation ----

  function setBars(panel, tally, vmax, classes) {
    classes.forEach(function (c) {
      if (c.kind === "other") return;
      var row = panel.querySelector('.vote-row[data-key="' + c.key + '"]');
      if (!row) return;
      var v = tally[c.key];
      var fill = row.querySelector(".vote-bar-fill");
      var val = row.querySelector(".vote-val");
      var pct = vmax > 0 ? (v / vmax) * 100 : 0;
      fill.style.width = pct.toFixed(2) + "%";
      val.textContent = String(Math.round(v));
    });
  }

  function streamSample(samples, i, classMap) {
    // Returns the cumulative tallies after sample i is added.
    var classes = Object.keys(classMap);
    var mv = {}, pc = {};
    classes.forEach(function (k) { mv[k] = 0; pc[k] = 0; });

    for (var j = 0; j <= i; j++) {
      var s = samples[j];
      var oKey = (s.orig in classMap) ? s.orig : "_other";
      var rKey = s.regen != null ? ((s.regen in classMap) ? s.regen : "_other") : null;
      mv[oKey] += 1;
      if (s.mv_only) continue;
      if (rKey === null || s.orig === s.regen) {
        pc[oKey] += PC_FULL;
      } else {
        pc[oKey] += PC_SPLIT;
        pc[rKey] += PC_SPLIT;
      }
    }
    return { mv: mv, pc: pc };
  }

  // True if at least one of orig / regen lands in a NAMED answer class.
  // Pure-other samples are excluded from per-step animation; they tally
  // silently into the "Other" residual.
  function isAnimated(s, classMap) {
    function namedKey(ans) {
      var c = classMap[ans];
      return c && c.kind !== "other";
    }
    if (namedKey(s.orig)) return true;
    if (!s.mv_only && s.regen != null && namedKey(s.regen)) return true;
    return false;
  }

  async function runStreaming(state) {
    // Take a token; any prior in-flight run sees its alive() flip to false
    // and bails at the next await/rAF/setTimeout boundary.
    var token = ++currentRun;
    function alive() { return token === currentRun; }

    var dots = $$(".mvpc-dot", state.section);
    var samples = state.data.samples;
    var classes = state.data.answer_classes;

    // Sweep up any flyers a previous (now cancelled) run spawned. Their own
    // setTimeout cleanup will no-op once parentNode is null.
    Array.prototype.slice.call(document.querySelectorAll(".vote-flyer"))
      .forEach(function (f) { if (f.parentNode) f.parentNode.removeChild(f); });

    setBars(state.mvPanel, zeroTally(classes), 1, classes);
    setBars(state.pcPanel, zeroTally(classes), 1, classes);
    dots.forEach(function (d) { d.classList.remove("lit"); d.classList.remove("active-step"); });
    var divider = state.section.querySelector(".mvpc-dot-divider");
    if (divider) divider.classList.remove("revealed");
    $(".vote-pick", state.mvPanel).classList.remove("shown");
    $(".vote-pick", state.pcPanel).classList.remove("shown");
    $(".vote-pick", state.mvPanel).innerHTML = "";
    $(".vote-pick", state.pcPanel).innerHTML = "";
    $(".vote-residual", state.mvPanel).classList.remove("shown");
    $(".vote-residual", state.pcPanel).classList.remove("shown");
    resetStepper(state);

    if (prefersReducedMotion()) {
      dots.forEach(function (d) { d.classList.add("lit"); });
      var t = streamSample(samples, samples.length - 1, state.classMap);
      setBars(state.mvPanel, t.mv, visualMax(t.mv, classes), classes);
      setBars(state.pcPanel, t.pc, visualMax(t.pc, classes), classes);
      revealResiduals(state);
      revealPicks(state);
      return;
    }

    await sleep(TIMING.initial_delay);
    if (!alive()) return;

    var dividerRevealed = false;
    for (var i = 0; i < samples.length; i++) {
      if (!alive()) return;
      var s = samples[i];
      // Reveal the cost-equivalence divider just before the first mv_only
      // sample is processed so it enters the page with the rest of the group.
      if (s.mv_only && !dividerRevealed) {
        dividerRevealed = true;
        var div = state.section.querySelector(".mvpc-dot-divider");
        if (div) div.classList.add("revealed");
      }
      if (isAnimated(s, state.classMap)) {
        await processStep(state, i, samples, classes, dots, alive);
      } else {
        // Pure-other sample: light the dot quickly without per-step animation.
        dots[i].classList.add("lit");
        await sleep(TIMING.skip_step);
      }
    }
    if (!alive()) return;
    dots.forEach(function (d) { d.classList.remove("active-step"); });
    await sleep(TIMING.after_stream_pause);
    if (!alive()) return;
    revealResiduals(state);
    revealPicks(state);
  }

  // Per-sample step orchestration: dot lights, stepper updates, flyers spawn,
  // bars animate to the cumulative tally that includes sample i.
  async function processStep(state, i, samples, classes, dots, alive) {
    var s = samples[i];
    var oKey = (s.orig in state.classMap) ? s.orig : "_other";
    var rKey = s.regen != null
      ? ((s.regen in state.classMap) ? s.regen : "_other")
      : null;

    // Phase 0 (t=0): dot lights up + active-step indicator; stepper header updates.
    if (alive && !alive()) return;
    dots[i].classList.add("lit");
    dots[i].classList.add("active-step");
    setStepperHeader(state, i + 1, samples.length);

    // Phase 1 (t=step_pair_at): show orig / regen pair.
    await sleep(TIMING.step_pair_at);
    if (alive && !alive()) return;
    setStepperPair(state, s, oKey, rKey);

    // Phase 2 (t=step_bar_at): pulse target rows, fly delta badges, animate bars.
    await sleep(TIMING.step_bar_at - TIMING.step_pair_at);
    if (alive && !alive()) return;

    pulseRow(state.mvPanel, oKey);
    if (!s.mv_only) {
      if (s.regen == null || s.orig === s.regen) {
        pulseRow(state.pcPanel, oKey);
      } else {
        pulseRow(state.pcPanel, oKey);
        if (oKey !== rKey) pulseRow(state.pcPanel, rKey);
      }
    }

    spawnFlyers(state, s, oKey, rKey);

    var tally = streamSample(samples, i, state.classMap);
    // Bar scale tracks the running max at this step, not the final max.
    // This keeps early bars from looking tiny against the final-state ceiling.
    animateBarStep(state.mvPanel, tally.mv, visualMax(tally.mv, classes), classes, TIMING.step_bar_duration, alive);
    animateBarStep(state.pcPanel, tally.pc, visualMax(tally.pc, classes), classes, TIMING.step_bar_duration, alive);

    // Phase 3: wait for bar animation + brief pause before next step.
    await sleep(TIMING.step_bar_duration + TIMING.step_end_pause);
    if (alive && !alive()) return;
    // Drop the active-step indicator here. If we relied on the next iteration
    // to remove it, a pure-other sample in between would leave it stuck on the
    // previous dot.
    dots[i].classList.remove("active-step");
  }

  // ---- Flying delta badges ----

  function spawnFlyers(state, s, oKey, rKey) {
    var pair = $(".step-pair", state.section);
    if (!pair) return;
    var origChip = pair.querySelector('[data-role="orig"]');
    var regenChip = pair.querySelector('[data-role="regen"]');
    if (!origChip) return;

    var oColor = colorOf(state, oKey);
    var rColor = s.regen != null ? colorOf(state, rKey) : oColor;

    // MV always adds +1 to the orig answer.
    flyTo(origChip, state.mvPanel, oKey, oColor, "+1");

    // Cost-equivalence extras (mv_only) don't participate in PC.
    if (s.mv_only) return;

    if (s.regen == null || s.orig === s.regen) {
      // Self-consistent (or no regen): full amplified weight to orig.
      flyTo(origChip, state.pcPanel, oKey, oColor, "+" + PC_FULL);
    } else {
      // Split: small weight to each side. Use orig chip as source for
      // orig-side weight, regen chip as source for regen-side weight.
      flyTo(origChip, state.pcPanel, oKey, oColor, "+" + PC_SPLIT);
      if (regenChip) {
        flyTo(regenChip, state.pcPanel, rKey, rColor, "+" + PC_SPLIT);
      }
    }
  }

  function flyTo(srcEl, panel, key, colorHex, deltaText) {
    if (!srcEl) return;
    var target = panel.querySelector('.vote-row[data-key="' + key + '"]');
    if (!target) {
      // _other or unknown: aim at the residual line as a fallback.
      target = $(".vote-residual", panel) || panel;
    }
    var src = srcEl.getBoundingClientRect();
    var dst = target.getBoundingClientRect();

    var f = document.createElement("span");
    f.className = "vote-flyer";
    f.style.setProperty("--flyer-color", colorHex);
    f.textContent = deltaText;
    f.style.left = src.left + "px";
    f.style.top = src.top + "px";
    document.body.appendChild(f);

    var fr = f.getBoundingClientRect();
    var endX = (dst.left + dst.width * 0.55) - fr.width / 2;
    var endY = (dst.top + dst.height / 2) - fr.height / 2;
    var dx = endX - src.left;
    var dy = endY - src.top;

    f.animate([
      { transform: "translate(0, 0) scale(0.6)", opacity: 0 },
      { transform: "translate(0, 0) scale(1.05)", opacity: 1, offset: 0.18 },
      { transform: "translate(" + dx.toFixed(0) + "px, " + dy.toFixed(0) + "px) scale(0.85)",
        opacity: 0 }
    ], {
      duration: 850,
      easing: "cubic-bezier(0.4, 0, 0.2, 1)",
      fill: "forwards"
    });

    setTimeout(function () {
      if (f.parentNode) f.parentNode.removeChild(f);
    }, 900);
  }

  // ---- Stepper helpers ----

  function resetStepper(state) {
    var st = $(".mvpc-stepper", state.section);
    if (!st) return;
    st.classList.remove("active");
    var counter = $(".step-counter", st);
    var pair = $(".step-pair", st);
    if (counter) counter.textContent = "";
    if (pair) pair.innerHTML = "";
  }

  function setStepperHeader(state, idx, total) {
    var st = $(".mvpc-stepper", state.section);
    if (!st) return;
    st.classList.add("active");
    var counter = $(".step-counter", st);
    var pair = $(".step-pair", st);
    if (counter) counter.textContent = "Sample " + idx + " / " + total;
    if (pair) pair.innerHTML = "";
  }

  function colorOf(state, key) {
    var c = state.classMap[key] || state.classMap["_other"];
    return c ? c.color : "#94a3b8";
  }

  function chip(state, key, label, role) {
    var roleAttr = role ? ' data-role="' + role + '"' : '';
    return '<span class="step-chip"' + roleAttr + ' style="--chip-color:' + colorOf(state, key) + '">' + label + '</span>';
  }

  function setStepperPair(state, s, oKey, rKey) {
    var st = $(".mvpc-stepper", state.section);
    if (!st) return;
    var pair = $(".step-pair", st);
    var origLabel = chip(state, oKey, s.orig, "orig");
    var html = '<span class="step-side">orig = ' + origLabel + '</span>';
    if (s.regen == null) {
      html += '<span class="step-arrow">|</span><span class="step-side step-side-regen">no regen</span>';
    } else {
      var regenLabel = chip(state, rKey, s.regen, "regen");
      html += '<span class="step-arrow">|</span><span class="step-side step-side-regen">regen = ' + regenLabel + '</span>';
      if (s.orig === s.regen) {
        html += '<span class="step-tag step-tag-eq">consistent</span>';
      } else {
        html += '<span class="step-tag step-tag-neq">inconsistent</span>';
      }
    }
    pair.innerHTML = html;
  }

  function pulseRow(panel, key) {
    var row = panel.querySelector('.vote-row[data-key="' + key + '"]');
    if (!row) return;
    row.classList.remove("flashing");
    // Force reflow so re-adding the class restarts the animation.
    void row.offsetWidth;
    row.classList.add("flashing");
  }

  function revealResiduals(state) {
    var mvResidual = $(".vote-residual", state.mvPanel);
    var pcResidual = $(".vote-residual", state.pcPanel);
    mvResidual.innerHTML = state.otherCount.mv > 0
      ? '+ ' + state.otherCount.mv + ' other'
      : '';
    pcResidual.innerHTML = state.otherCount.pc > 0
      ? '+ ' + state.otherCount.pc + ' other'
      : '';
    if (state.otherCount.mv > 0) mvResidual.classList.add("shown");
    if (state.otherCount.pc > 0) pcResidual.classList.add("shown");
  }

  function zeroTally(classes) {
    var t = {};
    classes.forEach(function (c) { t[c.key] = 0; });
    return t;
  }

  function animateBarStep(panel, target, vmax, classes, durationMs, alive) {
    classes.forEach(function (c) {
      if (c.kind === "other") return;
      var row = panel.querySelector('.vote-row[data-key="' + c.key + '"]');
      if (!row) return;
      var fill = row.querySelector(".vote-bar-fill");
      var val = row.querySelector(".vote-val");
      var startV = parseFloat(val.textContent) || 0;
      var endV = target[c.key];
      var startPct = parseFloat(fill.style.width) || 0;
      var endPct = vmax > 0 ? (endV / vmax) * 100 : 0;
      var t0 = performance.now();
      function step(now) {
        if (alive && !alive()) return;
        var t = Math.min((now - t0) / durationMs, 1);
        var eased = 1 - Math.pow(1 - t, 3);
        var v = startV + (endV - startV) * eased;
        var p = startPct + (endPct - startPct) * eased;
        fill.style.width = p.toFixed(2) + "%";
        val.textContent = Math.round(v).toString();
        if (t < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    });
  }

  function revealPicks(state) {
    var w = state.data.winners;
    var mvPick = $(".vote-pick", state.mvPanel);
    var pcPick = $(".vote-pick", state.pcPanel);

    var mvSym = w.mv.is_correct ? "&#10003;" : "&#10007;";
    var pcSym = w.pcwmv.is_correct ? "&#10003;" : "&#10007;";
    var tiedHtml = (w.mv.tied_with && w.mv.tied_with.length)
      ? '<span class="pick-tied">tied with ' + w.mv.tied_with.join(", ") + '</span>'
      : '';
    mvPick.innerHTML =
      '<span class="pick-symbol">' + mvSym + '</span>' +
      '<span>pick: ' + w.mv.answer + '</span>' + tiedHtml;
    pcPick.innerHTML =
      '<span class="pick-symbol">' + pcSym + '</span>' +
      '<span>pick: ' + w.pcwmv.answer + '</span>';
    mvPick.classList.add("shown");
    pcPick.classList.add("shown");
  }

  // ---- Init ----

  async function init() {
    var section = $(SECTION_SEL);
    if (!section) return;

    var resp;
    try { resp = await fetch(DATA_URL); }
    catch (e) { console.warn("mv_vs_pcwmv: fetch failed", e); return; }
    if (!resp.ok) return;
    var data = await resp.json();
    var classes = data.answer_classes;
    var classMap = answerClassMap(classes);

    // Problem header
    var meta = $(".mvpc-problem .problem-meta", section);
    if (meta) {
      meta.innerHTML =
        data.problem.venue + ' &middot; ' + data.problem.problem_id +
        '<span class="gold-pill">gold = ' + data.problem.gold + '</span>';
    }
    var prob = $(".mvpc-problem .problem-text", section);
    if (prob) {
      prob.innerHTML = data.problem.prompt_html;
      renderMath(prob);
    }

    // Dots
    var dotContainer = $(".mvpc-dots", section);
    buildDots(data.samples, classMap, dotContainer);
    var legend = $(".mvpc-legend", section);
    if (legend) buildLegend(classes, legend);

    // Vote panels
    var grid = $(".mvpc-grid", section);
    grid.innerHTML = "";
    var mvPanel = buildVotePanel("mv", "Standard MV", classes);
    var pcPanel = buildVotePanel("pcwmv", "PC-WMV", classes);
    grid.appendChild(mvPanel);
    grid.appendChild(pcPanel);

    var otherCount = countOtherDistinct(data.samples, classMap);

    var state = {
      section: section, data: data, classMap: classMap,
      mvPanel: mvPanel, pcPanel: pcPanel,
      otherCount: otherCount
    };

    var replay = $(".mvpc-replay", section);
    if (replay) replay.addEventListener("click", function () { runStreaming(state); });

    var fired = false;
    if ("IntersectionObserver" in window && !prefersReducedMotion()) {
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting && !fired) {
            fired = true;
            runStreaming(state);
            obs.disconnect();
          }
        });
      }, { threshold: 0.25 });
      obs.observe(section);
    } else {
      runStreaming(state);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
