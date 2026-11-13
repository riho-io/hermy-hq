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
