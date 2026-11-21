import 'server-only'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { InboundIo, InboundStore, PdfFile } from './inbound'

const RESEND = 'https://api.resend.com'
const MAX_PDF = 5 * 1024 * 1024

async function resendGet(path: string): Promise<any> {
  const key = process.env.RESEND_API_KEY
  if (!key) throw new Error('RESEND_API_KEY missing')
  const res = await fetch(`${RESEND}${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`resend ${res.status}`)
  return res.json()
}

export const io: InboundIo = {
  async fetchEmail(emailId) {
    const j = await resendGet(`/emails/receiving/${encodeURIComponent(emailId)}`)
    return { text: typeof j.text === 'string' ? j.text : '', html: typeof j.html === 'string' ? j.html : '' }
  },

  async fetchPdf(emailId): Promise<PdfFile | null> {
    const list = await resendGet(`/emails/receiving/${encodeURIComponent(emailId)}/attachments`)
    const att = (Array.isArray(list.data) ? list.data : []).find(
      (a: any) => a?.content_type === 'application/pdf' || /\.pdf$/i.test(a?.filename ?? ''),
    )
    if (!att || typeof att.size !== 'number' || att.size > MAX_PDF || typeof att.download_url !== 'string') return null
    // SSRF guard: only fetch from Resend's own https hosts.
    const u = new URL(att.download_url)
    if (u.protocol !== 'https:' || !(u.hostname === 'resend.com' || u.hostname.endsWith('.resend.com'))) return null
    const res = await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(20_000), redirect: 'error' })
    if (!res.ok) return null
    const data = Buffer.from(await res.arrayBuffer())
    if (data.length === 0 || data.length > MAX_PDF || data.subarray(0, 5).toString('latin1') !== '%PDF-') return null
    return { filename: String(att.filename ?? 'arve.pdf').slice(0, 200), contentType: 'application/pdf', data }
  },

  async pdfToText(data) {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(data))
    const { text } = await extractText(pdf, { mergePages: true })
    return String(text).slice(0, 20_000)
  },

  async llm({ system, user }) {
    const key = process.env.DEEPSEEK_API_KEY
    if (!key) throw new Error('DEEPSEEK_API_KEY missing')
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-chat',
        temperature: 0,
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`deepseek ${res.status}`)
    const j = await res.json()
    return String(j?.choices?.[0]?.message?.content ?? '')
  },
}

export const store: InboundStore = {
  async claim(m) {
    try {
      const row = await prisma.bill.create({
        data: { source: 'email', status: 'review', emailId: m.emailId, fromAddr: m.fromAddr, subject: m.subject },
        select: { id: true },
      })
      return row.id
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return null
      throw e
    }
  },
  async update(id, p) {
    await prisma.bill.update({
      where: { id },
      data: { ...p, dueDate: p.dueDate ? new Date(`${p.dueDate}T00:00:00Z`) : null },
    })
  },
  async saveFile(id, f) {
    await prisma.billFile.upsert({
      where: { billId: id },
      create: { billId: id, filename: f.filename, contentType: f.contentType, size: f.data.length, data: new Uint8Array(f.data) },
      update: {},
    })
  },
  async groups() {
    const g = await prisma.billGroup.findMany({ select: { id: true, keywords: true, sortOrder: true } })
    return g
  },
  async extractionsLast24h() {
    return prisma.bill.count({ where: { source: 'email', createdAt: { gte: new Date(Date.now() - 86_400_000) } } })
  },
}
