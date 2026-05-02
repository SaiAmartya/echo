import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { getFirebaseAuth } from "./client";

export type AuthUser = User;

export async function signInWithGoogle(): Promise<User> {
  const auth = getFirebaseAuth();
  const provider = new GoogleAuthProvider();
  const cred = await signInWithPopup(auth, provider);
  return cred.user;
}

export async function signInWithEmail(email: string, password: string): Promise<User> {
  const auth = getFirebaseAuth();
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function signUpWithEmail(email: string, password: string): Promise<User> {
  const auth = getFirebaseAuth();
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  return cred.user;
}

export async function signOut(): Promise<void> {
  await fbSignOut(getFirebaseAuth());
}

export function onAuthChange(cb: (user: User | null) => void): () => void {
  return onAuthStateChanged(getFirebaseAuth(), cb);
}

export async function getCurrentIdToken(): Promise<string | null> {
  const user = getFirebaseAuth().currentUser;
  if (!user) return null;
  return user.getIdToken();
}

export function friendlyAuthError(err: unknown): string {
  if (typeof err === "object" && err && "code" in err) {
    const code = String((err as { code: unknown }).code);
    switch (code) {
      case "auth/invalid-credential":
      case "auth/wrong-password":
      case "auth/user-not-found":
        return "Email or password is incorrect.";
      case "auth/email-already-in-use":
        return "An account with that email already exists.";
      case "auth/weak-password":
        return "Password must be at least 6 characters.";
      case "auth/invalid-email":
        return "That email address looks invalid.";
      case "auth/popup-closed-by-user":
        return "Sign-in popup was closed.";
      case "auth/network-request-failed":
        return "Network error — check your connection.";
      default:
        return code.replace(/^auth\//, "").replace(/-/g, " ");
    }
  }
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
