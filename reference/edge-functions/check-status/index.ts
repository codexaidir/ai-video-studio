/**
 * Supabase Edge Function: check-status
 * ======================================
 * Receives a `job_id` from the frontend, verifies the user's JWT,
 * then proxies the status check to the private GPU server.
 *
 * Returns: `{ status, progressLogs?, videoUrl?, error? }`
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  // ---- Handle CORS preflight ----
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // ---- Verify JWT ----
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Invalid or expired token" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ---- Parse body ----
    const { jobId } = await req.json();
    if (!jobId || typeof jobId !== "string") {
      return new Response(
        JSON.stringify({ error: "A valid jobId is required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ---- Proxy to GPU server ----
    const gpuUrl = Deno.env.get("GPU_SERVER_URL")!;
    const gpuApiKey = Deno.env.get("GPU_SERVER_API_KEY")!;

    const gpuRes = await fetch(`${gpuUrl}/status/${encodeURIComponent(jobId)}`, {
      method: "GET",
      headers: {
        "x-gpu-api-key": gpuApiKey,
      },
    });

    if (!gpuRes.ok) {
      const errText = await gpuRes.text();
      console.error(`GPU status error: ${gpuRes.status} — ${errText}`);
      return new Response(
        JSON.stringify({ error: `GPU server returned ${gpuRes.status}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const gpuData = await gpuRes.json();

    // Forward the GPU response straight to the frontend
    return new Response(JSON.stringify(gpuData), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("check-status error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});