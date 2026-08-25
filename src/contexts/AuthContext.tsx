import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

interface AuthContextType {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
  recheckSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  session: null,
  loading: true,
  signOut: async () => {},
  recheckSession: async () => {},
});

export const useAuth = () => useContext(AuthContext);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  const recheckSession = useCallback(async () => {
    setLoading(true);
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData.session) {
        setSession(null);
        return;
      }

      const { data: userData, error } = await supabase.auth.getUser();
      if (userData.user) {
        setSession({ ...sessionData.session, user: userData.user });
      } else if (!error) {
        setSession(null);
      }
      // Keep the last known session on transport errors. A temporary network or
      // preview-broker failure must never turn into an involuntary sign-out.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    let authRevision = 0;

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!active) return;
      authRevision += 1;
      setSession(nextSession);
      setLoading(false);
    });

    const bootstrapRevision = authRevision;
    void supabase.auth.getSession().then(async ({ data }) => {
      if (!active || authRevision !== bootstrapRevision) return;
      const initialSession = data.session;
      if (!initialSession) {
        setSession(null);
        setLoading(false);
        return;
      }

      const { data: verified } = await supabase.auth.getUser().catch(() => ({ data: { user: null } }));
      if (!active || authRevision !== bootstrapRevision) return;
      // Only expose a startup session after the auth server validates its user.
      // On a transport failure, retain it temporarily; authenticated requests
      // will validate the bearer without deleting the local session.
      setSession(verified.user ? { ...initialSession, user: verified.user } : initialSession);
      setLoading(false);
    }).catch(() => {
      if (active && authRevision === bootstrapRevision) setLoading(false);
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, []);


  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ user: session?.user ?? null, session, loading, signOut, recheckSession }}>
      {children}
    </AuthContext.Provider>
  );
};
