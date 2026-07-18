import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders })
  }

  try {
    // ── Auth ────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("Authorization")
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Missing Authorization header" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid or expired token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    // ── Parse body ──────────────────────────────────────────────────────
    const body = await req.json()
    const {
      image_url,
      prompt,
      negative_prompt = "",
      width = 1024,
      height = 1024,
      strength = 0.6,
      quality = "standard",
      seed,
    } = body

    if (!image_url || typeof image_url !== "string") {
      return new Response(JSON.stringify({ error: "image_url is required." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      return new Response(JSON.stringify({ error: "A non-empty prompt is required." }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      })
    }

    // ── Forward to GPU ──────────────────────────────────────────────────
    const gpuUrl = Deno.env.get("GPU_SERVER_URL")!
    const gpuApiKey = Deno.env.get("GPU_SERVER_API_KEY")!

    const gpuRes = await fetch(`${gpuUrl}/edit-image`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-gpu-api-key": gpuApiKey,
      },
      body: JSON.stringify({
        image_url,
        prompt: prompt.trim(),
        negative_prompt: negative_prompt || "",
        width: Number(width),
        height: Number(height),
        strength: Math.max(0.1, Math.min(0.95, Number(strength) || 0.6)),
        quality: quality || "standard",
        seed: seed ? Number(seed) : null,
      }),
    })

    if (!gpuRes.ok) {
      const errText = await gpuRes.text()
      console.error(`GPU edit-image error: ${gpuRes.status} — ${errText}`)
      return new Response(
        JSON.stringify({ error: `GPU server returned ${gpuRes.status}: ${errText.slice(0, 200)}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      )
    }

    const gpuData = await gpuRes.json()
    return new Response(JSON.stringify(gpuData), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  } catch (err) {
    console.error("edit-image error:", err)
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    })
  }
})