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

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    // Tracks whether a live auth event (e.g. OAuth sign-in) already delivered a
    // session, so the slower initial getSession() check can never overwrite it.
    let sawAuthEvent = false;

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      sawAuthEvent = true;
      setSession(session);
      setLoading(false);
    });

    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!mounted) return;
      if (session) {
        // Validate session against the server. Only sign out when the server
        // explicitly rejects the token (401/403) — transient network failures
        // must not log a valid user out.
        const { error } = await supabase.auth.getUser();
        if (!mounted) return;
        const status = (error as { status?: number } | null)?.status;
        if (error && (status === 401 || status === 403)) {
          console.warn("[Auth] Invalid session detected, signing out:", error.message);
          await supabase.auth.signOut();
          if (!mounted) return;
          setSession(null);
          setLoading(false);
          return;
        }
      }
      if (sawAuthEvent) {
        // A newer auth event already set state; don't clobber it with this snapshot.
        setLoading(false);
        return;
      }
      setSession(session);
      setLoading(false);
    });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
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
