import React, { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

/* -------------------------------------------------------
   Scenario policies (simple scoring + PASS/WARN/FAIL)
------------------------------------------------------- */
const SCENARIOS = {
  warehouse: {
    key: "warehouse",
    name: "Warehouse robot",
    blurb:
      "Strict indoor policy: tight aisles, low tolerance for near-collisions and deadlocks.",
    weights: { near: 3, collision: 8, stuck: 6, replan: 1 },
    thresholds: { pass: 6, warn: 14 } // score <= pass => PASS, <= warn => WARN, else FAIL
  },
  delivery: {
    key: "delivery",
    name: "Delivery bot (ground)",
    blurb:
      "Moderate policy: sidewalks + obstacles; some pauses are okay, but repeated issues are not.",
    weights: { near: 2, collision: 6, stuck: 4, replan: 1 },
    thresholds: { pass: 8, warn: 18 }
  },
  sar: {
    key: "sar",
    name: "Search & rescue",
    blurb:
      "Lenient collision policy, but deadlocks matter: complex terrain; recovery is critical.",
    weights: { near: 1, collision: 3, stuck: 7, replan: 1 },
    thresholds: { pass: 10, warn: 22 }
  }
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function statusColor(status) {
  if (status === "PASS") return "rgba(34,197,94,0.9)";
  if (status === "WARN") return "rgba(234,179,8,0.9)";
  if (status === "FAIL") return "rgba(239,68,68,0.9)";
  return "rgba(255,255,255,0.25)";
}

function fmtDelta(n, suffix = "") {
  if (n == null || Number.isNaN(n)) return "—";
  const sign = n > 0 ? "+" : "";
  const val = Math.round(n * 10) / 10;
  return `${sign}${val}${suffix}`;
}

/* -------------------------------------------------------
   Run parsing helpers
------------------------------------------------------- */
function extractXY(frame) {
  if (!frame) return null;
  if (typeof frame.x === "number" && typeof frame.y === "number") return { x: frame.x, y: frame.y };
  if (frame.pos && typeof frame.pos.x === "number" && typeof frame.pos.y === "number")
    return { x: frame.pos.x, y: frame.pos.y };
  if (Array.isArray(frame.p) && frame.p.length >= 2 && typeof frame.p[0] === "number")
    return { x: frame.p[0], y: frame.p[1] };
  return null;
}

function runTimeMax(run) {
  const frames = Array.isArray(run?.frames) ? run.frames : [];
  if (!frames.length) return 0;
  const lastT = Number(frames[frames.length - 1]?.t);
  return Number.isFinite(lastT) ? lastT : 0;
}

function countEvents(run) {
  const events = Array.isArray(run?.events) ? run.events : [];
  const c = { near: 0, collision: 0, stuck: 0, replan: 0 };
  for (const e of events) {
    const type = String(e?.type || "");
    if (type === "near_collision") c.near++;
    if (type === "collision") c.collision++;
    if (type === "stuck") c.stuck++;
    if (type === "replan") c.replan++;
  }
  return c;
}

function scoreRun(run, scenarioKey) {
  const sc = SCENARIOS[scenarioKey] || SCENARIOS.warehouse;
  const c = countEvents(run);
  const w = sc.weights;
  const score = c.near * w.near + c.collision * w.collision + c.stuck * w.stuck + c.replan * w.replan;
  const status =
    score <= sc.thresholds.pass ? "PASS" : score <= sc.thresholds.warn ? "WARN" : "FAIL";
  return { score, status, blurb: sc.blurb, counts: c };
}

/* -------------------------------------------------------
   LLM input summary (lightweight; keeps payload small)
------------------------------------------------------- */
function buildRunSummary(run) {
  const frames = Array.isArray(run?.frames) ? run.frames : [];
  const events = Array.isArray(run?.events) ? run.events : [];
  const stats = run?.stats || {};

  const duration_s =
    stats.duration_s ??
    (frames.length ? Number(frames[frames.length - 1]?.t) : 0);

  const distance_m = stats.distance_m ?? null;

  const counts = {
    near_collision:
      stats.near_collision_count ?? events.filter((e) => e.type === "near_collision").length,
    collision:
      stats.collision_count ?? events.filter((e) => e.type === "collision").length,
    stuck: stats.stuck_count ?? events.filter((e) => e.type === "stuck").length,
    replan: stats.replan_count ?? events.filter((e) => e.type === "replan").length
  };

  const evidence = events
    .map((e) => ({
      t: Number(e.t),
      type: String(e.type || ""),
      detail: String(e.detail || "")
    }))
    .filter((e) => Number.isFinite(e.t) && e.type)
    .sort((a, b) => a.t - b.t);

  const events_evidence = evidence.length <= 24 ? evidence : evidence.slice(0, 12).concat(evidence.slice(-12));

  return {
    duration_s: Number(duration_s) || 0,
    distance_m: distance_m != null ? Number(distance_m) : null,
    counts,
    events_evidence,
    meta: {
      frame_count: frames.length,
      event_count: events.length
    }
  };
}

/* -------------------------------------------------------
   Canvas drawing
------------------------------------------------------- */
function computeBounds(frames) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const f of frames) {
    const p = extractXY(f);
    if (!p) continue;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const pad = 0.5;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function drawGrid(ctx, w, h) {
  ctx.save();
  ctx.clearRect(0, 0, w, h);

  // grid
  ctx.globalAlpha = 0.25;
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  const step = 40;
  for (let x = 0; x <= w; x += step) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y += step) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(w, y + 0.5);
    ctx.stroke();
  }

  // border
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  ctx.restore();
}

