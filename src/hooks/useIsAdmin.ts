import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

/**
 * Whether the signed-in user is in app_admins. Only decides what the UI SHOWS;
 * the system-reset function re-checks admin server-side on every call.
 */
export function useIsAdmin(): boolean {
  const { data } = useQuery({
    queryKey: ["is-app-admin"],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as unknown as (fn: string) => Promise<{ data: unknown; error: unknown }>)("is_app_admin");
      return !error && data === true;
    },
    staleTime: 5 * 60_000,
  });
  return data === true;
}
