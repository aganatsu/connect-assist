import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";

const AuthCallback = () => {
  const navigate = useNavigate();
  const { user, loading, recheckSession } = useAuth();
  const recheckStarted = useRef(false);

  useEffect(() => {
    if (user) navigate("/", { replace: true });
  }, [user, navigate]);

  useEffect(() => {
    if (!loading && !user && !recheckStarted.current) {
      recheckStarted.current = true;
      void recheckSession();
    }
  }, [loading, user, recheckSession]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-primary" />
        <h1 className="text-xl font-semibold text-foreground">Completing sign in</h1>
        <p className="text-sm text-muted-foreground">Securely restoring your dashboard session…</p>
        {!loading && !user && (
          <Button variant="outline" onClick={() => {
            recheckStarted.current = false;
            void recheckSession();
          }}>
            Try again
          </Button>
        )}
      </div>
    </main>
  );
};

export default AuthCallback;