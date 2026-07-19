import React, { createContext, useContext, useEffect, useState } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  loading: true,
  signOut: async () => {},
});

export const useAuth = () => useContext(AuthContext);

function jwtHasSubject(token?: string): boolean {
  if (!token) return false;
  try {
    const payload = token.split(".")[1];
    if (!payload) return false;
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const claims = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
    return typeof claims?.sub === "string" && claims.sub.length > 0;
  } catch {
    return false;
  }
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      // Never expose a malformed persisted token to protected routes. Public
      // app keys are valid JWTs but intentionally have no user `sub` claim.
      setSession(session && jwtHasSubject(session.access_token) ? session : null);
    });

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session && jwtHasSubject(session.access_token)) {
        // Validate session against the server. If JWT is bad (e.g. missing sub),
        // sign out so the user can re-authenticate instead of being stuck.
        const { error } = await supabase.auth.getUser();
        if (error) {
          console.warn("[Auth] Invalid session detected, signing out:", error.message);
          await supabase.auth.signOut();
          try {
            // Belt-and-suspenders: purge any stale sb-* auth tokens so a
            // reload doesn't rehydrate the same bad JWT.
            Object.keys(localStorage)
              .filter((k) => k.startsWith("sb-") && k.endsWith("-auth-token"))
              .forEach((k) => localStorage.removeItem(k));
          } catch {}
          setSession(null);
          setLoading(false);
          return;
        }
      } else if (session) {
        await supabase.auth.signOut().catch(() => {});
        session = null;
      }
      setSession(session);
      setLoading(false);
    });

    return () => subscription.unsubscribe();
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user: session?.user ?? null, session, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};
