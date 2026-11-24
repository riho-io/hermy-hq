import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

// Prisma's pooler default here was connection_limit=1: one slow query made every other request
// on the same instance wait 10 s and fail with P2024 (24.11, /arved "Viga 500"). The env value is a
// Vercel Secret that cannot be edited without re-entering it, so the limit is set here instead.
// Safe with Supabase's transaction pooler (Supavisor multiplexes; 3 per instance is far below its cap).
function withPoolLimit(url: string | undefined, limit = 3): string | undefined {
  if (!url) return url
  if (/[?&]connection_limit=\d+/.test(url)) return url.replace(/([?&]connection_limit=)\d+/, `$1${limit}`)
  return `${url}${url.includes('?') ? '&' : '?'}connection_limit=${limit}`
}

export const prisma =
  globalForPrisma.prisma ?? new PrismaClient({ datasourceUrl: withPoolLimit(process.env.DATABASE_URL) })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma
