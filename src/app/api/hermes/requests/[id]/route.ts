import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSession } from "@/lib/require-session";
import { decisionAllowed } from "@/lib/hermes-actions";

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const denied = await requireSession();
  if (denied) return denied;
  const { id } = await params;
  const b = await req.json().catch(() => ({}));
  const action = (b.action || "").toString(); // approve | reject | edit
  const existing = await prisma.agentRequest.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (action === "approve" && !decisionAllowed(existing.kind, "approve"))
    return NextResponse.json({ error: "kind not supported" }, { status: 409 });
  if (action === "edit" && !decisionAllowed(existing.kind, "edit"))
    return NextResponse.json({ error: "edit not supported" }, { status: 400 });

  const data: Record<string, unknown> = { decidedAt: new Date() };
  if (action === "approve") data.status = "approved";
  else if (action === "reject") data.status = "rejected";
  else if (action === "edit") { data.status = "approved"; if (b.prompt) data.prompt = b.prompt.toString(); if (b.title) data.title = b.title.toString().slice(0, 200); }
  else return NextResponse.json({ error: "action must be approve|reject|edit" }, { status: 400 });

  // The status precondition is part of the write: the executor may claim the row (running) after the
  // findUnique above, and a plain update would overwrite that. Zero rows = someone else won.
  const { count } = await prisma.agentRequest.updateMany({
    where: { id, status: { in: ["awaiting_approval", "queued"] } },
    data,
  });
  if (count === 0) return NextResponse.json({ error: "Conflict" }, { status: 409 });
  const row = await prisma.agentRequest.findUnique({ where: { id } });
  return NextResponse.json({ request: row });
}
