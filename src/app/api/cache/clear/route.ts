import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const CACHE_KEYS = ['notion_clients_monthly', 'mcf_monthly', 'ltv_monthly'];

// Session-only since 16.10: the proxy no longer lets x-internal-secret through here.
// The old GET ?secret= variant was removed because a secret in the URL ends up in request logs.
export async function POST() {
  const results = await Promise.all(
    CACHE_KEYS.map(key => prisma.dataStore.delete({ where: { key } }).then(() => ({ key, cleared: true })).catch(() => ({ key, cleared: false })))
  );
  return NextResponse.json({ results });
}
