// src/klingClient.js
//
// Talks to Kling AI's official API. Auth is JWT-based: we sign a short-lived
// token from the Access Key / Secret Key pair on every request batch
// (tokens expire after 30 minutes, so we regenerate generously rather than
// caching across a long-lived process).
//
// Docs reference: app.klingai.com/global/dev/document-api

import jwt from "jsonwebtoken";
import fetch from "node-fetch";

const BASE_URL = "https://api.klingai.com/v1";

function getCredentials() {
  const accessKey = process.env.KLING_ACCESS_KEY;
  const secretKey = process.env.KLING_SECRET_KEY;
  if (!accessKey || !secretKey) {
    throw new Error(
      "Missing KLING_ACCESS_KEY or KLING_SECRET_KEY. Copy .env.example to .env and fill them in."
    );
  }
  return { accessKey, secretKey };
}

function signToken() {
  const { accessKey, secretKey } = getCredentials();
  const payload = {
    iss: accessKey,
    exp: Math.floor(Date.now() / 1000) + 1800, // 30 min validity
    nbf: Math.floor(Date.now() / 1000) - 5, // valid starting 5s ago (clock skew buffer)
  };
  return jwt.sign(payload, secretKey, {
    algorithm: "HS256",
    header: { alg: "HS256", typ: "JWT" },
  });
}

function authHeaders() {
  return {
    Authorization: `Bearer ${signToken()}`,
    "Content-Type": "application/json",
  };
}

export async function submitTextToVideo({
  prompt,
  negativePrompt = "",
  duration = "5",
  aspectRatio = "16:9",
  model = "kling-v2-6",
  mode = "std",
}) {
  const res = await fetch(`${BASE_URL}/videos/text2video`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      model_name: model,
      prompt,
      negative_prompt: negativePrompt,
      duration: String(duration),
      aspect_ratio: aspectRatio,
      mode,
    }),
  });

  const body = await res.json().catch(() => null);

  if (!res.ok || !body) {
    throw new KlingApiError(
      `Kling rejected the generation request (HTTP ${res.status})`,
      res.status,
      body
    );
  }

  const taskId = body?.data?.task_id;
  if (!taskId) {
    throw new KlingApiError("Kling response did not include a task_id", res.status, body);
  }

  return { taskId, raw: body };
}

export async function getTaskStatus(taskId) {
  const res = await fetch(`${BASE_URL}/videos/text2video/${taskId}`, {
    method: "GET",
    headers: authHeaders(),
  });

  const body = await res.json().catch(() => null);

  if (!res.ok || !body) {
    throw new KlingApiError(
      `Failed to fetch task status (HTTP ${res.status})`,
      res.status,
      body
    );
  }

  const data = body?.data;
  const status = data?.task_status;
  const videoUrl = data?.task_result?.videos?.[0]?.url ?? null;

  return {
    status,
    videoUrl,
    failReason: data?.task_status_msg ?? null,
    raw: body,
  };
}

export class KlingApiError extends Error {
  constructor(message, httpStatus, body) {
    super(message);
    this.name = "KlingApiError";
    this.httpStatus = httpStatus;
    this.body = body;
  }
}
