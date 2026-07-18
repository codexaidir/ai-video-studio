'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabaseClient';
import {
  Film,
  LogOut,
  Send,
  Download,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RotateCcw,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function callEdgeFunction(
  functionName: string,
  body: Record<string, unknown>,
  accessToken: string,
): Promise<{ data: Record<string, unknown>; ok: boolean; status: number; errMsg?: string }> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const url = `${supabaseUrl}/functions/v1/${functionName}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    },
    body: JSON.stringify(body),
  });

  let data: Record<string, unknown> = {};
  try {
    data = await res.json();
  } catch {
    /* non-JSON response – ignore */
  }

  if (!res.ok) {
    return {
      data,
      ok: false,
      status: res.status,
      errMsg: (data as { error?: string }).error || `Edge function returned ${res.status}`,
    };
  }

  return { data, ok: true, status: res.status };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Dashboard() {
  const { user, signOut, session } = useAuth();

  // ---- State ----
  const [prompt, setPrompt] = useState('');
  const [processing, setProcessing] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [pollCount, setPollCount] = useState(0);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // ---- Generate Video ----
  const handleGenerate = useCallback(
    async (e?: React.FormEvent) => {
      e?.preventDefault();
      if (!prompt.trim() || processing) return;

      const token = session?.access_token;
      if (!token) {
        setErrorMsg('Authentication token not found. Please log in again.');
        return;
      }

      setProcessing(true);
      setErrorMsg(null);
      setVideoUrl(null);
      setPollCount(0);
      setStatusText('Initiating generation queue on GPU cluster…');

      try {
        const { data, ok, errMsg } = await callEdgeFunction(
          'generate-video',
          { prompt: prompt.trim() },
          token,
        );

        if (!ok) throw new Error(errMsg || 'Edge function error');

        const realJobId = data?.jobId as string | undefined;
        if (!realJobId) throw new Error('No jobId returned from GPU server');
        setJobId(realJobId);
        setStatusText('Request queued. Polling GPU node…');

        // Start polling
        pollRef.current = setInterval(async () => {
          setPollCount((c) => c + 1);
          try {
            // Re-read token in case it was refreshed
            const { data: sessionData } = await supabase.auth.getSession();
            const currentToken = sessionData.session?.access_token;
            if (!currentToken) {
              if (pollRef.current) clearInterval(pollRef.current);
              setErrorMsg('Session expired. Please log in again.');
              setProcessing(false);
              return;
            }

            const { data: sData, ok: sOk, errMsg: sErr } = await callEdgeFunction(
              'check-status',
              { jobId: realJobId },
              currentToken,
            );

            if (!sOk) {
              console.warn('Polling transient error:', sErr);
              setStatusText('Awaiting cluster response…');
              return;
            }

            const status = (sData?.status as string) || 'processing';
            const logs = (sData?.progressLogs as string) || 'GPU is rendering frames…';
            const url = sData?.videoUrl as string | undefined;

            setStatusText(logs);

            if (status === 'completed' && url) {
              if (pollRef.current) clearInterval(pollRef.current);
              setVideoUrl(url);
              setProcessing(false);
            } else if (status === 'failed') {
              if (pollRef.current) clearInterval(pollRef.current);
              setErrorMsg((sData?.error as string) || 'GPU rendering failed.');
              setProcessing(false);
            }
          } catch (err: unknown) {
            console.error('Polling error:', err);
          }
        }, POLL_INTERVAL_MS);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Could not connect to the remote GPU render node.';
        setErrorMsg(msg);
        setProcessing(false);
      }
    },
    [prompt, processing, session?.access_token],
  );

  // ---- Clear / Reset ----
  const handleClear = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    setVideoUrl(null);
    setJobId(null);
    setPrompt('');
    setErrorMsg(null);
    setProcessing(false);
    setStatusText('');
    setPollCount(0);
  }, []);

  // =========================================================================
  // RENDER
  // =========================================================================
  return (
    <div className="min-h-screen bg-[#0A0A0C] text-[#EDEDEF] flex flex-col">
      {/* Background accents */}
      <div className="absolute top-0 right-1/4 w-[400px] h-[400px] bg-purple-950/10 rounded-full blur-[140px] pointer-events-none" />
      <div className="absolute top-1/2 left-0 w-[350px] h-[350px] bg-indigo-950/8 rounded-full blur-[120px] pointer-events-none" />

      {/* ----------------------------------------------------------------- */}
      {/* Header                                                            */}
      {/* ----------------------------------------------------------------- */}
      <header className="sticky top-0 z-50 bg-[#0A0A0C]/85 backdrop-blur-md border-b border-[#1E1E24] px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          {/* Brand */}
          <div className="flex items-center gap-3">
            <div className="bg-gradient-to-tr from-purple-600 to-violet-600 p-2 rounded-xl text-white shadow-md shadow-purple-900/15">
              <Film className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white tracking-tight leading-none">
                AI Video Studio
              </h1>
              <span className="text-[10px] text-purple-400 font-mono">
                v1.2 // Stable Diffusion
              </span>
            </div>
          </div>

          {/* Right side */}
          <div className="flex items-center gap-4">
            {/* Live API badge */}
            <div className="hidden sm:flex items-center gap-2 bg-[#141418] border border-[#24242B] rounded-xl px-3 py-1.5 text-xs">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-gray-400">Live API</span>
            </div>

            {/* User email */}
            <div className="flex items-center gap-2 bg-[#121216] px-3 py-1.5 rounded-xl border border-[#1E1E24]">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs text-gray-300 font-mono max-w-[160px] truncate">
                {user?.email ?? ''}
              </span>
            </div>

            {/* Log out */}
            <button
              id="logout-btn"
              onClick={signOut}
              className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-[#1F1F24] hover:bg-red-950/20 hover:text-red-400 border border-[#2C2C35] hover:border-red-900/50 rounded-xl text-xs text-gray-300 transition-all cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden md:inline">Log Out</span>
            </button>
          </div>
        </div>
      </header>

      {/* ----------------------------------------------------------------- */}
      {/* Main workspace                                                    */}
      {/* ----------------------------------------------------------------- */}
      <main className="flex-grow max-w-7xl w-full mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-12 gap-8 z-10">
        {/* ---- Left column: Prompt form ---- */}
        <div className="lg:col-span-5 flex flex-col gap-6">
          <div className="bg-[#111114] border border-[#212128] rounded-2xl p-6 shadow-xl shadow-black/20">
            <h2 className="text-sm font-semibold tracking-wider text-gray-200 uppercase mb-4">
              Generate Video
            </h2>

            <form onSubmit={handleGenerate} className="space-y-5">
              {/* Prompt textarea */}
              <div>
                <label
                  className="block text-xs font-medium text-gray-400 mb-2"
                  htmlFor="prompt-input"
                >
                  CRAFT A DETAILED PROMPT
                </label>
                <textarea
                  id="prompt-input"
                  rows={6}
                  placeholder="Describe your cinematic video scene, including lighting, camera direction, motion…"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  disabled={processing}
                  className="w-full bg-[#17171C] border border-[#2D2D38] focus:border-purple-500 focus:ring-2 focus:ring-purple-500/30 rounded-xl p-4 text-sm text-white placeholder-gray-500 focus:outline-none transition-all resize-none leading-relaxed"
                />
                <div className="flex justify-between items-center mt-2 text-xs text-gray-500">
                  <span>Describe action / movement for better results</span>
                  <span className={prompt.length > 300 ? 'text-purple-400' : ''}>
                    {prompt.length} chars
                  </span>
                </div>
              </div>

              {/* Generate button */}
              <button
                id="generate-btn"
                type="submit"
                disabled={processing || !prompt.trim()}
                className="w-full py-4 px-5 bg-gradient-to-r from-purple-600 via-violet-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-medium rounded-xl text-sm transition-all focus:outline-none focus:ring-2 focus:ring-purple-500/50 shadow-lg shadow-purple-950/20 active:scale-[0.99] flex items-center justify-center gap-2 disabled:opacity-40 disabled:pointer-events-none cursor-pointer"
              >
                <Send className="w-4 h-4" />
                <span>{processing ? 'Queuing GPU Instance…' : 'Generate Video'}</span>
              </button>
            </form>
          </div>

          {/* GPU node info card */}
          <div className="bg-[#111114]/40 border border-[#212128]/50 rounded-2xl p-5 text-xs text-gray-400 space-y-3">
            <h3 className="font-semibold text-gray-300">GPU Node Info</h3>
            <p className="leading-relaxed">
              Prompts are proxied through Supabase Edge Functions to a private
              FastAPI server. Rendered .mp4 files are stored in Supabase Storage.
            </p>
            <div className="p-2.5 bg-black/40 rounded-lg border border-white/5 space-y-1 font-mono text-[10px]">
              <div className="flex justify-between">
                <span>Model:</span>
                <span className="text-purple-400">Stable Diffusion v1.5</span>
              </div>
              <div className="flex justify-between">
                <span>GPU:</span>
                <span className="text-emerald-400">NVIDIA RTX 3090 24GB</span>
              </div>
              <div className="flex justify-between">
                <span>Output:</span>
                <span className="text-gray-300">H.264 / 12 FPS / 512×512</span>
              </div>
            </div>
          </div>
        </div>

        {/* ---- Right column: Dynamic stage ---- */}
        <div className="lg:col-span-7 flex flex-col">
          <div className="bg-[#111114] border border-[#212128] rounded-2xl p-6 flex-grow flex flex-col justify-center min-h-[450px] shadow-xl shadow-black/20">

            {/* ====== IDLE STATE ====== */}
            {!processing && !videoUrl && !errorMsg && (
              <div className="text-center py-12 px-6 max-w-md mx-auto my-auto flex flex-col items-center">
                <div className="w-16 h-16 bg-[#16161B] border border-[#2E2E39] rounded-2xl flex items-center justify-center text-purple-400 mb-6 shadow-inner shadow-purple-500/5">
                  <Film className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold text-white mb-2">Ready to Render</h3>
                <p className="text-sm text-gray-400 leading-relaxed mb-6">
                  Write a detailed prompt on the left and click{' '}
                  <strong className="text-purple-400">Generate Video</strong> to
                  start the GPU rendering process.
                </p>
                <div className="text-xs text-purple-300/60 bg-purple-950/20 px-3 py-1.5 rounded-full border border-purple-900/30 font-mono">
                  No active generation queue
                </div>
              </div>
            )}

            {/* ====== PROCESSING STATE ====== */}
            {processing && (
              <div className="my-auto py-12 text-center flex flex-col items-center justify-center max-w-lg mx-auto">
                {/* Pulsing spinner rings */}
                <div className="relative w-24 h-24 mb-8">
                  <div className="absolute inset-0 bg-purple-600/20 rounded-full blur-xl animate-pulse" />
                  <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-purple-500 border-b-purple-500 animate-spin" />
                  <div className="absolute inset-2 rounded-full border border-transparent border-l-indigo-400 border-r-indigo-400 animate-spin [animation-duration:3s]" />
                  <div className="absolute inset-4 rounded-full bg-[#18181D] border border-[#2A2A33] flex items-center justify-center">
                    <Loader2 className="w-6 h-6 text-purple-400 animate-spin" />
                  </div>
                </div>

                <div className="space-y-4 w-full">
                  <div className="inline-flex items-center gap-2 bg-purple-950/30 border border-purple-800/40 text-purple-300 px-4 py-1.5 rounded-full text-xs font-mono font-medium">
                    <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-ping" />
                    GPU RENDERING WORKSPACE
                  </div>

                  <h3 className="text-lg font-bold text-white">
                    Rendering Cinematic Frames
                  </h3>

                  <p className="text-sm text-gray-400">
                    GPU is rendering… This takes 2–5 minutes.
                  </p>

                  {/* Live status log */}
                  <div className="bg-[#09090C] border border-[#22222A] rounded-xl p-4 font-mono text-[11px] text-gray-400 text-left space-y-1.5 shadow-inner">
                    <div className="flex justify-between border-b border-white/5 pb-1.5 text-gray-500">
                      <span>Status Queue Monitor</span>
                      <span>Job ID: {jobId || 'Allocating…'}</span>
                    </div>
                    <div className="text-purple-400 truncate">{statusText}</div>
                    <p className="text-[10px] text-gray-500 italic mt-2 text-center">
                      &quot;Do not close this tab while rendering.&quot;
                    </p>
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-gray-500 px-1 pt-1 font-mono">
                    <span>Poll interval: 5 s</span>
                    <span>Requests: {pollCount}</span>
                  </div>
                </div>
              </div>
            )}

            {/* ====== ERROR STATE ====== */}
            {errorMsg && !processing && (
              <div className="my-auto py-10 px-6 text-center flex flex-col items-center max-w-md mx-auto">
                <div className="w-16 h-16 bg-red-950/20 border border-red-900/40 rounded-2xl flex items-center justify-center text-red-400 mb-6">
                  <AlertTriangle className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold text-white mb-2">Generation Failed</h3>
                <p className="text-sm text-gray-400 leading-relaxed mb-6">{errorMsg}</p>
                <div className="flex gap-3">
                  <button
                    onClick={handleClear}
                    className="px-5 py-2.5 bg-[#1F1F26] border border-[#2F2F3D] hover:bg-[#2A2A35] rounded-xl text-xs text-white transition-all cursor-pointer"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => handleGenerate()}
                    className="px-5 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 text-xs font-medium text-white rounded-xl shadow-lg transition-all cursor-pointer hover:opacity-90"
                  >
                    Try Again
                  </button>
                </div>
              </div>
            )}

            {/* ====== SUCCESS / VIDEO PLAYER ====== */}
            {videoUrl && !processing && (
              <div className="flex flex-col h-full justify-between gap-6">
                {/* Header */}
                <div className="flex items-center justify-between border-b border-[#212128] pb-4">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                    <span className="text-xs font-semibold text-emerald-400 tracking-wider uppercase">
                      COMPLETED
                    </span>
                  </div>
                  <span className="text-[10px] text-gray-500 font-mono">
                    Job: {jobId?.slice(0, 12)}…
                  </span>
                </div>

                {/* Video player */}
                <div className="relative bg-black rounded-xl overflow-hidden border border-[#2D2D38] shadow-2xl flex-grow aspect-video flex items-center justify-center">
                  <video
                    id="output-video-player"
                    src={videoUrl}
                    controls
                    autoPlay
                    loop
                    playsInline
                    referrerPolicy="no-referrer"
                    className="w-full h-full object-contain"
                  />
                </div>

                {/* Prompt used */}
                <div className="bg-[#17171C] border border-[#23232C] rounded-xl p-4 text-xs">
                  <span className="text-gray-400 font-medium block mb-1">PROMPT USED</span>
                  <p className="text-gray-300 italic">&quot;{prompt}&quot;</p>
                </div>

                {/* Actions */}
                <div className="flex flex-wrap gap-4 items-center justify-between border-t border-[#212128] pt-4 mt-auto">
                  <a
                    id="download-video-link"
                    href={videoUrl}
                    download="generated-video.mp4"
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 px-5 py-3 bg-[#1A1A1E] hover:bg-[#25252B] border border-[#2E2E39] text-xs font-semibold text-white rounded-xl transition-all cursor-pointer"
                  >
                    <Download className="w-4 h-4 text-purple-400" />
                    Download Render (.mp4)
                  </a>

                  <button
                    id="generate-another-btn"
                    onClick={handleClear}
                    className="flex items-center gap-2 px-5 py-3 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-xs font-semibold text-white rounded-xl transition-all shadow-md shadow-purple-950/10 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Clear
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* ----------------------------------------------------------------- */}
      {/* Footer (sticky)                                                   */}
      {/* ----------------------------------------------------------------- */}
      <footer className="bg-[#070709] border-t border-[#141418] px-6 py-5 mt-auto">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between text-[11px] text-gray-500 gap-4">
          <span>
            Connected to FastAPI backend with Supabase client routing.
          </span>
          <div className="flex gap-4">
            <span className="hover:text-purple-400 transition-colors">
              Server Node: GPU-Node-01-RTX3090
            </span>
            <span>•</span>
            <span className="hover:text-purple-400 transition-colors">
              Storage: Supabase / generated-videos
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}