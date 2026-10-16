export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest) {
  const { draftId, tweetUrl } = await req.json();
  if (!draftId) return NextResponse.json({ error: "draftId required" }, { status: 400 });

  const draft = await prisma.draft.findUnique({ where: { id: draftId } });
  if (!draft) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const updateData: any = {
    status: "posted",
    postedAt: new Date(),
    postedUrl: tweetUrl || null,
  };

  // Try to fetch the actual posted tweet text via Grok API
  if (tweetUrl) {
    try {
      const apiKey = process.env.XAI_API_KEY || "";
      if (apiKey) {
        const payload = JSON.stringify({
          model: "grok-4-0709",
          tools: [{ type: "x_search" }],
          messages: [
            {
              role: "user",
              content: `Look up this exact tweet: ${tweetUrl}\n\nReturn ONLY the full tweet text, nothing else. No commentary, no quotes around it, just the raw tweet text exactly as posted.`
            }
          ]
        });

        const res = await fetch("https://api.x.ai/v1/responses", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: payload,
          signal: AbortSignal.timeout(30000),
        });
        const result = await res.text();

        const data = JSON.parse(result);
        // Responses API returns output_text or output array
        const text = data.output_text ||
          data.output?.find((o: { type: string }) => o.type === "message")?.content?.[0]?.text ||
          null;

        if (text && text.length > 5) {
          // postedText is not in the Prisma schema — include it in the response only
          const updated = await prisma.draft.update({
            where: { id: draftId },
            data: updateData,
          });

          const { feedbackRating, feedbackReason, updatedAt, ...rest } = updated as any;
          return NextResponse.json({
            ...rest,
            feedback: { rating: feedbackRating ?? null, reason: feedbackReason ?? "" },
            postedText: text.trim(),
          });
        }
      }
    } catch (e) {
      console.error("Failed to fetch posted tweet:", e);
    }
  }

  const updated = await prisma.draft.update({
    where: { id: draftId },
    data: updateData,
  });

  const { feedbackRating, feedbackReason, updatedAt, ...rest } = updated as any;
  return NextResponse.json({
    ...rest,
    feedback: { rating: feedbackRating ?? null, reason: feedbackReason ?? "" },
    postedText: null,
  });
}
