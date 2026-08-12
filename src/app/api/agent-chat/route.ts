import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

interface AgentChatRequest {
  agentId: string;
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

// Agent personas — each routes through Hermes (via the bridge) so the reply
// carries the operator's real context, memory and skills. No external API key
// needed: the bridge runs `hermes -z "<persona> <message>"`.
const AGENT_PROMPTS: Record<string, string> = {
  max: "You are Max, Riho's executive assistant and COO-level strategist for Põhja Mööbel OÜ (furniture business) and his AI ventures. Be sharp, concise, strategic. Give real actionable advice.",
  sage: "You are Sage, content specialist. You help Riho with Estonian and English content, X posts, and Sisu (his content side-business). Write in a conversational, sharp voice. Focus on hooks.",
  knox: "You are Knox, operations and analysis specialist. You analyze business processes, email orders from partner Valju, and suggest improvements. Be data-driven and direct.",
  nova: "You are Nova, YouTube and video strategy specialist. You help with scripts, hooks, titles, and the video agent work (video summaries, mission control videos).",
  pixel: "You are Pixel, web app / vibe-coding product specialist. You help with ~/vibe-projects apps, UX improvements, feature ideas, competitor gaps. Think product manager + growth hacker.",
};

// POST /api/agent-chat { agentId, message, history? }
// Queues a chat request on the Hermes message bus and polls until the bridge
// finishes, returning the agent's reply. Timeout ~75s.
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body: AgentChatRequest = await request.json();
    const { agentId, message } = body;

    if (!agentId || !message) {
      return NextResponse.json({ error: 'Missing agentId or message' }, { status: 400 });
    }
    if (typeof message !== 'string' || message.length > 2000) {
      return NextResponse.json({ error: 'Message must be a string under 2000 chars' }, { status: 400 });
    }
    const persona = AGENT_PROMPTS[agentId];
    if (!persona) {
      return NextResponse.json({ error: `Unknown agent: ${agentId}` }, { status: 400 });
    }

    // Queue on the message bus — the bridge runs it via `hermes -z`.
    const row = await prisma.agentRequest.create({
      data: {
        origin: 'web',
        kind: 'chat',
        title: `${agentId}: ${message.slice(0, 120)}`,
        prompt: `${persona}\n\nUser: ${message}`,
        sideEffecting: false,
        status: 'queued',
      },
    });

    // Poll until done/failed (bridge poll is 5s, one-shot typically ~10-60s).
    const deadline = Date.now() + 75000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      const cur = await prisma.agentRequest.findUnique({ where: { id: row.id } });
      if (!cur) break;
      if (cur.status === 'done') {
        return NextResponse.json({ reply: cur.result || '(tühi vastus)', agentId });
      }
      if (cur.status === 'failed') {
        return NextResponse.json({ error: cur.error || 'Agent failed to respond' }, { status: 502 });
      }
    }
    return NextResponse.json({ error: 'Timeout waiting for agent' }, { status: 504 });
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
