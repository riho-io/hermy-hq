'use client'
import { useEffect, useState } from 'react'

const REFRESH_MS = 5 * 60_000

export function ArgoHealthBanner() {
  const [issues, setIssues] = useState<string[]>([])

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const r = await fetch('/api/argo-health', { cache: 'no-store' })
        if (!r.ok) return
        const data = (await r.json()) as { issues?: string[] }
        if (alive) setIssues(data.issues ?? [])
      } catch {
        // Võrgutõrge: jätame eelmise seisu, riba ei vilgu.
      }
    }
    load()
    const id = setInterval(load, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  if (!issues.length) return null
  return (
    <div
      role="alert"
      className="mx-4 mt-4 rounded-lg border border-[var(--down)] bg-[color-mix(in_srgb,var(--down)_12%,transparent)] px-4 py-3 text-sm text-[var(--text)]"
    >
      <p className="font-medium text-[var(--down)]">Argo vajab tähelepanu</p>
      <ul className="mt-1 list-disc pl-5">
        {issues.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  )
}
