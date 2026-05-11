/* Correct vs Wrong trace section: prefix-consistency demo.
   Streams real gpt-oss-20b output (verbatim snippets) line by line.
   Triggers once on first scroll into view, replay button reruns. */

(function () {
  "use strict";

  var SECTION_SEL = "#correct-vs-wrong";
  var DATA_URL = "static/data/correct_vs_wrong.json";

  // Timing constants (milliseconds).
  var TIMING = {
    line_initial_delay: 350,    // before first original line begins
    line_stream_per_char: 14,   // typewriter speed (per char, html-stripped)
    line_pause_between: 220,    // pause between original lines
    after_originals_pause: 500, // pause before in-trace cut animates
    cut_anim: 550,              // dashed cut line + scissors slide-in inside trace
    discard_fade: 450,          // lines below the cut fade + strike-through
    truncate_anim: 600,         // outer "regenerate" divider draw + label
    pre_regen_pause: 250,
    regen_stream_total: 900,    // each regen row takes this long to "settle"
    regen_stagger: 250,         // delay between regen 0/1/2
    after_regens_pause: 350,
    pc_anim_duration: 900
  };

  // Bumped on every runAll call. Pending timers/rAF check it via alive() so
  // that clicking replay mid-animation cleanly cancels the previous run.
  var currentRun = 0;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

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

  // Compute how many "visible" characters an HTML snippet has (strips tags + entities).
  function visibleLength(html) {
    var tmp = document.createElement("div");
    tmp.innerHTML = html;
    return (tmp.textContent || tmp.innerText || "").length;
  }

  // Stream an HTML snippet character-by-character into an element by walking the DOM.
  // Approach: render the full HTML once, then reveal characters using a clip-style trick
  // -- here, we simulate by rebuilding partial HTML up to N visible chars.
  function makePartialHtml(html, visibleChars) {
    // Walk the html, copy structure, but only keep up to `visibleChars` text characters.
    var src = document.createElement("div");
    src.innerHTML = html;
    var dst = document.createElement("div");
    var remaining = { n: visibleChars };

    function walk(node, parent) {
      if (remaining.n <= 0) return false;
      if (node.nodeType === 3) { // text
        var text = node.nodeValue;
        if (text.length <= remaining.n) {
          parent.appendChild(document.createTextNode(text));
          remaining.n -= text.length;
        } else {
          parent.appendChild(document.createTextNode(text.slice(0, remaining.n)));
          remaining.n = 0;
          return false;
        }
        return true;
      }
      if (node.nodeType === 1) {
        var clone = node.cloneNode(false);
        parent.appendChild(clone);
        var children = Array.prototype.slice.call(node.childNodes);
        for (var i = 0; i < children.length; i++) {
          if (!walk(children[i], clone)) return false;
        }
        return true;
      }
      return true;
    }

    var children = Array.prototype.slice.call(src.childNodes);
    for (var i = 0; i < children.length; i++) {
      if (!walk(children[i], dst)) break;
    }
    return dst.innerHTML;
  }

  function streamLine(el, html, perChar, alive) {
    var total = visibleLength(html);
    if (total === 0 || prefersReducedMotion()) {
      if (alive && !alive()) return Promise.resolve();
      el.innerHTML = html;
      el.classList.remove("streaming");
      el.classList.add("done");
      return Promise.resolve();
    }
    el.classList.add("streaming");
    el.innerHTML = "";
    var start = performance.now();
    var duration = total * perChar;
    return new Promise(function (resolve) {
      function step(now) {
        if (alive && !alive()) { resolve(); return; }
        var t = Math.min((now - start) / duration, 1);
        var chars = Math.max(1, Math.round(t * total));
        el.innerHTML = makePartialHtml(html, chars);
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          el.innerHTML = html;
          el.classList.remove("streaming");
          el.classList.add("done");
          resolve();
        }
      }
      requestAnimationFrame(step);
    });
  }

  // ----------------- DOM construction -----------------

  function buildPanel(panelData) {
    var panel = document.createElement("div");
    panel.className = "cvw-panel " + panelData.kind;

    var header = document.createElement("div");
    header.className = "panel-header";
    header.innerHTML = '<span class="panel-label">' + panelData.label + '</span>';
    panel.appendChild(header);

    var traceBox = document.createElement("div");
    traceBox.className = "trace-box original-trace";
    var cutAfter = (typeof panelData.truncate_after_line === "number")
      ? panelData.truncate_after_line
      : panelData.original.lines.length - 1;
    panelData.original.lines.forEach(function (lineHtml, idx) {
      var line = document.createElement("span");
      line.className = "line" + (idx > cutAfter ? " below-cut" : "");
      line.dataset.html = lineHtml;
      line.dataset.idx = String(idx);
      traceBox.appendChild(line);
      // Insert the cut indicator inside the trace box, right after the last
      // line that survives truncation. JS toggles .armed during the animation.
      if (idx === cutAfter) {
        var cut = document.createElement("div");
        cut.className = "cut-line";
        cut.innerHTML =
          '<span class="cut-icon" aria-hidden="true">' +
            '<span class="cut-glyph">&#9986;</span>' +
            '<span class="cut-label">truncate</span>' +
          '</span>';
        traceBox.appendChild(cut);
      }
    });
    panel.appendChild(traceBox);

    var divider = document.createElement("div");
    divider.className = "truncate-divider";
    divider.innerHTML = '<span class="truncate-label">regenerate &times;3</span>';
    panel.appendChild(divider);

    var regens = document.createElement("div");
    regens.className = "regens";
    panelData.regens.forEach(function (r, i) {
      var row = document.createElement("div");
      row.className = "regen-row " + (r.matches_orig ? "match" : "diff");
      row.dataset.idx = String(i);
      row.innerHTML =
        '<span class="regen-tag">regen&nbsp;' + (i + 1) + '</span>' +
        '<span class="regen-content">' + r.line + '</span>';
      regens.appendChild(row);
    });
    panel.appendChild(regens);

    var tally = document.createElement("div");
    tally.className = "pc-tally";
    tally.innerHTML =
      '<span class="pc-label">prefix consistency</span>' +
      '<span class="pc-bar-track"><span class="pc-bar-fill"></span></span>' +
      '<span class="pc-readout">0 / ' + panelData.pc_total + '</span>';
    panel.appendChild(tally);

    return panel;
  }

  // ----------------- Animation orchestration -----------------

  async function runPanelOriginalLines(panel, alive) {
    var lines = $$(".original-trace .line", panel);
    for (var i = 0; i < lines.length; i++) {
      if (alive && !alive()) return;
      await streamLine(lines[i], lines[i].dataset.html, TIMING.line_stream_per_char, alive);
      if (alive && !alive()) return;
      if (i < lines.length - 1) await sleep(TIMING.line_pause_between);
    }
  }

  // Phase between typing and regen: animate the in-trace cut line, then fade
  // the lines below it to mark them as discarded.
  async function runTruncateCut(panel, alive) {
    if (alive && !alive()) return;
    var cut = $(".trace-box .cut-line", panel);
    if (cut) cut.classList.add("armed");
    await sleep(TIMING.cut_anim);
    if (alive && !alive()) return;
    $$(".trace-box .line.below-cut", panel).forEach(function (l) {
      l.classList.add("discarded");
    });
    await sleep(TIMING.discard_fade);
  }

  async function armTruncateDivider(panel, alive) {
    if (alive && !alive()) return;
    var d = $(".truncate-divider", panel);
    d.classList.add("armed");
    await sleep(TIMING.truncate_anim);
  }

  async function runRegens(panel, alive) {
    var rows = $$(".regen-row", panel);
    var promises = rows.map(function (row, idx) {
      return new Promise(function (resolve) {
        setTimeout(function () {
          if (alive && !alive()) { resolve(); return; }
          row.classList.add("visible");
          setTimeout(resolve, TIMING.regen_stream_total);
        }, idx * TIMING.regen_stagger);
      });
    });
    await Promise.all(promises);
  }

  function tallyPanel(panel, match, total, alive) {
    var fill = $(".pc-bar-fill", panel);
    var readout = $(".pc-readout", panel);
    var pct = match / total;
    readout.classList.add("visible");

    if (prefersReducedMotion()) {
      fill.style.width = (pct * 100).toFixed(1) + "%";
      readout.textContent = match + " / " + total;
      return Promise.resolve();
    }

    // Drive the bar width and the readout together via rAF so they stay in sync.
    return new Promise(function (resolve) {
      var start = performance.now();
      var duration = TIMING.pc_anim_duration;
      function step(now) {
        if (alive && !alive()) { resolve(); return; }
        var t = Math.min((now - start) / duration, 1);
        var eased = 1 - Math.pow(1 - t, 3);
        var v = match * eased;
        fill.style.width = (pct * 100 * eased).toFixed(2) + "%";
        readout.textContent = v.toFixed(0) + " / " + total;
        if (t < 1) requestAnimationFrame(step);
        else {
          fill.style.width = (pct * 100).toFixed(2) + "%";
          readout.textContent = match + " / " + total;
          resolve();
        }
      }
      requestAnimationFrame(step);
    });
  }

  function resetPanel(panel) {
    $$(".original-trace .line", panel).forEach(function (l) {
      // Preserve the structural .below-cut marker; only strip transient state.
      var keepBelow = l.classList.contains("below-cut");
      l.className = "line" + (keepBelow ? " below-cut" : "");
      l.innerHTML = "";
    });
    $$(".regen-row", panel).forEach(function (r) {
      r.classList.remove("visible");
    });
    var cut = $(".trace-box .cut-line", panel);
    if (cut) cut.classList.remove("armed");
    $(".truncate-divider", panel).classList.remove("armed");
    $(".pc-bar-fill", panel).style.width = "0%";
    var ro = $(".pc-readout", panel);
    ro.textContent = "0 / " + panel.dataset.total;
    ro.classList.remove("visible");
  }

  async function runAll(panels, panelData) {
    // Take a token; any prior in-flight run sees its alive() flip to false
    // and bails at the next await/rAF/setTimeout boundary.
    var token = ++currentRun;
    function alive() { return token === currentRun; }

    if (prefersReducedMotion()) {
      // Fill in end state instantly.
      panels.forEach(function (p, i) {
        $$(".original-trace .line", p).forEach(function (l) {
          l.classList.add("done");
          l.innerHTML = l.dataset.html;
          if (l.classList.contains("below-cut")) l.classList.add("discarded");
        });
        var cut = $(".trace-box .cut-line", p);
        if (cut) cut.classList.add("armed");
        $(".truncate-divider", p).classList.add("armed");
        $$(".regen-row", p).forEach(function (r) {
          r.classList.add("visible");
        });
        tallyPanel(p, panelData[i].pc_match, panelData[i].pc_total);
      });
      return;
    }

    panels.forEach(resetPanel);
    await sleep(TIMING.line_initial_delay);
    if (!alive()) return;
    // Run originals in parallel across both panels.
    await Promise.all(panels.map(function (p) { return runPanelOriginalLines(p, alive); }));
    if (!alive()) return;
    await sleep(TIMING.after_originals_pause);
    if (!alive()) return;
    await Promise.all(panels.map(function (p) { return runTruncateCut(p, alive); }));
    if (!alive()) return;
    await Promise.all(panels.map(function (p) { return armTruncateDivider(p, alive); }));
    if (!alive()) return;
    await sleep(TIMING.pre_regen_pause);
    if (!alive()) return;
    await Promise.all(panels.map(function (p) { return runRegens(p, alive); }));
    if (!alive()) return;
    await sleep(TIMING.after_regens_pause);
    if (!alive()) return;
    await Promise.all(panels.map(function (p, i) {
      return tallyPanel(p, panelData[i].pc_match, panelData[i].pc_total, alive);
    }));
  }

  // ----------------- Bootstrap -----------------

  async function init() {
    var section = $(SECTION_SEL);
    if (!section) return;

    var resp;
    try {
      resp = await fetch(DATA_URL);
    } catch (e) {
      console.warn("correct_vs_wrong: could not fetch data:", e);
      return;
    }
    if (!resp.ok) return;
    var data = await resp.json();

    var probEl = $(".cvw-problem .problem-text", section);
    if (probEl) {
      probEl.innerHTML = data.problem.prompt_html;
      renderMath(probEl);
    }
    var metaEl = $(".cvw-problem .problem-meta", section);
    if (metaEl) {
      metaEl.innerHTML =
        data.problem.venue + ' &middot; ' + data.problem.problem_id +
        '<span class="gold-pill">gold = ' + data.problem.gold_answer + '</span>';
    }

    var grid = $(".cvw-grid", section);
    grid.innerHTML = "";
    var panelEls = data.panels.map(function (p) {
      var el = buildPanel(p);
      el.dataset.total = String(p.pc_total);
      grid.appendChild(el);
      return el;
    });

    var replay = $(".cvw-replay", section);
    if (replay) {
      replay.addEventListener("click", function () { runAll(panelEls, data.panels); });
    }

    // Trigger once on first scroll into view.
    var fired = false;
    if ("IntersectionObserver" in window && !prefersReducedMotion()) {
      var obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (e.isIntersecting && !fired) {
            fired = true;
            runAll(panelEls, data.panels);
            obs.disconnect();
          }
        });
      }, { threshold: 0.25 });
      obs.observe(section);
    } else {
      runAll(panelEls, data.panels);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