function drawPath(ctx, frames, tMax, toCanvas, style) {
  const pts = [];
  for (const f of frames) {
    const tf = Number(f?.t);
    if (!Number.isFinite(tf)) continue;
    if (tf > tMax) break;
    const p = extractXY(f);
    if (!p) continue;
    pts.push(p);
  }
  if (!pts.length) return null;

  ctx.save();
  ctx.lineWidth = style.lineWidth || 2;
  ctx.strokeStyle = style.strokeStyle || "rgba(255,255,255,0.85)";
  ctx.globalAlpha = style.alpha ?? 1;

  ctx.beginPath();
  const p0 = toCanvas(pts[0]);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < pts.length; i++) {
    const pi = toCanvas(pts[i]);
    ctx.lineTo(pi.x, pi.y);
  }
  ctx.stroke();
  ctx.restore();

  return pts[pts.length - 1];
}

function drawDot(ctx, p, toCanvas, style) {
  if (!p) return;
  const c = toCanvas(p);
  ctx.save();
  ctx.fillStyle = style.fillStyle || "rgba(255,255,255,0.9)";
  ctx.strokeStyle = style.strokeStyle || "rgba(0,0,0,0.35)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(c.x, c.y, style.r || 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

export default function App() {
  const canvasRef = useRef(null);

  const [index, setIndex] = useState(null);

  const [runId, setRunId] = useState("sample_run");
  const [compareRunId, setCompareRunId] = useState("");

  const [run, setRun] = useState(null);
  const [compareRun, setCompareRun] = useState(null);

  const [scenarioKey, setScenarioKey] = useState("warehouse");

  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const [diagText, setDiagText] = useState("");

  // Load runs index
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const resp = await fetch(`/runs/index.json`);
        const data = await resp.json();
        if (!dead) setIndex(data);
      } catch {
        if (!dead) setIndex({ runs: [] });
      }
    })();
    return () => {
      dead = true;
    };
  }, []);

  // Load selected run
  useEffect(() => {
    let dead = false;
    (async () => {
      if (!index?.runs?.length) return;
      const item = index.runs.find((r) => r.id === runId) || index.runs[0];
      if (!item) return;
      try {
        const resp = await fetch(`/runs/${item.file}`);
        const data = await resp.json();
        if (!dead) {
          setRun(data);
          setT(0);
          setPlaying(false);
        }
      } catch {
        if (!dead) setRun(null);
      }
    })();
    return () => {
      dead = true;
    };
  }, [index, runId]);

  // Load compare run
  useEffect(() => {
    let dead = false;
    (async () => {
      if (!compareRunId) {
        setCompareRun(null);
        return;
      }
      const item = index?.runs?.find((r) => r.id === compareRunId);
      if (!item) {
        setCompareRun(null);
        return;
      }
      try {
        const resp = await fetch(`/runs/${item.file}`);
        const data = await resp.json();
        if (!dead) setCompareRun(data);
      } catch {
        if (!dead) setCompareRun(null);
      }
    })();
    return () => {
      dead = true;
    };
  }, [index, compareRunId]);

  const maxT = useMemo(() => runTimeMax(run), [run]);
  const sliderSteps = useMemo(() => Math.max(1, Math.round(maxT * 10)), [maxT]);
  const sliderValue = useMemo(() => Math.round(t * 10), [t]);

  // Scenario eval + deltas
  const primary = useMemo(() => (run ? scoreRun(run, scenarioKey) : null), [run, scenarioKey]);
  const compare = useMemo(
    () => (compareRun ? scoreRun(compareRun, scenarioKey) : null),
    [compareRun, scenarioKey]
  );

  const deltas = useMemo(() => {
    if (!primary || !compare) return null;
    const a = primary.counts;
    const b = compare.counts;
    const durA = runTimeMax(run);
    const durB = runTimeMax(compareRun);

    return {
      score: compare.score - primary.score,
      near: b.near - a.near,
      stuck: b.stuck - a.stuck,
      collision: b.collision - a.collision,
      duration: (durB || 0) - (durA || 0),
      distance: (compareRun?.stats?.distance_m ?? null) != null && (run?.stats?.distance_m ?? null) != null
        ? Number(compareRun.stats.distance_m) - Number(run.stats.distance_m)
        : null,
      better: compare.score < primary.score,
      equal: compare.score === primary.score
    };
  }, [primary, compare, run, compareRun]);

  // Events (sorted) + highlight which are <= t
  const activeEvents = useMemo(() => {
    const events = Array.isArray(run?.events) ? run.events : [];
    const out = events
      .map((e) => ({
        t: Number(e.t),
        type: String(e.type || ""),
        detail: String(e.detail || ""),
        active: Number(e.t) <= t
      }))
      .filter((e) => Number.isFinite(e.t) && e.type)
      .sort((a, b) => a.t - b.t);
    return out;
  }, [run, t]);

  // Playback loop
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();

    const tick = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((prev) => {
        const next = prev + dt * speed;
        if (next >= maxT) {
          setPlaying(false);
          return maxT;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, maxT]);

  // Draw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;

    drawGrid(ctx, w, h);

    const framesA = Array.isArray(run?.frames) ? run.frames : [];
    const framesB = Array.isArray(compareRun?.frames) ? compareRun.frames : [];

    const bounds = computeBounds(framesA.concat(framesB));
    const padPx = 26;

    const spanX = bounds.maxX - bounds.minX || 1;
    const spanY = bounds.maxY - bounds.minY || 1;

    const sx = (w - padPx * 2) / spanX;
    const sy = (h - padPx * 2) / spanY;
    const s = Math.min(sx, sy);

    const toCanvas = (p) => ({
      x: padPx + (p.x - bounds.minX) * s,
      y: h - (padPx + (p.y - bounds.minY) * s)
    });

    // Compare path behind (red)
    let lastB = null;
    if (compareRunId && compareRun) {
      lastB = drawPath(ctx, framesB, t, toCanvas, {
        strokeStyle: "rgba(239,68,68,0.85)",
        lineWidth: 2,
        alpha: 1
      });
      drawDot(ctx, lastB, toCanvas, { fillStyle: "rgba(239,68,68,0.9)", r: 5 });
    }

    // Primary path (white)
    const lastA = drawPath(ctx, framesA, t, toCanvas, {
      strokeStyle: "rgba(255,255,255,0.85)",
      lineWidth: 2,
      alpha: 1
    });
    drawDot(ctx, lastA, toCanvas, { fillStyle: "rgba(255,255,255,0.9)", r: 5 });
  }, [run, compareRun, compareRunId, t]);

  // Diagnose (LLM)
  async function diagnoseLLM() {
    if (!run) return;
    setDiagText("Thinking…");

    const runSummary = buildRunSummary(run);
    const compareSummary = compareRun ? buildRunSummary(compareRun) : null;

    try {
      const resp = await fetch("/api/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenarioKey,
          runSummary,
          compareSummary
        })
      });

      const data = await resp.json();
      if (!resp.ok) {
        setDiagText("Backend error: " + (data?.error || resp.status));
        return;
      }

      const pretty =
        "VERDICT: " +
        data.verdict +
        " (conf " +
        Number(data.confidence).toFixed(2) +
        ")\n\n" +
        data.operator_summary +
        "\n\n" +
        "ROOT CAUSES:\n- " +
        (data.root_causes || []).join("\n- ") +
        "\n\n" +
        "EVIDENCE:\n- " +
        (data.evidence || [])
          .map((e) => `[${Number(e.t).toFixed(1)}s] ${e.type}: ${e.why_it_matters}`)
          .join("\n- ") +
        "\n\n" +
        "RECOMMENDATIONS:\n- " +
        (data.recommendations || []).join("\n- ") +
        "\n\n" +
        "NEXT TESTS:\n- " +
        (data.next_tests || []).join("\n- ") +
        (data.compare_insights ? "\n\nCOMPARE:\n" + data.compare_insights : "");

      setDiagText(pretty);
    } catch (e) {
      setDiagText("Request failed: " + String(e));
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo" />
          <div>
            <div className="brandTitle">SimTrace</div>
            <div className="brandSubtitle">
              Scenario-aware replay, comparison, and diagnosis for robotics simulation runs
            </div>
          </div>
        </div>

        <div className="topPills">
          <div className="pill">
            <span className="pillDot primary" />
            Primary
          </div>
          <div className="pill">
            <span className="pillDot compare" />
            Compare
          </div>
          <div className="pill subtle">Software-only • Browser demo</div>
        </div>
      </header>

      <main className="layout">
        {/* LEFT */}
        <aside className="panel">
          <div className="panelHead">
            <div className="panelTitle">Runs</div>
            <div className="panelHint">Select a run to replay</div>
          </div>

          <div className="panelBody">
            <div className="runs">
              {(index?.runs || []).map((r) => (
                <div
                  key={r.id}
                  className={"runCard " + (r.id === runId ? "active" : "")}
                  onClick={() => setRunId(r.id)}
                >
                  <div className="runTitle">{r.label}</div>
                  <div className="runMeta">{r.file}</div>
                </div>
              ))}
            </div>

            <div className="divider" />

            <div className="sectionTitle">Scenario</div>
            <select
              className="select"
              value={scenarioKey}
              onChange={(e) => setScenarioKey(e.target.value)}
            >
              <option value="warehouse">Warehouse robot</option>
              <option value="delivery">Delivery bot (ground)</option>
              <option value="sar">Search & rescue</option>
            </select>

            <div className="statusRow">
              <div className="statusPill">
                <span
                  className="statusDot"
                  style={{
                    background: primary ? statusColor(primary.status) : "rgba(255,255,255,0.25)"
                  }}
                />
                <b>{primary ? primary.status : "—"}</b>
              </div>
              <div className="statusText">{SCENARIOS[scenarioKey]?.blurb || ""}</div>
            </div>

            <div className="divider" />

            <div className="sectionTitle">Compare to</div>
            <select
              className="select"
              value={compareRunId}
              onChange={(e) => setCompareRunId(e.target.value)}
            >
              <option value="">None</option>
              {(index?.runs || [])
                .filter((r) => r.id !== runId)
                .map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
            </select>

            <div className="compareCard">
              <div className="compareTitle">Comparison</div>

              {!deltas ? (
                <div className="muted" style={{ fontSize: 12 }}>
                  Pick a compare run to overlay paths and compute deltas.
                </div>
              ) : (
                <>
                  <div className="kv">
                    <div>Δ score</div>
                    <div className="mono">{fmtDelta(deltas.score)}</div>
                  </div>
                  <div className="kv">
                    <div>Δ near-collisions</div>
                    <div className="mono">{fmtDelta(deltas.near)}</div>
                  </div>
                  <div className="kv">
                    <div>Δ stuck</div>
                    <div className="mono">{fmtDelta(deltas.stuck)}</div>
                  </div>
                  <div className="kv">
                    <div>Δ collisions</div>
                    <div className="mono">{fmtDelta(deltas.collision)}</div>
                  </div>
                  <div className="kv">
                    <div>Δ duration</div>
                    <div className="mono">{fmtDelta(deltas.duration, "s")}</div>
                  </div>
                  <div className="kv">
                    <div>Δ distance</div>
                    <div className="mono">
                      {deltas.distance == null ? "—" : fmtDelta(deltas.distance, "m")}
                    </div>
                  </div>

                  <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                    {deltas.equal
                      ? "Same scenario score. Compare event timing and path behavior."
                      : deltas.better
                      ? "Compare run looks better under this scenario policy (lower score)."
                      : "Compare run looks worse under this scenario policy (higher score)."}
                  </div>
                </>
              )}
            </div>

            <button className="btn" disabled={!run} onClick={diagnoseLLM}>
              Diagnose Run (AI)
            </button>

            <div className="diagBox mono">
              {diagText || "Click Diagnose Run to generate an AI diagnosis."}
            </div>
          </div>
        </aside>

        {/* MIDDLE */}
        <section className="panel mainPanel">
          <div className="panelHead">
            <div className="panelTitle">Replay</div>
            <div className="panelHint">Scrub timeline • Overlay compare run</div>
          </div>

          <div className="panelBody">
            <canvas
              ref={canvasRef}
              width={900}
              height={520}
              style={{
                width: "100%",
                borderRadius: 14,
                border: "1px solid var(--border)",
                background: "rgba(255,255,255,0.02)"
              }}
            />

            <div className="controls">
              <button className="btn ghost" disabled={!run} onClick={() => setPlaying(true)}>
                Play
              </button>
              <button className="btn ghost" disabled={!playing} onClick={() => setPlaying(false)}>
                Pause
              </button>
              <div className="spacer" />
              <div className="smallLabel">Speed</div>
              <select
                className="select smallSelect"
                value={String(speed)}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                <option value="0.5">0.5x</option>
                <option value="1">1x</option>
                <option value="2">2x</option>
                <option value="4">4x</option>
              </select>
            </div>

            <input
              className="range"
              type="range"
              min="0"
              max={sliderSteps}
              value={clamp(sliderValue, 0, sliderSteps)}
              onChange={(e) => {
                const v = Number(e.target.value) / 10;
                setT(clamp(v, 0, maxT));
              }}
            />
            <div className="timeLine">
              Time: <span className="mono">{t.toFixed(1)}s</span>
            </div>
          </div>
        </section>

        {/* RIGHT */}
        <aside className="panel">
          <div className="panelHead">
            <div className="panelTitle">Events</div>
            <div className="panelHint">Timeline highlights</div>
          </div>

          <div className="panelBody">
            {activeEvents.length === 0 ? (
              <div className="muted" style={{ fontSize: 12 }}>
                No events in this run.
              </div>
            ) : (
              activeEvents.map((e, i) => (
                <div key={i} className={"event " + (e.active ? "activeEvt" : "")}>
                  <div className="mono">{Number(e.t).toFixed(1)}s</div>
                  <div>
                    <b>{e.type}</b> <span className="muted">{e.detail}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
