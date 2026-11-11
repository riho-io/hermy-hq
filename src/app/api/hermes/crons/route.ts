import { NextResponse } from "next/server";
import { requireSession } from "@/lib/require-session";
import { prisma } from "@/lib/prisma";
import { isAllowed, requiresApproval, jobIdSchema, profileSchema, presetSchema, scheduleSchema, deliverPreset, type DeliverState } from "@/lib/hermes-actions";

export type CronJob = {
  id: string;
  profile: string;
  name: string;
  status: "active" | "paused";
  schedule: string;
  nextRun: string | null;
  lastRun: string | null;
  lastStatus: string | null;
  lastError: string | null;
  failureStreak: number;
  // Preset name only; the raw deliver targets hold chat ids and stay on the server.
  telegram: DeliverState;
};

// Jobs come from AgentJob, filled by hermy_cron_sync.py (all profiles) via /api/ingest/hermes-cron.
export async function GET() {
  const denied = await requireSession();
  if (denied) return denied;
  const rows = await prisma.agentJob.findMany({ orderBy: [{ profile: "asc" }, { name: "asc" }] });
  const jobs: CronJob[] = rows.map((r) => ({
    id: r.id,
    profile: r.profile,
    name: r.name,
    status: r.enabled && r.state !== "paused" ? "active" : "paused",
    schedule: r.schedule,
    nextRun: r.nextRunAt?.toISOString() ?? null,
    lastRun: r.lastRunAt?.toISOString() ?? null,
    lastStatus: r.lastStatus,
    lastError: r.lastError,
    failureStreak: r.failureStreak,
    telegram: deliverPreset(r.deliver, r.failureDeliver),
  }));
  const syncedAt = rows.reduce<Date | null>((m, r) => (!m || r.syncedAt > m ? r.syncedAt : m), null);
  return NextResponse.json({ jobs, syncedAt: syncedAt?.toISOString() ?? null });
}

// POST { op: "pause"|"resume"|"run"|"deliver"|"schedule", id, profile?, preset?|schedule? }
// → queue a cron mutation for the narrow server-side executor. Allowlist lives in hermes-actions.ts.
// AgentRequest has no metadata column, so {jobId, profile, preset|schedule} is stored as JSON in `prompt`.
export async function POST(req: Request) {
  const denied = await requireSession();
  if (denied) return denied;
  const b = await req.json().catch(() => ({}));
  const op = (b.op || "").toString();
  if (["create", "edit", "remove"].includes(op))
    return NextResponse.json({ error: "ei toetata, küsi CC-lt" }, { status: 400 });
  const kind = `cron.${op}`;
  if (!isAllowed(kind)) return NextResponse.json({ error: "bad op" }, { status: 400 });

  const jobId = jobIdSchema.safeParse(b.id);
  const profile = profileSchema.safeParse(b.profile ?? "default");
  if (!jobId.success || !profile.success)
    return NextResponse.json({ error: "bad id or profile" }, { status: 400 });

  const meta: Record<string, string> = { jobId: jobId.data, profile: profile.data };
  if (kind === "cron.deliver") {
    const preset = presetSchema.safeParse(b.preset);
    if (!preset.success) return NextResponse.json({ error: "bad preset" }, { status: 400 });
    meta.preset = preset.data;
  } else if (kind === "cron.schedule") {
    const schedule = scheduleSchema.safeParse(b.schedule);
    if (!schedule.success) return NextResponse.json({ error: "bad schedule" }, { status: 400 });
    meta.schedule = schedule.data;
  }

  const needsApproval = requiresApproval(kind);
  const row = await prisma.agentRequest.create({
    data: {
      origin: "web",
      kind,
      title: `Cron ${op}: ${jobId.data}${meta.preset ? ` → ${meta.preset}` : ""}${meta.schedule ? ` → ${meta.schedule}` : ""}`.slice(0, 200),
      prompt: JSON.stringify(meta),
      sideEffecting: needsApproval,
      status: needsApproval ? "awaiting_approval" : "queued",
    },
  });
  return NextResponse.json({ request: row });
}
