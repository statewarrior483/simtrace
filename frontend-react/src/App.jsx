import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const SCENARIOS = {
  warehouse: {
    name: "Warehouse robot",
    limits: { near_collision: 1, stuck: 0 },
    weights: { near_collision: 3, stuck: 2 },
    blurb:
      "Strict indoor policy: tight aisles, low tolerance for near-collisions and deadlocks.",
  },
  delivery: {
    name: "Delivery bot (ground)",
    limits: { near_collision: 2, stuck: 1 },
    weights: { near_collision: 2, stuck: 2 },
    blurb:
      "Moderate policy: sidewalks + obstacles; some pauses are okay, but repeated issues are not.",
  },
  sar: {
    name: "Search & rescue",
    limits: { near_collision: 3, stuck: 2 },
    weights: { near_collision: 1, stuck: 3 },
    blurb:
      "Lenient collision policy, but deadlocks matter: complex terrain; recovery is critical.",
  },
};

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function statusColor(status) {
  if (status === "PASS") return "var(--good)";
  if (status === "WARN") return "var(--warn)";
  return "var(--bad)";
}

function nearestFrame(frames, t) {
  if (!frames?.length) return null;
  let best = frames[0];
  for (const f of frames) {
    if (Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
  }
  return best;
}

function getCounts(run) {
  const s = run?.stats || {};
  const events = run?.events || [];

  const near =
    s.near_collision_count ??
    events.filter((e) => e.type === "near_collision").length;

  const stuck = s.stuck_count ?? events.filter((e) => e.type === "stuck").length;

  const duration =
    s.duration_s ??
    (run?.frames?.length ? run.frames[run.frames.length - 1].t : 0);

  const distance = s.distance_m ?? 0;

  return { near, stuck, duration, distance };
}

function computeScenario(run, scenarioKey) {
  const sc = SCENARIOS[scenarioKey];
  const { near, stuck, duration, distance } = getCounts(run);
  const score = near * sc.weights.near_collision + stuck * sc.weights.stuck;

  let status = "PASS";
  if (near > sc.limits.near_collision || stuck > sc.limits.stuck) status = "FAIL";
  else if (near === sc.limits.near_collision || stuck === sc.limits.stuck)
    status = "WARN";

  return {
    status,
    score,
    near,
    stuck,
    duration,
    distance,
    limits: sc.limits,
    weights: sc.weights,
    blurb: sc.blurb,
    scenarioName: sc.name,
  };
}

function buildDiagnosis(run, scenarioKey) {
  const out = computeScenario(run, scenarioKey);

  const lines = [];
  lines.push("SIMTRACE DIAGNOSIS");
  lines.push(`Scenario: ${out.scenarioName}`);
  lines.push(`Policy result: ${out.status}`);
  lines.push(
    `Counts: near_collision=${out.near}, stuck=${out.stuck}, duration=${out.duration.toFixed(
      1
    )}s, distance=${out.distance.toFixed(1)}m`
  );
  lines.push(
    `Limits: near≤${out.limits.near_collision}, stuck≤${out.limits.stuck} • Weights: near=${out.weights.near_collision}, stuck=${out.weights.stuck} • Score=${out.score}`
  );
  lines.push("");
  lines.push("Likely root cause:");
  if (out.stuck > 0) lines.push("- Deadlock / missing recovery behavior");
  if (out.near > 0) lines.push("- Late avoidance / unsafe clearance near obstacles");
  if (out.stuck === 0 && out.near === 0) lines.push("- No obvious incidents detected");
  lines.push("");
  lines.push("Recommended fixes:");
  if (scenarioKey === "warehouse") {
    lines.push("- Increase clearance and slow down in tight aisles");
    lines.push("- Add deterministic recovery: back up + rotate if motion stalls");
  } else if (scenarioKey === "delivery") {
    lines.push("- Add pause + re-plan behavior for sidewalk clutter");
    lines.push("- Add hysteresis to prevent oscillation near edges");
  } else {
    lines.push("- Add aggressive recovery: multi-step escape + re-orient");
    lines.push("- Prefer progress heuristics over perfect safety in clutter");
  }
  lines.push("");
  lines.push("Next tests:");
  lines.push("- Randomize obstacle placements and repeat");
  lines.push("- Compare before/after tuning using overlay + score delta");
  return lines.join("\n");
}

export default function App() {
  const canvasRef = useRef(null);
  const timerRef = useRef(null);

  const [index, setIndex] = useState(null);
  const [runId, setRunId] = useState(null);
  const [run, setRun] = useState(null);

  const [compareRunId, setCompareRunId] = useState("");
  const [compareRun, setCompareRun] = useState(null);

  const [scenarioKey, setScenarioKey] = useState("warehouse");

  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  const [diagText, setDiagText] = useState("");

  const TOPBAR_H = 72;

  // Load run index
  useEffect(() => {
    fetch("/runs/index.json")
      .then((r) => r.json())
      .then((data) => setIndex(data))
      .catch((err) => {
        console.error("Failed to load /runs/index.json", err);
        setIndex({ runs: [] });
      });
  }, []);

  // Auto-select first run
  useEffect(() => {
    const runs = index?.runs || [];
    if (!runs.length) return;
    if (!runId) setRunId(runs[0].id);
  }, [index, runId]);

  // Load primary run
  useEffect(() => {
    const runs = index?.runs || [];
    if (!runs.length || !runId) return;

    const item = runs.find((x) => x.id === runId);
    if (!item) return;

    fetch(`/runs/${item.file}`)
      .then((r) => r.json())
      .then((data) => {
        setRun(data);
        setT(0);
        setPlaying(false);
        setDiagText("");
        clearInterval(timerRef.current);
        timerRef.current = null;
      })
      .catch((err) => {
        console.error("Failed to load run file", item.file, err);
        setRun(null);
      });
  }, [index, runId]);

  // Load compare run
  useEffect(() => {
    const runs = index?.runs || [];
    if (!compareRunId) {
      setCompareRun(null);
      return;
    }
    const item = runs.find((x) => x.id === compareRunId);
    if (!item) {
      setCompareRun(null);
      return;
    }
    fetch(`/runs/${item.file}`)
      .then((r) => r.json())
      .then((data) => setCompareRun(data))
      .catch((err) => {
        console.error("Failed to load compare run", item.file, err);
        setCompareRun(null);
      });
  }, [index, compareRunId]);

  const primary = useMemo(
    () => (run ? computeScenario(run, scenarioKey) : null),
    [run, scenarioKey]
  );
  const compare = useMemo(
    () => (compareRun ? computeScenario(compareRun, scenarioKey) : null),
    [compareRun, scenarioKey]
  );

  const deltas = useMemo(() => {
    if (!primary || !compare) return null;
    return {
      score: compare.score - primary.score,
      near: compare.near - primary.near,
      stuck: compare.stuck - primary.stuck,
      distance: Number((compare.distance - primary.distance).toFixed(1)),
      duration: Number((compare.duration - primary.duration).toFixed(1)),
      better: compare.score < primary.score,
      equal: compare.score === primary.score,
    };
  }, [primary, compare]);

  const maxT = run?.frames?.length ? run.frames[run.frames.length - 1].t : 0;

  // Playback loop
  useEffect(() => {
    if (!playing || !run) return;

    const dt = run.dt ?? 0.1;
    timerRef.current = setInterval(() => {
      setT((prev) => {
        const next = prev + dt * speed;
        if (next >= maxT) {
          setPlaying(false);
          clearInterval(timerRef.current);
          timerRef.current = null;
          return maxT;
        }
        return next;
      });
    }, 100);

    return () => {
      clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [playing, run, speed, maxT]);

  // Draw canvas (AUTO-FIT + extra margin so nothing clips)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !run) return;
    const ctx = canvas.getContext("2d");

    const W = canvas.width;
    const H = canvas.height;

    const framesA = run.frames || [];
    const framesB = compareRun?.frames || [];
    const all = framesB.length ? framesA.concat(framesB) : framesA;

    // Filter out any weird frames
    const allFrames = all.filter(
      (f) =>
        f &&
        Number.isFinite(f.x) &&
        Number.isFinite(f.y) &&
        Number.isFinite(f.t)
    );

    if (!allFrames.length) {
      ctx.clearRect(0, 0, W, H);
      return;
    }

    let minX = allFrames[0].x,
      maxX = allFrames[0].x;
    let minY = allFrames[0].y,
      maxY = allFrames[0].y;

    for (const f of allFrames) {
      if (f.x < minX) minX = f.x;
      if (f.x > maxX) maxX = f.x;
      if (f.y < minY) minY = f.y;
      if (f.y > maxY) maxY = f.y;
    }

    const dx0 = Math.max(1e-6, maxX - minX);
    const dy0 = Math.max(1e-6, maxY - minY);

    // Big padding (world)
    const padMul = 0.8;
    minX -= dx0 * padMul;
    maxX += dx0 * padMul;
    minY -= dy0 * padMul;
    maxY += dy0 * padMul;

    // Minimum absolute padding (world)
    const minWorldPad = 1.0;
    minX -= minWorldPad;
    maxX += minWorldPad;
    minY -= minWorldPad;
    maxY += minWorldPad;

    const spanX = Math.max(1e-6, maxX - minX);
    const spanY = Math.max(1e-6, maxY - minY);

    // Big margin (pixels) so thick strokes/dots never touch edges
    const m = 90;
    const scale = Math.min((W - 2 * m) / spanX, (H - 2 * m) / spanY);

    function worldToCanvas(x, y) {
      const cx = m + (x - minX) * scale;
      const cy = H - (m + (y - minY) * scale);
      return [cx, cy];
    }

    function drawGrid() {
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      const step = 60;
      for (let x = 0; x <= W; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }
      for (let y = 0; y <= H; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
    }

    function drawPath(frames, strokeStyle, lineWidth) {
      const clean = (frames || []).filter(
        (f) => f && Number.isFinite(f.x) && Number.isFinite(f.y)
      );
      if (!clean.length) return;

      ctx.beginPath();
      clean.forEach((f, i) => {
        const [cx, cy] = worldToCanvas(f.x, f.y);
        if (i === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      });
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    function drawDot(frame, fillStyle, r) {
      if (!frame) return;
      const [cx, cy] = worldToCanvas(frame.x, frame.y);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = fillStyle;
      ctx.fill();
    }

    ctx.clearRect(0, 0, W, H);
    drawGrid();

    drawPath(framesA, "#e8ecff", 2);
    if (framesB.length) drawPath(framesB, "#ff4d4d", 2);

    const p = nearestFrame(framesA, t);
    drawDot(p, "#e8ecff", 7);

    if (framesB.length) {
      const c = nearestFrame(framesB, t);
      drawDot(c, "#ff4d4d", 6);
    }
  }, [run, compareRun, t]);

  const events = run?.events || [];
  const activeEvents = useMemo(
    () => events.map((e) => ({ ...e, active: Number(e.t) <= t })),
    [events, t]
  );

  const sliderSteps = Math.max(0, Math.floor(maxT * 10));
  const sliderValue = Math.floor(t * 10);

  function fmtDelta(n, suffix = "") {
    const sign = n > 0 ? "+" : "";
    return `${sign}${n}${suffix}`;
  }

  return (
    <div className="app">
      <header
        className="topbar"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: TOPBAR_H,
          zIndex: 9999,
          boxSizing: "border-box",
        }}
      >
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

      {/* Spacer so the fixed topbar NEVER covers your panel title bars */}
      <div style={{ height: TOPBAR_H }} />

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
                    background: primary
                      ? statusColor(primary.status)
                      : "rgba(255,255,255,0.25)",
                  }}
                />
                <b>{primary ? primary.status : "—"}</b>
              </div>
              <div className="statusText">{primary ? primary.blurb : ""}</div>
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
                    <div>Δ distance</div>
                    <div className="mono">{fmtDelta(deltas.distance, "m")}</div>
                  </div>
                  <div className="kv">
                    <div>Δ duration</div>
                    <div className="mono">{fmtDelta(deltas.duration, "s")}</div>
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

            <button
              className="btn"
              disabled={!run}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.preventDefault();
                setDiagText(buildDiagnosis(run, scenarioKey));
              }}
            >
              Diagnose Run
            </button>


            <div className="diagBox mono">
              {diagText || "Click Diagnose Run to generate a diagnosis."}
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
                background: "rgba(255,255,255,0.02)",
              }}
            />

            <div className="controls">
              <button
                className="btn ghost"
                disabled={!run}
                onClick={() => setPlaying(true)}
              >
                Play
              </button>
              <button
                className="btn ghost"
                disabled={!playing}
                onClick={() => setPlaying(false)}
              >
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
