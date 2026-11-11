import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/require-session';

// Disabled: chat kind is not supported by the narrow executor. Persona prompts and
// the queue/poll logic were removed; see git history (8108a9f) to restore.
// POST /api/agent-chat { agentId, message, history? }
// Queues a chat request on the Hermes message bus and polls until the bridge
// finishes, returning the agent's reply. Timeout ~75s.
export async function POST(): Promise<NextResponse> {
  const denied = await requireSession();
  if (denied) return denied;
  return NextResponse.json({ error: "disabled: not supported by the executor" }, { status: 400 });
}
