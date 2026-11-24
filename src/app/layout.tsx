import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getThemeColors } from "@/domain/profile";
import { readSitePage } from "@/server/site-page";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "may-be.gay",
    template: "%s · may-be.gay",
  },
  description: "A little space for your links, your interests, and yourself.",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { profile } = await readSitePage();
  const theme = profile?.document.theme;
  // Mobile Safari extends the document background behind its bars. Use the
  // gradient's start color at the top edge and the profile's solid fill otherwise.
  const backgroundColor = theme?.background?.kind === "gradient" ? theme.background.from
    : theme && getThemeColors(theme).background;

  return (
    <html lang="en" style={backgroundColor ? { backgroundColor } : undefined}>
      <body>{children}</body>
    </html>
  );
}
