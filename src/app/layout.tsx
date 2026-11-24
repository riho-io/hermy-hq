import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ConditionalLayout } from "@/components/conditional-layout";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { roleOf } from "@/lib/access";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist-sans" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono" });

export const metadata: Metadata = {
  title: "Hermy HQ",
  description: "Sinu juhtimiskeskus",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Bill guest gets the bills page only: no sidebar, palette or Argo banner (their APIs are owner-only anyway).
  const session = await getServerSession(authOptions);
  const bare = roleOf(session?.user?.email) === "bills_guest";
  return (
    <html lang="en" dir="ltr" className="dark">
      <body className={`${geist.variable} ${geistMono.variable} ${geist.className} bg-[#0a0a0a] text-white min-h-screen`}>
        <ConditionalLayout bare={bare}>{children}</ConditionalLayout>
      </body>
    </html>
  );
}
