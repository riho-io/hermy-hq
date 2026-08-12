import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Allowed models the operator can switch to (keep it a curated allowlist —
// prevents arbitrary strings from being written into persistent config).
const ALLOWED_MODELS = [
  "deepseek/deepseek-v4-flash",
  "anthropic/claude-sonnet-4.5",
  "anthropic/claude-opus-4.1",
  "openai/gpt-5.2",
  "openai/gpt-4.1",
  "google/gemini-3-pro",
  "google/gemini-3-flash",
  "xai/grok-4",
  "meta-llama/llama-4-maverick",
];

// GET /api/hermes/model → current model from the bridge-mirrored DataStore.
// The website never talks to the Hermes CLI directly (it lives on the bridge
// machine); the bridge mirrors the current model here on its mirror tick.
export async function GET() {
  try {
    const row = await prisma.dataStore.findUnique({ where: { key: "hermes-model" } });
    const current = (row?.data as any)?.model || "";
    const models = current
      ? [current, ...ALLOWED_MODELS.filter((m) => m !== current)]
      : ALLOWED_MODELS;
    return NextResponse.json({ model: current, models });
  } catch {
    return NextResponse.json({ model: "", models: ALLOWED_MODELS });
  }
}

// POST /api/hermes/model { model } → queue a model.set request on the message
// bus; the bridge picks it up, runs `hermes config set model <m>`, and mirrors
// the result back into DataStore. Works from Vercel without local CLI access.
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const model = (b.model || "").toString().trim();
  if (!ALLOWED_MODELS.includes(model)) {
    return NextResponse.json({ error: "model not allowed" }, { status: 400 });
  }
  try {
    const row = await prisma.agentRequest.create({
      data: {
        origin: "web",
        kind: "model.set",
        title: `Switch model to ${model}`,
        prompt: JSON.stringify({ model }),
        sideEffecting: false,
        status: "queued",
      },
    });
    return NextResponse.json({ ok: true, requestId: row.id, model });
  } catch {
    // Never leak internal DB errors to the client.
    return NextResponse.json({ error: "failed to queue model switch" }, { status: 500 });
  }
}
