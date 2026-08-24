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
    // Tracks whether a live auth event (e.g. OAuth sign-in) already delivered a
    // session. The slower initial getSession() check must never clobber it.
    let liveSession: Session | null = null;
    let sawLiveEvent = false;

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      // Never expose a malformed persisted token to protected routes. Public
      // app keys are valid JWTs but intentionally have no user `sub` claim.
      const next = session && jwtHasSubject(session.access_token) ? session : null;
      sawLiveEvent = true;
      liveSession = next;
      setSession(next);
      setLoading(false);
    });

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session && jwtHasSubject(session.access_token)) {
        // Validate session against the server. Only a definitive rejection may
        // sign the user out — a network blip must not destroy a fresh login.
        const { error } = await supabase.auth
          .getUser()
          .catch(() => ({ error: new Error("network error") } as any));
        const transient = !!error &&
          /network|fetch|timeout|failed to fetch/i.test(error.message ?? "");
        if (error && !transient && !(sawLiveEvent && liveSession)) {
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
        if (!(sawLiveEvent && liveSession)) await supabase.auth.signOut().catch(() => {});
        session = null;
      }
      // A sign-in that landed while this check was in flight wins.
      if (sawLiveEvent) {
        setSession(liveSession);
      } else {
        setSession(session);
      }
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
