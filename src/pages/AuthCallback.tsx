import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

const readOAuthParams = () => {
  const search = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const get = (key: string) => search.get(key) ?? hash.get(key);

  return {
    accessToken: get("access_token"),
    refreshToken: get("refresh_token"),
    code: get("code"),
    error: get("error_description") ?? get("error"),
  };
};

const AuthCallback = () => {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    const finishSignIn = async () => {
      const params = readOAuthParams();

      // Remove credentials and OAuth errors from browser history immediately.
      window.history.replaceState({}, document.title, "/auth/callback");

      if (params.error) {
        if (active) setError(params.error);
        return;
      }

      let authError: Error | null = null;
      if (params.accessToken && params.refreshToken) {
        const { error: setSessionError } = await supabase.auth.setSession({
          access_token: params.accessToken,
          refresh_token: params.refreshToken,
        });
        authError = setSessionError;
      } else if (params.code) {
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(params.code);
        authError = exchangeError;
      }

      if (authError) {
        if (active) setError(authError.message);
        return;
      }

      // The managed OAuth broker may persist the session before returning here.
      // Allow preview-backed storage enough time to finish synchronizing.
      for (let attempt = 0; attempt < 30 && active; attempt += 1) {
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          navigate("/", { replace: true });
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 200));
      }

      if (active) setError("Google sign-in completed, but the session could not be restored.");
    };

    void finishSignIn();
    return () => {
      active = false;
    };
  }, [navigate]);

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-4">
        <div className="w-full max-w-sm space-y-4 text-center">
          <h1 className="text-xl font-semibold text-foreground">Sign-in could not be completed</h1>
          <p className="text-sm text-muted-foreground">{error}</p>
          <Button onClick={() => navigate("/login", { replace: true })}>Return to sign in</Button>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background" aria-live="polite">
      <div className="space-y-3 text-center">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-muted border-b-primary" />
        <p className="text-sm text-muted-foreground">Completing Google sign-in…</p>
      </div>
    </main>
  );
};

export default AuthCallback;