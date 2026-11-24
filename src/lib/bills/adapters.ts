import 'server-only'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { MAX_PDF_BYTES, type BillIo, type InboundStore } from './inbound'

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

  // Cheapest stable Flash model with PDF input (verified with a live call 2026-11-24: ~830 in / ~160 out tokens per page).
  async pdfVision(data, { system, user }) {
    const key = process.env.GEMINI_API_KEY
    if (!key) throw new Error('GEMINI_API_KEY missing')
    if (data.length > MAX_PDF_BYTES) throw new Error('pdf too large')
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent', {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [
          {
            role: 'user',
            parts: [{ inlineData: { mimeType: 'application/pdf', data: data.toString('base64') } }, { text: user }],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 500,
          responseMimeType: 'application/json',
          // No paid thinking: field extraction does not need it.
          thinkingConfig: { thinkingLevel: 'minimal' },
        },
      }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error(`gemini ${res.status}`)
    const j = await res.json()
    const text = j?.candidates?.[0]?.content?.parts?.[0]?.text
    if (typeof text !== 'string' || !text) throw new Error('gemini empty')
    return text
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
