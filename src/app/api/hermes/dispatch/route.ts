import { NextResponse } from "next/server";
import { requireSession } from "@/lib/require-session";
import { requiresApproval } from "@/lib/hermes-actions";
import { dispatchAccepts } from "@/lib/dispatch-kinds";
import { prisma } from "@/lib/prisma";

// POST { kind?, title, prompt?, sideEffecting? } → queue work for Hermes.
// Side-effecting work waits for approval; safe work is queued immediately.
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const b = await req.json().catch(() => ({}));
  const title = (b.title || b.prompt || "").toString().trim();
  if (!title) return NextResponse.json({ error: "title or prompt required" }, { status: 400 });

  const kind = (b.kind || "").toString();
  if (!dispatchAccepts(kind)) {
    return NextResponse.json({ error: "kind not allowed" }, { status: 400 });
  }

  // Approval comes only from requiresApproval() (fails closed for kinds not in
  // the hermes-actions table); the client cannot downgrade it.
  const sideEffecting = requiresApproval(kind);

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
