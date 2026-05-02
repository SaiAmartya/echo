"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AuthModal } from "@/components/AuthModal";
import { useAuth } from "@/components/auth/AuthProvider";

export default function SignUpPage() {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && user) router.replace("/compose");
  }, [user, loading, router]);

  return (
    <div style={{ position: "relative", minHeight: "100vh", background: "var(--bg-deep)" }}>
      <AuthModal mode="signup" redirectTo="/compose" />
    </div>
  );
}
