// src/server.js
//
// Minimal backend for BKT Creation.
// The browser never sees the Kling API key — it only talks to this server,
// which holds the key in process.env and proxies to Kling.

import "dotenv/config";
import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
import { submitTextToVideo, getTaskStatus, KlingApiError } from "./klingClient.js";

const app = express();
const PORT = process.env.PORT || 8787;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: "100kb" }));

const jobs = new Map();

const MODEL_MAP = {
  "forge-fast": { model: "kling-v2-6", mode: "std" },
  "forge-pro": { model: "kling-v2-6", mode: "professional" },
  "forge-cinema": { model: "kling-v2-6", mode: "professional" },
};

const ALLOWED_DURATIONS = new Set(["5", "10"]);
const ALLOWED_ASPECTS = new Set(["16:9", "9:16", "1:1"]);

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 6;
const rateBuckets = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const hits = (rateBuckets.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  hits.push(now);
  rateBuckets.set(ip, hits);
  return hits.length > RATE_LIMIT_MAX;
}

app.post("/api/generate", async (req, res) => {
  const ip = req.ip;
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests. Wait a minute and try again." });
  }

  const { prompt, duration, aspectRatio, model } = req.body || {};

  if (typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "A non-empty prompt is required." });
  }
  if (prompt.length > 500) {
    return res.status(400).json({ error: "Prompt must be 500 characters or fewer." });
  }

  const durationStr = String(duration ?? "5");
  if (!ALLOWED_DURATIONS.has(durationStr)) {
    return res.status(400).json({ error: "Duration must be 5 or 10 seconds (Kling's supported lengths)." });
  }

  const aspect = aspectRatio || "16:9";
  if (!ALLOWED_ASPECTS.has(aspect)) {
    return res.status(400).json({ error: "Aspect ratio must be one of 16:9, 9:16, 1:1." });
  }

  const modelConfig = MODEL_MAP[model] || MODEL_MAP["forge-fast"];

  const jobId = randomUUID();
  jobs.set(jobId, { status: "submitted", createdAt: Date.now() });

  try {
    const { taskId } = await submitTextToVideo({
      prompt: prompt.trim(),
      duration: durationStr,
      aspectRatio: aspect,
      model: modelConfig.model,
      mode: modelConfig.mode,
    });
    jobs.set(jobId, { status: "processing", taskId, createdAt: Date.now() });
    res.json({ jobId });
  } catch (err) {
    jobs.set(jobId, { status: "failed", error: describeError(err), createdAt: Date.now() });
    console.error("[generate] submit failed:", err);
    res.status(502).json({ error: describeError(err) });
  }
});

app.get("/api/generate/:jobId", async (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Unknown job id." });
  }

  if (job.status === "succeed" || job.status === "failed") {
    return res.json(toClientShape(job));
  }

  try {
    const result = await getTaskStatus(job.taskId);
    const updated = { ...job, status: mapStatus(result.status) };

    if (result.status === "succeed") {
      updated.videoUrl = result.videoUrl;
    }
    if (result.status === "failed") {
      updated.error = result.failReason || "Generation failed on Kling's side.";
    }

    jobs.set(req.params.jobId, updated);
    res.json(toClientShape(updated));
  } catch (err) {
    console.error("[poll] status check failed:", err);
    res.json(toClientShape(job));
  }
});

function mapStatus(klingStatus) {
  if (klingStatus === "submitted") return "queued";
  if (klingStatus === "processing") return "processing";
  if (klingStatus === "succeed") return "succeed";
  if (klingStatus === "failed") return "failed";
  return "processing";
}

function toClientShape(job) {
  return {
    status: job.status,
    videoUrl: job.videoUrl ?? null,
    error: job.error ?? null,
  };
}

function describeError(err) {
  if (err instanceof KlingApiError) {
    if (err.httpStatus === 401) return "Authentication failed — check your Kling API key.";
    if (err.httpStatus === 429) return "Kling rate limit hit — wait a moment and try again.";
    return err.message;
  }
  return "Unexpected server error while contacting Kling.";
}

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}, 5 * 60 * 1000);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`BKT Creation backend listening on http://localhost:${PORT}`);
  if (!process.env.KLING_ACCESS_KEY || !process.env.KLING_SECRET_KEY) {
    console.warn(
      "WARNING: KLING_ACCESS_KEY / KLING_SECRET_KEY not set. Copy .env.example to .env and fill them in."
    );
  }
});
