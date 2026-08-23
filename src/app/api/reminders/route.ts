import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function parseDueDate(v: string | undefined | null): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// Advance a date by the repeat interval (for "mark done -> rolls forward").
function advanceRepeat(due: Date, repeat: string): Date {
  const d = new Date(due);
  if (repeat === "yearly") d.setFullYear(d.getFullYear() + 1);
  else if (repeat === "monthly") d.setMonth(d.getMonth() + 1);
  else if (repeat === "weekly") d.setDate(d.getDate() + 7);
  return d;
}

export async function GET() {
  const reminders = await prisma.reminder.findMany({
    orderBy: [{ status: "asc" }, { dueDate: "asc" }],
  });
  const categories = Array.from(
    new Set(reminders.map((r) => r.category || "Muud"))
  ).sort((a, b) => a.localeCompare(b, "et"));
  return NextResponse.json({ reminders, categories });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { title, category, amount, dueDate, repeat, notes } = body || {};
  if (!title || !String(title).trim()) {
    return NextResponse.json({ error: "Pealkiri on kohustuslik" }, { status: 400 });
  }
  const reminder = await prisma.reminder.create({
    data: {
      title: String(title).trim(),
      category: String(category || "Muud").trim() || "Muud",
      amount: amount ? String(amount).trim() : null,
      dueDate: parseDueDate(dueDate),
      repeat: ["none", "yearly", "monthly", "weekly"].includes(repeat) ? repeat : "none",
      notes: notes ? String(notes).trim() : null,
    },
  });
  return NextResponse.json({ reminder }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const body = await req.json();
  const { id, ...rest } = body || {};
  if (!id) return NextResponse.json({ error: "id puudub" }, { status: 400 });

  const data: Record<string, unknown> = {};
  if ("title" in rest) data.title = String(rest.title).trim();
  if ("category" in rest) data.category = String(rest.category || "Muud").trim() || "Muud";
  if ("amount" in rest) data.amount = rest.amount ? String(rest.amount).trim() : null;
  if ("dueDate" in rest) data.dueDate = parseDueDate(rest.dueDate);
  if ("repeat" in rest) data.repeat = rest.repeat || "none";
  if ("notes" in rest) data.notes = rest.notes ? String(rest.notes).trim() : null;
  if ("status" in rest) {
    const status = rest.status === "done" ? "done" : "active";
    // When marking done, roll a recurring reminder forward instead of hiding it.
    const existing = await prisma.reminder.findUnique({ where: { id } });
    if (status === "done" && existing && existing.repeat !== "none" && existing.dueDate) {
      data.status = "active";
      data.dueDate = advanceRepeat(existing.dueDate, existing.repeat);
    } else {
      data.status = status;
    }
  }

  const reminder = await prisma.reminder.update({ where: { id }, data });
  return NextResponse.json({ reminder });
}

export async function DELETE(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id puudub" }, { status: 400 });
  await prisma.reminder.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
