import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { ThemeProvider } from "next-themes";

// Geist is bundled with the app (npm package "geist"), so the build never needs
// to reach Google Fonts and the finished site works fully offline.
const geistSans = GeistSans;
const geistMono = GeistMono;

// Matches basePath in next.config.ts (needed on GitHub Pages project sites).
const rawBasePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").trim();
const basePath =
  rawBasePath && rawBasePath !== "/" ? `/${rawBasePath.replace(/^\/+|\/+$/g, "")}` : "";

export const metadata: Metadata = {
  title: "Openmukti Audiobook Creator — Local AI TTS & Media Suite",
  description:
    "Fully local AI text-to-speech, file conversion, OCR, audiobook and video suite. No uploads, no cloud — everything is processed on your machine.",
  keywords: ["local TTS", "offline speech synthesis", "audiobook generator", "OCR", "video editor", "no upload"],
  authors: [{ name: "Openmukti Audiobook Creator" }],
  icons: { icon: `${basePath}/logo.svg` },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
