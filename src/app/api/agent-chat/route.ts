import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/require-session';

// Disabled: chat kind is not supported by the narrow executor. Persona prompts and
// the queue/poll logic were removed; see git history (8108a9f) to restore.
// POST always answers 400: the chat kind is not supported by the narrow executor.
export async function POST(): Promise<NextResponse> {
  const denied = await requireSession();
  if (denied) return denied;
  return NextResponse.json({ error: "disabled: not supported by the executor" }, { status: 400 });
}
