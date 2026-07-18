/**
 * Supabase Edge Function: generate-video
 * ========================================
 * Receives a prompt from the frontend, verifies the user's JWT via
 * Supabase's built-in auth helpers, then forwards the request to the
 * private GPU server — attaching the GPU_SERVER_API_KEY so the frontend
 * never sees it.
 *
 * Returns a `job_id` immediately so the frontend can start polling.
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
    // ---- Verify the caller's JWT ----
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing Authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create a Supabase client using the user's JWT to verify identity.
    // The ANON_KEY is safe to use here because we verify the JWT server-side.
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
    const { prompt } = await req.json();
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return new Response(
        JSON.stringify({ error: "A non-empty prompt is required." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ---- Forward to GPU server ----
    const gpuUrl = Deno.env.get("GPU_SERVER_URL")!;
    const gpuApiKey = Deno.env.get("GPU_SERVER_API_KEY")!;

    const gpuRes = await fetch(`${gpuUrl}/start-generation`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-gpu-api-key": gpuApiKey,
      },
      body: JSON.stringify({ prompt: prompt.trim() }),
    });

    if (!gpuRes.ok) {
      const errText = await gpuRes.text();
      console.error(`GPU server error: ${gpuRes.status} — ${errText}`);
      return new Response(
        JSON.stringify({ error: `GPU server returned ${gpuRes.status}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const gpuData = await gpuRes.json();

    // Return the job_id to the frontend
    return new Response(
      JSON.stringify({ success: true, jobId: gpuData.jobId }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("generate-video error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});