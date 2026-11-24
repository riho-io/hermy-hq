// Who may use Hermy HQ, read from env on every check so removing an address revokes access at once
// (even for a session cookie that is still valid).
//   ALLOWED_EMAILS       owners: the whole dashboard
//   BILLS_GUEST_EMAILS   bill guests: only /arved, only blocks marked guestVisible, only "Makstud"
export type Role = 'owner' | 'bills_guest'

function list(v: string | undefined): string[] {
  return (v ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
}

export function roleOf(email: string | null | undefined): Role | null {
  const e = (email ?? '').trim().toLowerCase()
  if (!e) return null
  if (list(process.env.ALLOWED_EMAILS).includes(e)) return 'owner'
  if (list(process.env.BILLS_GUEST_EMAILS).includes(e)) return 'bills_guest'
  return null
}

// The only paths a bill guest can reach. Everything else is owner-only by default.
export function guestMayUse(pathname: string, method: string): boolean {
  if (pathname === '/arved') return method === 'GET'
  if (pathname === '/api/bills') return method === 'GET' || method === 'PATCH'
  if (pathname === '/api/bills/file') return method === 'GET'
  return false
}
