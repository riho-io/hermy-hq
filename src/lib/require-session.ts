import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { roleOf, type Role } from "@/lib/access";

// Owner-only. Returns a 401/403 response when denied, otherwise null.
// No dev bypass: every dashboard API handler must call this first.
// A bill guest is refused here, so every existing handler stays owner-only by default.
export async function requireSession(): Promise<NextResponse | null> {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (roleOf(session.user?.email) !== "owner") return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return null;
}

// For the bill routes a guest may use. The caller must still narrow what a guest sees and changes.
export async function requireBillsAccess(): Promise<{ role: Role; denied: null } | { role: null; denied: NextResponse }> {
  const session = await getServerSession(authOptions);
  if (!session) return { role: null, denied: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  const role = roleOf(session.user?.email);
  if (!role) return { role: null, denied: NextResponse.json({ error: "forbidden" }, { status: 403 }) };
  return { role, denied: null };
}
