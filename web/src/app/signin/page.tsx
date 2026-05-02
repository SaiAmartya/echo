"use client";
// 00 — Auth (sign-in modal over a dimmed/blurred app shell)
// Ported from design/echo/project/lib/AuthModal.jsx (View06_Auth)

import { useRouter } from "next/navigation";
import { Frame } from "@/components/Shell";
import { Composer } from "@/components/Composer";
import { AuthModal } from "@/components/AuthModal";
import { SEED_DRAFT } from "@/components/SwarmThread";

export default function SignInPage() {
  const router = useRouter();
  return (
    <div style={{ position: "relative", minHeight: "100vh" }}>
      <div style={{ filter: "blur(2px) saturate(0.7)", opacity: 0.55, pointerEvents: "none" }}>
        <Frame topbarLabel="Compose" sidebarActive="compose">
          <div style={{ maxWidth: 760, margin: "0 auto" }}>
            <Composer
              draft={SEED_DRAFT}
              setDraft={() => {}}
              audience="Notion · 200 agents"
            />
          </div>
        </Frame>
      </div>
      <AuthModal mode="signin" onClose={() => router.push("/")} />
    </div>
  );
}
