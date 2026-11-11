import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { isAllowed, requiresApproval, jobIdSchema, profileSchema, presetSchema, scheduleSchema } from "@/lib/hermes-actions";

export type CronJob = {
  id: string;
  status: string;           // "active" | "paused"
  name: string;
  schedule: string;
  nextRun: string | null;
  lastRun: string | null;
  lastResult: string | null;
  deliver: string | null;
  skills: string | null;
  script: string | null;
  mode: string | null;
};

// Parse the raw `hermes cron list --all` terminal output into clean objects.
// Format per job: two-space-indented "<id> [status]" then four-space "Key: value" lines.
function parseCrons(raw: string): CronJob[] {
  const jobs: CronJob[] = [];
  let cur: CronJob | null = null;
  const push = () => { if (cur) jobs.push(cur); };
  for (const line of raw.split("\n")) {
    const head = line.match(/^\s{2}([0-9a-f]{6,})\s+\[(\w+)\]/);
    if (head) {
      push();
      cur = { id: head[1], status: head[2], name: "", schedule: "", nextRun: null, lastRun: null, lastResult: null, deliver: null, skills: null, script: null, mode: null };
      continue;
    }
    const kv = line.match(/^\s{4}([A-Za-z][A-Za-z ]*?):\s+(.*)$/);
    if (kv && cur) {
      const key = kv[1].trim().toLowerCase();
      const val = kv[2].trim();
      if (key === "name") cur.name = val;
      else if (key === "schedule") cur.schedule = val;
      else if (key === "next run") cur.nextRun = val;
      else if (key === "deliver") cur.deliver = val;
      else if (key === "skills") cur.skills = val;
      else if (key === "script") cur.script = val;
      else if (key === "mode") cur.mode = val;
      else if (key === "last run") {
        const m = val.match(/^(\S+)\s+(.*)$/);
        cur.lastRun = m ? m[1] : val;
        cur.lastResult = m ? m[2] : null;
      }
    }
  }
  push();
  return jobs;
}

export async function GET() {
  const row = await prisma.dataStore.findUnique({ where: { key: "hermes-crons" } });
  const data = (row?.data as { raw?: string; syncedAt?: string } | null) ?? {};
  const jobs = data.raw ? parseCrons(data.raw) : [];
  return NextResponse.json({ jobs, syncedAt: data.syncedAt ?? null });
}

// POST { op: "pause"|"resume"|"run"|"deliver"|"schedule", id, profile?, preset?|schedule? }
// → queue a cron mutation for the narrow server-side executor. Allowlist lives in hermes-actions.ts.
// AgentRequest has no metadata column, so {jobId, profile, preset|schedule} is stored as JSON in `prompt`.
export async function POST(req: Request) {
  if (process.env.NODE_ENV !== "development") {
    const session = await getServerSession(authOptions);
    if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
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
