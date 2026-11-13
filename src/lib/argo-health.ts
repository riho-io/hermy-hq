import { z } from 'zod'

export const ArgoHealth = z.object({
  source: z.literal('argo'),
  checkedAt: z.string().max(40).refine((s) => !Number.isNaN(Date.parse(s))),
  gatewayOk: z.boolean(),
  nousLoggedIn: z.boolean(),
  nousBalance: z.number().finite().nullable(),
})
export type ArgoHealth = z.infer<typeof ArgoHealth>

export function parseArgoHealth(input: unknown): ArgoHealth | null {
  const r = ArgoHealth.safeParse(input)
  return r.success ? r.data : null
}

// Valvur jookseb iga 15 min; 40 min ilma = kaks jooksu vahele jäänud.
const STALE_MIN = 40
const BALANCE_MIN = 1

export function bannerIssues(h: ArgoHealth | null, now: Date, failingJobs: string[]): string[] {
  const issues: string[] = []
  if (!h) {
    issues.push('Argo VPS pole tervist saatnud')
  } else {
    const ageMin = Math.round((now.getTime() - Date.parse(h.checkedAt)) / 60_000)
    if (ageMin > STALE_MIN) {
      issues.push(`Argo VPS vaikib (viimati ${ageMin} min tagasi)`)
    } else {
      if (!h.gatewayOk) issues.push('Hermese gateway ei jookse')
      if (!h.nousLoggedIn) issues.push('Nous välja logitud — ssh hermes → hermes model')
      else if (h.nousBalance !== null && h.nousBalance < BALANCE_MIN) {
        issues.push(`Nousi saldo $${h.nousBalance.toFixed(2)}`)
      }
    }
  }
  if (failingJobs.length) {
    issues.push(`${failingJobs.length} cronit katki: ${failingJobs.join(', ')}`)
  }
  return issues
}
