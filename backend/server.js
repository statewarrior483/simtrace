import "dotenv/config";
import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 8000;

// Gemini client (reads GEMINI_API_KEY automatically if set)
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/api/diagnose", async (req, res) => {
  try {
    const { scenarioKey, runSummary, compareSummary } = req.body || {};

    if (!scenarioKey || !runSummary) {
      return res.status(400).json({ error: "Missing scenarioKey or runSummary" });
    }

    // JSON schema for structured output
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        verdict: { type: "string", enum: ["PASS", "WARN", "FAIL"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        operator_summary: { type: "string" },
        root_causes: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 6
        },
        evidence: {
          type: "array",
          minItems: 2,
          maxItems: 10,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              t: { type: "number" },
              type: { type: "string" },
              why_it_matters: { type: "string" }
            },
            required: ["t", "type", "why_it_matters"]
          }
        },
        recommendations: {
          type: "array",
          items: { type: "string" },
          minItems: 3,
          maxItems: 10
        },
        next_tests: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          maxItems: 8
        },
        // Always required (empty string if no compare run)
        compare_insights: { type: "string" }
      },
      required: [
        "verdict",
        "confidence",
        "operator_summary",
        "root_causes",
        "evidence",
        "recommendations",
        "next_tests",
        "compare_insights"
      ]
    };

    const system = `
You are SimTrace Copilot, an expert robotics debugging assistant.

You analyze simulation run summaries and return ONLY valid JSON matching the provided schema.

Rules:
- Be specific + actionable (tuning, planner, controller, sensor fusion, safety layers, map, costmaps, recovery behaviors).
- Ground your claims in the events evidence and counts.
- If compareSummary is missing, set compare_insights to "".
`;

    const promptObj = {
      scenarioKey,
      runSummary,
      compareSummary: compareSummary || null
    };

    const prompt = `${system}

INPUT (JSON):
${JSON.stringify(promptObj, null, 2)}

TASK:
Return a structured diagnosis.`;

    // Model choice:
    // Start with gemini-3-flash-preview (works great for JSON schema + speed).
    // If you hit model access issues, change to "gemini-2.5-flash".
    const model = process.env.GEMINI_MODEL || "gemini-3-flash-preview";

    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: schema
      }
    });

    const text = response?.text || "";
    let out;
    try {
      out = JSON.parse(text);
    } catch {
      return res.status(502).json({
        error: "bad_model_json",
        details: "Model did not return valid JSON.",
        raw: text.slice(0, 2000)
      });
    }

    // Safety: ensure compare_insights exists even if model forgets (shouldn't happen w/schema)
    if (typeof out.compare_insights !== "string") out.compare_insights = "";

    return res.json(out);
  } catch (err) {
    const msg =
      err?.error?.message ||
      err?.message ||
      String(err);

    return res.status(err?.status || 500).json({
      error: "diagnose_failed",
      details: msg
    });
  }
});

app.listen(PORT, () => {
  console.log(`✅ SimTrace backend listening on http://localhost:${PORT}`);
});
