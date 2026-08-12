import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Kinds the website may queue. Anything else is rejected — the caller must
// not be able to smuggle arbitrary kind strings into the bridge.
const ALLOWED_KINDS = new Set([
  "oneshot",
  "chat",
  "kanban",
  "goal",
  "memory.write",
  "briefing.generate",
  "model.set",
  "journey.fetch",
  "onboarding.write",
  "cron.create",
  "cron.run",
  "cron.pause",
  "cron.resume",
  "cron.remove",
  "cron.edit",
]);

// Kinds that are ALWAYS side-effecting — the client may not downgrade them to
// immediate execution. Goal mode is the most autonomous action, so it must
// always wait for explicit approval.
const ALWAYS_SIDE_EFFECTING = new Set(["goal"]);

// POST { kind?, title, prompt?, sideEffecting? } → queue work for Hermes.
// Side-effecting work waits for approval; safe work is queued immediately.
export async function POST(req: Request) {
  const b = await req.json().catch(() => ({}));
  const title = (b.title || b.prompt || "").toString().trim();
  if (!title) return NextResponse.json({ error: "title or prompt required" }, { status: 400 });

  const kind = (b.kind || "oneshot").toString();
  if (!ALLOWED_KINDS.has(kind)) {
    return NextResponse.json({ error: "kind not allowed" }, { status: 400 });
  }

  // Enforce the approval gate for high-risk kinds regardless of what the
  // client sent — never let an authenticated caller bypass it.
  const sideEffecting = ALWAYS_SIDE_EFFECTING.has(kind) || Boolean(b.sideEffecting);

  const row = await prisma.agentRequest.create({
    data: {
      origin: "web",
      kind,
      title: title.slice(0, 200),
      prompt: (b.prompt ?? b.title ?? "").toString() || null,
      sideEffecting,
      status: sideEffecting ? "awaiting_approval" : "queued",
    },
  });
  return NextResponse.json({ request: row });
}
