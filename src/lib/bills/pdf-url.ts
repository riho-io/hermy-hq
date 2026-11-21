// SSRF guard for attachment downloads: only Resend's own https hosts.
export function isAllowedPdfUrl(u: string): boolean {
  let url: URL
  try {
    url = new URL(u)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false
  const h = url.hostname.toLowerCase()
  return h === 'resend.com' || h.endsWith('.resend.com')
}
