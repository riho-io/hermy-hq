import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

// Returns a 401 response when there is no session, otherwise null.
// No dev bypass: every dashboard API handler must call this first.
export async function requireSession(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return null;
}
