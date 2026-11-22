import 'server-only'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { BillIo, InboundStore } from './inbound'

export const io: BillIo = {
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
  async findDuplicate({ excludeId, supplier, amountCents, dueDate }) {
    const row = await prisma.bill.findFirst({
      where: {
        id: { not: excludeId },
        supplier: { equals: supplier, mode: 'insensitive' },
        amountCents,
        dueDate: new Date(`${dueDate}T00:00:00Z`),
        status: { in: ['new', 'review', 'paid'] },
      },
      select: { id: true },
    })
    return row !== null
  },
  async extractionsLast24h() {
    return prisma.bill.count({ where: { source: 'email', createdAt: { gte: new Date(Date.now() - 86_400_000) } } })
  },
}
