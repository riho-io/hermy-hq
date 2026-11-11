import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

// Kinds the website may queue. Anything else is rejected — the caller must
// not be able to smuggle arbitrary kind strings into the bridge.
const ALLOWED_KINDS = new Set([
  "kanban",
  "goal",
  "briefing.generate",
  "model.set",
  "journey.fetch",
  "cron.create",
  "cron.run",
  "cron.pause",
  "cron.resume",
  "cron.remove",
  "cron.edit",
]);

// Explicitly refused until each is designed separately (free-text prompts).
const BLOCKED_KINDS = new Set(["oneshot", "chat", "memory.write", "onboarding.write"]);

// Kinds that are ALWAYS side-effecting — the client may not downgrade them to
// immediate execution. Goal mode is the most autonomous action, so it must
// always wait for explicit approval. Mutating cron ops also change external
// state (the cron store) — they must go through approval too.
const ALWAYS_SIDE_EFFECTING = new Set([
  "goal",
  "cron.create",
  "cron.edit",
  "cron.remove",
  "cron.pause",
  "cron.resume",
]);

// POST { kind?, title, prompt?, sideEffecting? } → queue work for Hermes.
// Side-effecting work waits for approval; safe work is queued immediately.
export async function POST(req: Request) {
  if (process.env.NODE_ENV !== "development") {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const b = await req.json().catch(() => ({}));
  const title = (b.title || b.prompt || "").toString().trim();
  if (!title) return NextResponse.json({ error: "title or prompt required" }, { status: 400 });

  const kind = (b.kind || "").toString();
  if (BLOCKED_KINDS.has(kind)) {
    return NextResponse.json({ error: "ei toetata, küsi CC-lt" }, { status: 400 });
  }
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
