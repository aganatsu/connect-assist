// Inlined corsHeaders — eliminates esm.sh /cors import to halve cold-start time
// Matches the exact headers from @supabase/supabase-js/cors
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-retry-count",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};
