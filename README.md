# SimTrace

**Scenario-aware simulation replay, comparison, and diagnosis for robotics teams.**

SimTrace is a software-only robotics analysis tool that helps teams **replay**, **compare**, and **diagnose** robot behavior across different operational scenarios — all inside a browser.

Built for simulation-first workflows (digital twins, virtual robots, and dev tooling), SimTrace turns raw run logs into **clear insights** about safety, robustness, and controller quality.

---

## 🚀 What problem does this solve?

Robotics teams often have:
- Dozens of simulation runs
- Different environments and use cases
- No easy way to **compare behavior**, **evaluate safety**, or **explain failures**

SimTrace acts as a **debug + evaluation layer** on top of simulation logs:
- Replay trajectories visually
- Compare runs side-by-side
- Evaluate performance under different **scenario policies**
- Generate human-readable incident reports

---

## ✨ Key Features

### ▶️ Simulation Replay
- Time-scrubbable replay of robot trajectories
- Visual path + live robot position
- Event timeline (near-collisions, stuck states, etc.)

### 🧭 Scenario Presets (Core Idea)
The same run is evaluated differently depending on context:
- **Warehouse robot** (strict safety)
- **Delivery bot (ground)** (moderate tolerance)
- **Search & rescue** (high tolerance, recovery-focused)

Each scenario defines:
- Safety limits
- Metric weighting
- PASS / WARN / FAIL outcome

This shows **reuse of the same engine for different robotics products**.

### 🔍 Run Comparison (Very Strong)
- Overlay two runs on the same map
- Scenario-aware delta metrics:
  - Δ near-collisions
  - Δ stuck events
  - Δ distance
  - Δ duration
  - Δ weighted score
- Instantly see whether tuning actually improved behavior

### 🧠 Scenario-Aware Diagnosis
- Generates a readable incident report
- Explains *why* a run failed or passed under a scenario
- Suggests concrete controller fixes and next tests
- Adapts recommendations based on the selected scenario

---

## 🖥️ How to Run Locally

```bash
git clone https://github.com/statewarrior483/simtrace.git
cd simtrace
python -m http.server 8000
