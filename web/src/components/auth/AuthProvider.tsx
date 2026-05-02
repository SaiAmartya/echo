"use client";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { User } from "firebase/auth";
import { onAuthChange, getCurrentIdToken } from "@/lib/firebase/auth";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  getIdToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Local-dev bypass — when NEXT_PUBLIC_DISABLE_AUTH=1 (mirrors the api's
// FIREBASE_AUTH_DISABLED=1), skip Firebase entirely and treat the session as
// signed-in. The api layer also bypasses verification under that flag, so a
// fake token round-trips fine. Production builds leave this off.
const AUTH_DISABLED = process.env.NEXT_PUBLIC_DISABLE_AUTH === "1";
const DEV_USER = {
  uid: "dev-local",
  email: "dev@local",
  emailVerified: true,
  isAnonymous: false,
  displayName: "dev",
  photoURL: null,
  providerId: "dev",
  // Minimal subset that AuthProvider consumers touch — anything else is unused.
  getIdToken: async () => "dev-local-token",
} as unknown as User;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(AUTH_DISABLED ? DEV_USER : null);
  const [loading, setLoading] = useState(!AUTH_DISABLED);

  useEffect(() => {
    if (AUTH_DISABLED) return; // dev-bypass: never touch Firebase
    const unsub = onAuthChange((u) => {
      setUser(u);
      setLoading(false);
    });
    return unsub;
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      getIdToken: AUTH_DISABLED
        ? async () => "dev-local-token"
        : getCurrentIdToken,
    }),
    [user, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
