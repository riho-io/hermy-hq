export type GroupLite = { id: string; keywords: string[]; sortOrder: number }

/** Deterministic block assignment: first group (by sortOrder) with a keyword (>= 3 chars) found in the text. */
export function assignGroup(parts: (string | null | undefined)[], groups: GroupLite[]): string | null {
  const hay = parts.filter((p): p is string => !!p).join(' ').toLowerCase()
  for (const g of [...groups].sort((a, b) => a.sortOrder - b.sortOrder)) {
    for (const k of g.keywords) {
      const kk = k.trim().toLowerCase()
      if (kk.length >= 3 && hay.includes(kk)) return g.id
    }
  }
  return null
}
