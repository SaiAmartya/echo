import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Echo — Pre-flight check for social posts",
  description:
    "Paste a draft. 200 agents, seeded from your real audience, run a 60-second simulated thread.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
