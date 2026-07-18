'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '@/context/AuthContext';
import { supabase } from '@/lib/supabaseClient';
import {
  Film,
  Image as ImageIcon,
  LogOut,
  Send,
  Download,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Upload,
  Pencil,
  Sparkles,
  Zap,
  Gem,
  X,
  ChevronDown,
  Settings2,
  Trash2,
  ImagePlus,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 5_000;

const IMAGE_SIZES = [
  { label: 'Square (1:1)', w: 1024, h: 1024 },
  { label: 'Landscape (16:9)', w: 1344, h: 768 },
  { label: 'Portrait (9:16)', w: 768, h: 1344 },
  { label: 'Photo (4:3)', w: 1152, h: 896 },
  { label: 'Tall (3:4)', w: 896, h: 1152 },
  { label: 'Ultra Wide (2.4:1)', w: 1536, h: 640 },
  { label: 'Phone (9:19)', w: 640, h: 1344 },
] as const;

const QUALITY_PRESETS = [
  { id: 'speed', label: 'Speed', icon: Zap, desc: '~5 s', color: 'text-emerald-400 border-emerald-500/30 bg-emerald-950/20' },
  { id: 'standard', label: 'Standard', icon: Sparkles, desc: '~15 s', color: 'text-purple-400 border-purple-500/30 bg-purple-950/20' },
  { id: 'hq', label: 'HQ', icon: Gem, desc: '~30 s', color: 'text-amber-400 border-amber-500/30 bg-amber-950/20' },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function callEdgeFunction(
  functionName: string,
  body: Record<string, unknown>,
  accessToken: string,
  timeoutMs = 120_000,
): Promise<{ data: Record<string, unknown>; ok: boolean; errMsg?: string }> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        apikey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    let data: Record<string, unknown> = {};
    try { data = await res.json(); } catch { /* non-JSON */ }

    if (!res.ok) {
      return { data, ok: false, errMsg: (data as { error?: string }).error || `Edge function returned ${res.status}` };
    }
    return { data, ok: true };
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { data: {}, ok: false, errMsg: 'Request timed out. Try a lower quality or smaller size.' };
    }
    return { data: {}, ok: false, errMsg: err instanceof Error ? err.message : 'Network error' };
  } finally {
    clearTimeout(timer);
  }
}

async function uploadImageToStorage(file: File, userId: string): Promise<string> {
  const ext = file.name.split('.').pop() || 'png';
  const path = `uploads/${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from('generated-videos').upload(path, file, {
    cacheControl: '3600',
    upsert: false,
  });
  if (error) throw new Error(error.message);
  const { data } = supabase.storage.from('generated-videos').getPublicUrl(path);
  return data.publicUrl;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Mode = 'image' | 'video';
type ImageTab = 'generate' | 'edit';

export default function Dashboard() {
  const { user, signOut, session } = useAuth();

  // ---- Global State ----
  const [mode, setMode] = useState<Mode>('image');
  const [imageTab, setImageTab] = useState<ImageTab>('generate');

  // ---- Image Generation State ----
  const [imgPrompt, setImgPrompt] = useState('');
  const [imgNegPrompt, setImgNegPrompt] = useState('');
  const [imgShowNeg, setImgShowNeg] = useState(false);
  const [imgSizeIdx, setImgSizeIdx] = useState(0);
  const [imgQuality, setImgQuality] = useState<string>('standard');
  const [imgGenerating, setImgGenerating] = useState(false);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [imgMeta, setImgMeta] = useState<{ width: number; height: number; model: string } | null>(null);
  const [imgError, setImgError] = useState<string | null>(null);

  // ---- Image Edit State ----
  const [editUploadUrl, setEditUploadUrl] = useState<string | null>(null);
  const [editUploadName, setEditUploadName] = useState<string>('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editNegPrompt, setEditNegPrompt] = useState('');
  const [editShowNeg, setEditShowNeg] = useState(false);
  const [editSizeIdx, setEditSizeIdx] = useState(0);
  const [editStrength, setEditStrength] = useState(0.6);
  const [editQuality, setEditQuality] = useState<string>('standard');
  const [editGenerating, setEditGenerating] = useState(false);
  const [editResultUrl, setEditResultUrl] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [editUploading, setEditUploading] = useState(false);

  // ---- Video State ----
  const [vidPrompt, setVidPrompt] = useState('');
  const [vidProcessing, setVidProcessing] = useState(false);
  const [vidStatusText, setVidStatusText] = useState('');
  const [vidJobId, setVidJobId] = useState<string | null>(null);
  const [vidError, setVidError] = useState<string | null>(null);
  const [vidUrl, setVidUrl] = useState<string | null>(null);
  const [vidPollCount, setVidPollCount] = useState(0);
  const vidPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => { if (vidPollRef.current) clearInterval(vidPollRef.current); };
  }, []);

  // ---- Image Generate ----
  const handleImageGenerate = useCallback(async () => {
    if (!imgPrompt.trim() || imgGenerating) return;
    const token = session?.access_token;
    if (!token) { setImgError('Session expired. Please log in again.'); return; }

    setImgGenerating(true);
    setImgError(null);
    setImgUrl(null);
    setImgMeta(null);

    const size = IMAGE_SIZES[imgSizeIdx];
    const { data, ok, errMsg } = await callEdgeFunction(
      'generate-image',
      {
        prompt: imgPrompt.trim(),
        negative_prompt: imgNegPrompt.trim(),
        width: size.w,
        height: size.h,
        quality: imgQuality,
      },
      token,
      imgQuality === 'hq' ? 180_000 : 120_000,
    );

    setImgGenerating(false);
    if (!ok) {
      setImgError(errMsg || 'Image generation failed.');
    } else {
      setImgUrl(data.imageUrl as string);
      setImgMeta({ width: size.w, height: size.h, model: (data.model as string) || 'sdxl' });
    }
  }, [imgPrompt, imgNegPrompt, imgSizeIdx, imgQuality, imgGenerating, session?.access_token]);

  // ---- Image Edit ----
  const handleEditGenerate = useCallback(async () => {
    if (!editPrompt.trim() || !editUploadUrl || editGenerating) return;
    const token = session?.access_token;
    if (!token) { setEditError('Session expired. Please log in again.'); return; }

    setEditGenerating(true);
    setEditError(null);
    setEditResultUrl(null);

    const size = IMAGE_SIZES[editSizeIdx];
    const { data, ok, errMsg } = await callEdgeFunction(
      'edit-image',
      {
        image_url: editUploadUrl,
        prompt: editPrompt.trim(),
        negative_prompt: editNegPrompt.trim(),
        width: size.w,
        height: size.h,
        strength: editStrength,
        quality: editQuality,
      },
      token,
      editQuality === 'hq' ? 180_000 : 120_000,
    );

    setEditGenerating(false);
    if (!ok) {
      setEditError(errMsg || 'Image editing failed.');
    } else {
      setEditResultUrl(data.imageUrl as string);
    }
  }, [editPrompt, editNegPrompt, editUploadUrl, editSizeIdx, editStrength, editQuality, editGenerating, session?.access_token]);

  // ---- Image Upload ----
  const handleImageUpload = useCallback(async (file: File) => {
    if (!user?.id || !session?.access_token) return;
    setEditUploading(true);
    setEditError(null);
    try {
      const url = await uploadImageToStorage(file, user.id);
      setEditUploadUrl(url);
      setEditUploadName(file.name);
    } catch (err: unknown) {
      setEditError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setEditUploading(false);
    }
  }, [user?.id, session?.access_token]);

  // ---- Video Generate ----
  const handleVideoGenerate = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!vidPrompt.trim() || vidProcessing) return;
    const token = session?.access_token;
    if (!token) { setVidError('Session expired. Please log in again.'); return; }

    setVidProcessing(true);
    setVidError(null);
    setVidUrl(null);
    setVidPollCount(0);
    setVidStatusText('Initiating generation queue on GPU cluster…');

    try {
      const { data, ok, errMsg } = await callEdgeFunction('generate-video', { prompt: vidPrompt.trim() }, token);

      if (!ok) throw new Error(errMsg || 'Edge function error');
      const realJobId = data?.jobId as string | undefined;
      if (!realJobId) throw new Error('No jobId returned from GPU server');
      setVidJobId(realJobId);
      setVidStatusText('Request queued. Polling GPU node…');

      vidPollRef.current = setInterval(async () => {
        setVidPollCount((c) => c + 1);
        try {
          const { data: sData } = await supabase.auth.getSession();
          const curToken = sData.session?.access_token;
          if (!curToken) {
            if (vidPollRef.current) clearInterval(vidPollRef.current);
            setVidError('Session expired.'); setVidProcessing(false); return;
          }
          const { data: pollData, ok: pOk, errMsg: pErr } = await callEdgeFunction('check-status', { jobId: realJobId }, curToken);
          if (!pOk) { setVidStatusText('Awaiting cluster response…'); return; }
          const status = (pollData?.status as string) || 'processing';
          const logs = (pollData?.progressLogs as string) || 'GPU is rendering frames…';
          const url = pollData?.videoUrl as string | undefined;
          setVidStatusText(logs);
          if (status === 'completed' && url) {
            if (vidPollRef.current) clearInterval(vidPollRef.current);
            setVidUrl(url); setVidProcessing(false);
          } else if (status === 'failed') {
            if (vidPollRef.current) clearInterval(vidPollRef.current);
            setVidError((pollData?.error as string) || 'GPU rendering failed.'); setVidProcessing(false);
          }
        } catch (err) { console.error('Polling error:', err); }
      }, POLL_INTERVAL_MS);
    } catch (err: unknown) {
      setVidError(err instanceof Error ? err.message : 'Connection failed.');
      setVidProcessing(false);
    }
  }, [vidPrompt, vidProcessing, session?.access_token]);

  // ---- Clear helpers ----
  const clearImage = () => { setImgUrl(null); setImgMeta(null); setImgError(null); };
  const clearEdit = () => {
    setEditUploadUrl(null); setEditUploadName(''); setEditResultUrl(null);
    setEditError(null); setEditPrompt('');
  };
  const clearVideo = () => {
    if (vidPollRef.current) clearInterval(vidPollRef.current);
    setVidUrl(null); setVidJobId(null); setVidPrompt('');
    setVidError(null); setVidProcessing(false); setVidStatusText(''); setVidPollCount(0);
  };

  // =========================================================================
  // RENDER
  // =========================================================================

  const selectedImgSize = IMAGE_SIZES[imgSizeIdx];
  const selectedEditSize = IMAGE_SIZES[editSizeIdx];

  return (
    <div className="min-h-screen bg-[#0A0A0C] text-[#EDEDEF] flex flex-col">
      {/* BG accents */}
      <div className="absolute top-0 right-1/4 w-[400px] h-[400px] bg-purple-950/10 rounded-full blur-[140px] pointer-events-none" />
      <div className="absolute top-1/2 left-0 w-[350px] h-[350px] bg-indigo-950/8 rounded-full blur-[120px] pointer-events-none" />

      {/* ----------------------------------------------------------------- */}
      {/* Header                                                            */}
      {/* ----------------------------------------------------------------- */}
      <header className="sticky top-0 z-50 bg-[#0A0A0C]/85 backdrop-blur-md border-b border-[#1E1E24] px-4 sm:px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="bg-gradient-to-tr from-purple-600 to-violet-600 p-2 rounded-xl text-white shadow-md shadow-purple-900/15">
              <Film className="w-5 h-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold text-white tracking-tight leading-none">AI Studio</h1>
              <span className="text-[10px] text-purple-400 font-mono">v2.0 // SDXL + SD 1.5</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden sm:flex items-center gap-2 bg-[#141418] border border-[#24242B] rounded-xl px-3 py-1.5 text-xs">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-gray-400">Live API</span>
            </div>
            <div className="flex items-center gap-2 bg-[#121216] px-3 py-1.5 rounded-xl border border-[#1E1E24]">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span className="text-xs text-gray-300 font-mono max-w-[140px] truncate">{user?.email ?? ''}</span>
            </div>
            <button onClick={signOut} className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-[#1F1F24] hover:bg-red-950/20 hover:text-red-400 border border-[#2C2C35] hover:border-red-900/50 rounded-xl text-xs text-gray-300 transition-all cursor-pointer">
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden md:inline">Log Out</span>
            </button>
          </div>
        </div>
      </header>

      {/* ----------------------------------------------------------------- */}
      {/* Main                                                              */}
      {/* ----------------------------------------------------------------- */}
      <main className="flex-grow max-w-7xl w-full mx-auto px-4 sm:px-6 py-6 z-10">
        {/* ── Mode Selector ─────────────────────────────────────────────── */}
        <div className="flex gap-2 mb-6">
          {([['image', 'Image Generation', ImageIcon], ['video', 'Video Generation', Film]] as const).map(([m, label, Icon]) => (
            <button
              key={m}
              onClick={() => setMode(m as Mode)}
              className={`flex items-center gap-2.5 px-5 py-3 rounded-xl text-sm font-medium transition-all cursor-pointer border ${
                mode === m
                  ? 'bg-purple-600/15 border-purple-500/40 text-purple-300'
                  : 'bg-[#111114] border-[#212128] text-gray-400 hover:text-gray-200 hover:border-[#2E2E39]'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>

        {/* ================================================================ */}
        {/* IMAGE MODE                                                       */}
        {/* ================================================================ */}
        {mode === 'image' && (
          <>
            {/* ── Image Sub-tabs ─────────────────────────────────────────── */}
            <div className="flex gap-2 mb-6">
              {([['generate', 'Generate', Sparkles], ['edit', 'Edit Image', Pencil]] as const).map(([t, label, Icon]) => (
                <button
                  key={t}
                  onClick={() => setImageTab(t as ImageTab)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium transition-all cursor-pointer border ${
                    imageTab === t
                      ? 'bg-violet-600/15 border-violet-500/40 text-violet-300'
                      : 'bg-[#111114]/60 border-[#212128]/60 text-gray-500 hover:text-gray-300'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  {label}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
              {/* ── Left Column: Form ───────────────────────────────────── */}
              <div className="lg:col-span-5 flex flex-col gap-5">
                {imageTab === 'generate' ? (
                  /* ============ IMAGE GENERATE FORM ============ */
                  <div className="bg-[#111114] border border-[#212128] rounded-2xl p-5 shadow-xl shadow-black/20 space-y-5">
                    <h2 className="text-sm font-semibold tracking-wider text-gray-200 uppercase">Generate Image</h2>

                    {/* Prompt */}
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-2" htmlFor="img-prompt">PROMPT</label>
                      <textarea id="img-prompt" rows={4} placeholder="Describe your image in detail…"
                        value={imgPrompt} onChange={(e) => setImgPrompt(e.target.value)} disabled={imgGenerating}
                        className="w-full bg-[#17171C] border border-[#2D2D38] focus:border-purple-500 focus:ring-2 focus:ring-purple-500/30 rounded-xl p-3.5 text-sm text-white placeholder-gray-500 focus:outline-none transition-all resize-none leading-relaxed"
                      />
                    </div>

                    {/* Negative prompt (collapsible) */}
                    <div>
                      <button type="button" onClick={() => setImgShowNeg(!imgShowNeg)} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors cursor-pointer">
                        <Settings2 className="w-3 h-3" />
                        Negative Prompt
                        <ChevronDown className={`w-3 h-3 transition-transform ${imgShowNeg ? 'rotate-180' : ''}`} />
                      </button>
                      {imgShowNeg && (
                        <textarea rows={2} placeholder="What to avoid… (optional)"
                          value={imgNegPrompt} onChange={(e) => setImgNegPrompt(e.target.value)} disabled={imgGenerating}
                          className="mt-2 w-full bg-[#17171C] border border-[#2D2D38] focus:border-purple-500 focus:ring-2 focus:ring-purple-500/30 rounded-xl p-3.5 text-sm text-white placeholder-gray-500 focus:outline-none transition-all resize-none"
                        />
                      )}
                    </div>

                    {/* Size selector */}
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-2">SIZE</label>
                      <select value={imgSizeIdx} onChange={(e) => setImgSizeIdx(Number(e.target.value))} disabled={imgGenerating}
                        className="w-full bg-[#17171C] border border-[#2D2D38] rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500 transition-all appearance-none cursor-pointer">
                        {IMAGE_SIZES.map((s, i) => (
                          <option key={i} value={i}>{s.label} — {s.w} × {s.h}</option>
                        ))}
                      </select>
                    </div>

                    {/* Quality presets */}
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-2">QUALITY</label>
                      <div className="grid grid-cols-3 gap-2">
                        {QUALITY_PRESETS.map((q) => (
                          <button key={q.id} onClick={() => setImgQuality(q.id)} disabled={imgGenerating}
                            className={`flex flex-col items-center gap-1 px-3 py-2.5 rounded-xl border text-center transition-all cursor-pointer ${
                              imgQuality === q.id ? q.color : 'border-[#2D2D38] text-gray-500 hover:text-gray-300'
                            }`}>
                            <q.icon className="w-4 h-4" />
                            <span className="text-[11px] font-semibold">{q.label}</span>
                            <span className="text-[9px] opacity-60">{q.desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Generate button */}
                    <button id="gen-img-btn" onClick={handleImageGenerate} disabled={imgGenerating || !imgPrompt.trim()}
                      className="w-full py-3.5 px-5 bg-gradient-to-r from-purple-600 via-violet-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-medium rounded-xl text-sm transition-all focus:outline-none focus:ring-2 focus:ring-purple-500/50 shadow-lg shadow-purple-950/20 active:scale-[0.99] flex items-center justify-center gap-2 disabled:opacity-40 disabled:pointer-events-none cursor-pointer">
                      {imgGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <ImagePlus className="w-4 h-4" />}
                      <span>{imgGenerating ? 'Generating…' : 'Generate Image'}</span>
                    </button>
                  </div>
                ) : (
                  /* ============ IMAGE EDIT FORM ============ */
                  <div className="bg-[#111114] border border-[#212128] rounded-2xl p-5 shadow-xl shadow-black/20 space-y-5">
                    <h2 className="text-sm font-semibold tracking-wider text-gray-200 uppercase">Edit Image</h2>

                    {/* Upload area */}
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-2">SOURCE IMAGE</label>
                      {!editUploadUrl ? (
                        <label className="flex flex-col items-center justify-center w-full h-36 border-2 border-dashed border-[#2D2D38] hover:border-purple-500/50 rounded-xl cursor-pointer transition-all bg-[#0E0E12] hover:bg-purple-950/10 group">
                          {editUploading ? (
                            <Loader2 className="w-6 h-6 text-purple-400 animate-spin mb-2" />
                          ) : (
                            <Upload className="w-6 h-6 text-gray-500 group-hover:text-purple-400 transition-colors mb-2" />
                          )}
                          <span className="text-xs text-gray-500 group-hover:text-gray-300">
                            {editUploading ? 'Uploading…' : 'Click or drag to upload'}
                          </span>
                          <span className="text-[10px] text-gray-600 mt-1">PNG, JPG, WEBP — max 10 MB</span>
                          <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleImageUpload(f); }} />
                        </label>
                      ) : (
                        <div className="relative rounded-xl overflow-hidden border border-[#2D2D38] bg-black">
                          <img src={editUploadUrl} alt="Source" className="w-full h-36 object-contain" />
                          <button onClick={() => { setEditUploadUrl(null); setEditUploadName(''); }}
                            className="absolute top-2 right-2 p-1.5 bg-black/60 hover:bg-red-900/60 rounded-lg transition-colors cursor-pointer">
                            <X className="w-3.5 h-3.5 text-white" />
                          </button>
                          <div className="absolute bottom-0 inset-x-0 bg-black/50 px-3 py-1.5">
                            <span className="text-[10px] text-gray-300 truncate block">{editUploadName}</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Edit prompt */}
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-2" htmlFor="edit-prompt">EDIT PROMPT</label>
                      <textarea id="edit-prompt" rows={3} placeholder="Describe what changes you want…"
                        value={editPrompt} onChange={(e) => setEditPrompt(e.target.value)} disabled={editGenerating}
                        className="w-full bg-[#17171C] border border-[#2D2D38] focus:border-purple-500 focus:ring-2 focus:ring-purple-500/30 rounded-xl p-3.5 text-sm text-white placeholder-gray-500 focus:outline-none transition-all resize-none"
                      />
                    </div>

                    {/* Negative prompt */}
                    <div>
                      <button type="button" onClick={() => setEditShowNeg(!editShowNeg)} className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors cursor-pointer">
                        <Settings2 className="w-3 h-3" /> Negative Prompt
                        <ChevronDown className={`w-3 h-3 transition-transform ${editShowNeg ? 'rotate-180' : ''}`} />
                      </button>
                      {editShowNeg && (
                        <textarea rows={2} placeholder="What to avoid…"
                          value={editNegPrompt} onChange={(e) => setEditNegPrompt(e.target.value)} disabled={editGenerating}
                          className="mt-2 w-full bg-[#17171C] border border-[#2D2D38] rounded-xl p-3.5 text-sm text-white placeholder-gray-500 focus:outline-none transition-all resize-none"
                        />
                      )}
                    </div>

                    {/* Strength slider */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-xs font-medium text-gray-400">EDIT STRENGTH</label>
                        <span className="text-xs font-mono text-purple-400">{editStrength.toFixed(2)}</span>
                      </div>
                      <input type="range" min="0.1" max="0.95" step="0.05" value={editStrength}
                        onChange={(e) => setEditStrength(Number(e.target.value))} disabled={editGenerating}
                        className="w-full accent-purple-500 cursor-pointer" />
                      <div className="flex justify-between text-[9px] text-gray-600 mt-1">
                        <span>Subtle</span><span>Transform</span>
                      </div>
                    </div>

                    {/* Size */}
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-2">OUTPUT SIZE</label>
                      <select value={editSizeIdx} onChange={(e) => setEditSizeIdx(Number(e.target.value))} disabled={editGenerating}
                        className="w-full bg-[#17171C] border border-[#2D2D38] rounded-xl px-3.5 py-2.5 text-sm text-white focus:outline-none focus:border-purple-500 transition-all appearance-none cursor-pointer">
                        {IMAGE_SIZES.map((s, i) => (
                          <option key={i} value={i}>{s.label} — {s.w} × {s.h}</option>
                        ))}
                      </select>
                    </div>

                    {/* Quality */}
                    <div>
                      <label className="block text-xs font-medium text-gray-400 mb-2">QUALITY</label>
                      <div className="grid grid-cols-3 gap-2">
                        {QUALITY_PRESETS.map((q) => (
                          <button key={q.id} onClick={() => setEditQuality(q.id)} disabled={editGenerating}
                            className={`flex flex-col items-center gap-1 px-3 py-2.5 rounded-xl border text-center transition-all cursor-pointer ${
                              editQuality === q.id ? q.color : 'border-[#2D2D38] text-gray-500 hover:text-gray-300'
                            }`}>
                            <q.icon className="w-4 h-4" />
                            <span className="text-[11px] font-semibold">{q.label}</span>
                            <span className="text-[9px] opacity-60">{q.desc}</span>
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Edit button */}
                    <button onClick={handleEditGenerate} disabled={editGenerating || !editPrompt.trim() || !editUploadUrl}
                      className="w-full py-3.5 px-5 bg-gradient-to-r from-purple-600 via-violet-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-medium rounded-xl text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:pointer-events-none cursor-pointer">
                      {editGenerating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Pencil className="w-4 h-4" />}
                      <span>{editGenerating ? 'Editing…' : 'Edit Image'}</span>
                    </button>
                  </div>
                )}

                {/* GPU Info card */}
                <div className="bg-[#111114]/40 border border-[#212128]/50 rounded-2xl p-4 text-xs text-gray-400 space-y-2">
                  <h3 className="font-semibold text-gray-300">Pipeline Info</h3>
                  <div className="p-2.5 bg-black/40 rounded-lg border border-white/5 space-y-1 font-mono text-[10px]">
                    <div className="flex justify-between"><span>Image Model:</span><span className="text-purple-400">SDXL + Refiner</span></div>
                    <div className="flex justify-between"><span>Video Model:</span><span className="text-emerald-400">SD 1.5</span></div>
                    <div className="flex justify-between"><span>GPU:</span><span className="text-emerald-400">NVIDIA RTX 3090 24GB</span></div>
                    <div className="flex justify-between"><span>Safety:</span><span className="text-red-400">Disabled</span></div>
                  </div>
                </div>
              </div>

              {/* ── Right Column: Result ────────────────────────────────── */}
              <div className="lg:col-span-7">
                <div className="bg-[#111114] border border-[#212128] rounded-2xl p-5 min-h-[500px] flex flex-col shadow-xl shadow-black/20">

                  {/* ---- IMAGE GENERATE RESULT ---- */}
                  {imageTab === 'generate' && (
                    <>
                      {imgGenerating && (
                        <div className="my-auto flex flex-col items-center justify-center py-16">
                          <div className="relative w-20 h-20 mb-6">
                            <div className="absolute inset-0 bg-purple-600/20 rounded-full blur-xl animate-pulse" />
                            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-purple-500 border-b-purple-500 animate-spin" />
                            <div className="absolute inset-3 rounded-full bg-[#18181D] border border-[#2A2A33] flex items-center justify-center">
                              <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
                            </div>
                          </div>
                          <div className="inline-flex items-center gap-2 bg-purple-950/30 border border-purple-800/40 text-purple-300 px-4 py-1.5 rounded-full text-xs font-mono mb-3">
                            <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-ping" />
                            SDXL {imgQuality === 'hq' ? '+ REFINER' : imgQuality === 'standard' ? 'STANDARD' : 'SPEED'}
                          </div>
                          <h3 className="text-base font-bold text-white mb-1">Generating Image</h3>
                          <p className="text-sm text-gray-400">{selectedImgSize.w} × {selectedImgSize.h} • {imgQuality}</p>
                        </div>
                      )}

                      {imgError && !imgGenerating && (
                        <div className="my-auto flex flex-col items-center justify-center py-16 text-center">
                          <div className="w-14 h-14 bg-red-950/20 border border-red-900/40 rounded-2xl flex items-center justify-center text-red-400 mb-4">
                            <AlertTriangle className="w-6 h-6" />
                          </div>
                          <h3 className="text-base font-bold text-white mb-2">Generation Failed</h3>
                          <p className="text-sm text-gray-400 mb-5 max-w-sm">{imgError}</p>
                          <div className="flex gap-3">
                            <button onClick={clearImage} className="px-4 py-2 bg-[#1F1F26] border border-[#2F2F3D] rounded-xl text-xs text-white cursor-pointer hover:bg-[#2A2A35]">Clear</button>
                            <button onClick={handleImageGenerate} className="px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-xs font-medium text-white rounded-xl cursor-pointer hover:opacity-90">Try Again</button>
                          </div>
                        </div>
                      )}

                      {!imgGenerating && !imgError && !imgUrl && (
                        <div className="my-auto flex flex-col items-center justify-center py-16 text-center">
                          <div className="w-14 h-14 bg-[#16161B] border border-[#2E2E39] rounded-2xl flex items-center justify-center text-purple-400 mb-5">
                            <ImageIcon className="w-6 h-6" />
                          </div>
                          <h3 className="text-base font-bold text-white mb-2">Image Studio</h3>
                          <p className="text-sm text-gray-400 max-w-sm leading-relaxed">Write a prompt, choose size &amp; quality, then click <strong className="text-purple-400">Generate Image</strong>.</p>
                          <div className="mt-5 text-[10px] text-purple-300/60 bg-purple-950/20 px-3 py-1.5 rounded-full border border-purple-900/30 font-mono">SDXL + Refiner • NSFW Disabled</div>
                        </div>
                      )}

                      {imgUrl && !imgGenerating && (
                        <div className="flex flex-col h-full gap-4">
                          <div className="flex items-center justify-between border-b border-[#212128] pb-3">
                            <div className="flex items-center gap-2">
                              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                              <span className="text-xs font-semibold text-emerald-400 tracking-wider uppercase">COMPLETED</span>
                            </div>
                            {imgMeta && (
                              <span className="text-[10px] text-gray-500 font-mono">{imgMeta.width}×{imgMeta.height} • {imgMeta.model}</span>
                            )}
                          </div>
                          <div className="relative bg-black rounded-xl overflow-hidden border border-[#2D2D38] shadow-2xl flex-grow flex items-center justify-center p-2">
                            { }
                            <img id="gen-img-result" src={imgUrl} alt="Generated" className="max-w-full max-h-[60vh] object-contain rounded-lg" />
                          </div>
                          <div className="flex gap-3">
                            <a id="dl-img-link" href={imgUrl} download="generated-image.png" target="_blank" rel="noreferrer"
                              className="flex items-center gap-2 px-4 py-2.5 bg-[#1A1A1E] hover:bg-[#25252B] border border-[#2E2E39] text-xs font-semibold text-white rounded-xl transition-all cursor-pointer">
                              <Download className="w-4 h-4 text-purple-400" /> Download PNG
                            </a>
                            <button onClick={clearImage} className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 text-xs font-semibold text-white rounded-xl cursor-pointer hover:opacity-90">
                              <RotateCcw className="w-3.5 h-3.5" /> New Image
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {/* ---- IMAGE EDIT RESULT ---- */}
                  {imageTab === 'edit' && (
                    <>
                      {editGenerating && (
                        <div className="my-auto flex flex-col items-center justify-center py-16">
                          <div className="relative w-20 h-20 mb-6">
                            <div className="absolute inset-0 bg-violet-600/20 rounded-full blur-xl animate-pulse" />
                            <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-violet-500 border-b-violet-500 animate-spin" />
                            <div className="absolute inset-3 rounded-full bg-[#18181D] border border-[#2A2A33] flex items-center justify-center">
                              <Pencil className="w-5 h-5 text-violet-400 animate-pulse" />
                            </div>
                          </div>
                          <h3 className="text-base font-bold text-white mb-1">Editing Image</h3>
                          <p className="text-sm text-gray-400">Strength: {editStrength} • {editQuality}</p>
                        </div>
                      )}

                      {editError && !editGenerating && (
                        <div className="my-auto flex flex-col items-center justify-center py-16 text-center">
                          <div className="w-14 h-14 bg-red-950/20 border border-red-900/40 rounded-2xl flex items-center justify-center text-red-400 mb-4">
                            <AlertTriangle className="w-6 h-6" />
                          </div>
                          <h3 className="text-base font-bold text-white mb-2">Edit Failed</h3>
                          <p className="text-sm text-gray-400 mb-5 max-w-sm">{editError}</p>
                          <div className="flex gap-3">
                            <button onClick={() => setEditError(null)} className="px-4 py-2 bg-[#1F1F26] border border-[#2F2F3D] rounded-xl text-xs text-white cursor-pointer hover:bg-[#2A2A35]">Dismiss</button>
                            <button onClick={handleEditGenerate} className="px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-xs font-medium text-white rounded-xl cursor-pointer hover:opacity-90">Try Again</button>
                          </div>
                        </div>
                      )}

                      {!editGenerating && !editError && !editUploadUrl && !editResultUrl && (
                        <div className="my-auto flex flex-col items-center justify-center py-16 text-center">
                          <div className="w-14 h-14 bg-[#16161B] border border-[#2E2E39] rounded-2xl flex items-center justify-center text-violet-400 mb-5">
                            <Pencil className="w-6 h-6" />
                          </div>
                          <h3 className="text-base font-bold text-white mb-2">Image Editor</h3>
                          <p className="text-sm text-gray-400 max-w-sm leading-relaxed">Upload an image, describe your edits, and let SDXL transform it.</p>
                        </div>
                      )}

                      {editResultUrl && !editGenerating && (
                        <div className="flex flex-col h-full gap-4">
                          <div className="flex items-center justify-between border-b border-[#212128] pb-3">
                            <div className="flex items-center gap-2">
                              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                              <span className="text-xs font-semibold text-emerald-400 tracking-wider uppercase">EDIT COMPLETE</span>
                            </div>
                          </div>
                          {/* Side by side: original + result */}
                          <div className="grid grid-cols-2 gap-3 flex-grow">
                            <div className="relative bg-black rounded-xl overflow-hidden border border-[#2D2D38] flex items-center justify-center p-1">
                              <div className="absolute top-2 left-2 text-[9px] bg-black/60 px-2 py-0.5 rounded text-gray-300">Original</div>
                              { }
                              <img src={editUploadUrl || ''} alt="Original" className="max-w-full max-h-[55vh] object-contain rounded" />
                            </div>
                            <div className="relative bg-black rounded-xl overflow-hidden border border-[#2D2D38] flex items-center justify-center p-1">
                              <div className="absolute top-2 left-2 text-[9px] bg-purple-900/60 px-2 py-0.5 rounded text-purple-200">Edited</div>
                              { }
                              <img id="edit-result-img" src={editResultUrl} alt="Edited" className="max-w-full max-h-[55vh] object-contain rounded" />
                            </div>
                          </div>
                          <div className="flex gap-3">
                            <a href={editResultUrl} download="edited-image.png" target="_blank" rel="noreferrer"
                              className="flex items-center gap-2 px-4 py-2.5 bg-[#1A1A1E] hover:bg-[#25252B] border border-[#2E2E39] text-xs font-semibold text-white rounded-xl transition-all cursor-pointer">
                              <Download className="w-4 h-4 text-purple-400" /> Download
                            </a>
                            <button onClick={clearEdit} className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 text-xs font-semibold text-white rounded-xl cursor-pointer hover:opacity-90">
                              <Trash2 className="w-3.5 h-3.5" /> Start Over
                            </button>
                          </div>
                        </div>
                      )}

                      {/* Show uploaded image preview when no result yet */}
                      {editUploadUrl && !editResultUrl && !editGenerating && !editError && (
                        <div className="my-auto flex flex-col items-center justify-center py-10">
                          <div className="relative w-64 rounded-xl overflow-hidden border border-[#2D2D38] bg-black shadow-2xl">
                            { }
                            <img src={editUploadUrl} alt="Uploaded" className="w-full max-h-[50vh] object-contain" />
                            <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/80 to-transparent px-3 py-3">
                              <span className="text-xs text-gray-300">{editUploadName}</span>
                            </div>
                          </div>
                          <p className="text-xs text-gray-500 mt-4">Image uploaded. Write your edit prompt and click <strong className="text-purple-400">Edit Image</strong>.</p>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          </>
        )}

        {/* ================================================================ */}
        {/* VIDEO MODE                                                       */}
        {/* ================================================================ */}
        {mode === 'video' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* ---- Left: Video form ---- */}
            <div className="lg:col-span-5 flex flex-col gap-5">
              <div className="bg-[#111114] border border-[#212128] rounded-2xl p-5 shadow-xl shadow-black/20">
                <h2 className="text-sm font-semibold tracking-wider text-gray-200 uppercase mb-4">Generate Video</h2>
                <form onSubmit={handleVideoGenerate} className="space-y-5">
                  <div>
                    <label className="block text-xs font-medium text-gray-400 mb-2" htmlFor="vid-prompt">PROMPT</label>
                    <textarea id="vid-prompt" rows={6} placeholder="Describe your cinematic video scene…"
                      value={vidPrompt} onChange={(e) => setVidPrompt(e.target.value)} disabled={vidProcessing}
                      className="w-full bg-[#17171C] border border-[#2D2D38] focus:border-purple-500 focus:ring-2 focus:ring-purple-500/30 rounded-xl p-3.5 text-sm text-white placeholder-gray-500 focus:outline-none transition-all resize-none leading-relaxed"
                    />
                    <div className="flex justify-between items-center mt-2 text-xs text-gray-500">
                      <span>Describe action / movement</span>
                      <span className={vidPrompt.length > 300 ? 'text-purple-400' : ''}>{vidPrompt.length} chars</span>
                    </div>
                  </div>
                  <button type="submit" disabled={vidProcessing || !vidPrompt.trim()}
                    className="w-full py-3.5 px-5 bg-gradient-to-r from-purple-600 via-violet-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-medium rounded-xl text-sm transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:pointer-events-none cursor-pointer">
                    <Send className="w-4 h-4" />
                    <span>{vidProcessing ? 'Queuing GPU…' : 'Generate Video'}</span>
                  </button>
                </form>
              </div>
              <div className="bg-[#111114]/40 border border-[#212128]/50 rounded-2xl p-4 text-xs text-gray-400 space-y-2">
                <h3 className="font-semibold text-gray-300">Video Info</h3>
                <div className="p-2.5 bg-black/40 rounded-lg border border-white/5 space-y-1 font-mono text-[10px]">
                  <div className="flex justify-between"><span>Model:</span><span className="text-purple-400">SD 1.5</span></div>
                  <div className="flex justify-between"><span>GPU:</span><span className="text-emerald-400">RTX 3090 24GB</span></div>
                  <div className="flex justify-between"><span>Output:</span><span className="text-gray-300">H.264 / 24 FPS / 64 frames</span></div>
                </div>
              </div>
            </div>

            {/* ---- Right: Video result ---- */}
            <div className="lg:col-span-7">
              <div className="bg-[#111114] border border-[#212128] rounded-2xl p-5 min-h-[500px] flex flex-col shadow-xl shadow-black/20">
                {/* Idle */}
                {!vidProcessing && !vidUrl && !vidError && (
                  <div className="my-auto flex flex-col items-center justify-center py-16 text-center">
                    <div className="w-14 h-14 bg-[#16161B] border border-[#2E2E39] rounded-2xl flex items-center justify-center text-purple-400 mb-5">
                      <Film className="w-6 h-6" />
                    </div>
                    <h3 className="text-base font-bold text-white mb-2">Video Studio</h3>
                    <p className="text-sm text-gray-400">Write a prompt and click <strong className="text-purple-400">Generate Video</strong>.</p>
                  </div>
                )}

                {/* Processing */}
                {vidProcessing && (
                  <div className="my-auto flex flex-col items-center justify-center py-12 text-center">
                    <div className="relative w-20 h-20 mb-6">
                      <div className="absolute inset-0 bg-purple-600/20 rounded-full blur-xl animate-pulse" />
                      <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-purple-500 border-b-purple-500 animate-spin" />
                      <div className="absolute inset-3 rounded-full bg-[#18181D] border border-[#2A2A33] flex items-center justify-center">
                        <Loader2 className="w-5 h-5 text-purple-400 animate-spin" />
                      </div>
                    </div>
                    <div className="inline-flex items-center gap-2 bg-purple-950/30 border border-purple-800/40 text-purple-300 px-4 py-1.5 rounded-full text-xs font-mono mb-3">
                      <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-ping" />
                      RENDERING
                    </div>
                    <h3 className="text-base font-bold text-white mb-1">Rendering Frames</h3>
                    <p className="text-sm text-gray-400 mb-4">2–5 minutes</p>
                    <div className="bg-[#09090C] border border-[#22222A] rounded-xl p-3 font-mono text-[11px] text-gray-400 text-left w-full max-w-md">
                      <div className="flex justify-between border-b border-white/5 pb-1 text-gray-500">
                        <span>Job: {vidJobId || '…'}</span>
                        <span>Polls: {vidPollCount}</span>
                      </div>
                      <div className="text-purple-400 truncate mt-1">{vidStatusText}</div>
                    </div>
                  </div>
                )}

                {/* Error */}
                {vidError && !vidProcessing && (
                  <div className="my-auto flex flex-col items-center justify-center py-16 text-center">
                    <div className="w-14 h-14 bg-red-950/20 border border-red-900/40 rounded-2xl flex items-center justify-center text-red-400 mb-4">
                      <AlertTriangle className="w-6 h-6" />
                    </div>
                    <h3 className="text-base font-bold text-white mb-2">Video Failed</h3>
                    <p className="text-sm text-gray-400 mb-5 max-w-sm">{vidError}</p>
                    <div className="flex gap-3">
                      <button onClick={clearVideo} className="px-4 py-2 bg-[#1F1F26] border border-[#2F2F3D] rounded-xl text-xs text-white cursor-pointer">Clear</button>
                      <button onClick={() => handleVideoGenerate()} className="px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-xs font-medium text-white rounded-xl cursor-pointer">Try Again</button>
                    </div>
                  </div>
                )}

                {/* Success */}
                {vidUrl && !vidProcessing && (
                  <div className="flex flex-col h-full gap-4">
                    <div className="flex items-center justify-between border-b border-[#212128] pb-3">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span className="text-xs font-semibold text-emerald-400 tracking-wider uppercase">COMPLETED</span>
                      </div>
                      <span className="text-[10px] text-gray-500 font-mono">{vidJobId?.slice(0, 12)}…</span>
                    </div>
                    <div className="relative bg-black rounded-xl overflow-hidden border border-[#2D2D38] shadow-2xl flex-grow aspect-video flex items-center justify-center">
                      <video id="output-video-player" src={vidUrl} controls autoPlay loop playsInline referrerPolicy="no-referrer" className="w-full h-full object-contain" />
                    </div>
                    <div className="bg-[#17171C] border border-[#23232C] rounded-xl p-3 text-xs">
                      <span className="text-gray-400 font-medium block mb-1">PROMPT</span>
                      <p className="text-gray-300 italic">&quot;{vidPrompt}&quot;</p>
                    </div>
                    <div className="flex gap-3">
                      <a href={vidUrl} download="generated-video.mp4" target="_blank" rel="noreferrer"
                        className="flex items-center gap-2 px-4 py-2.5 bg-[#1A1A1E] hover:bg-[#25252B] border border-[#2E2E39] text-xs font-semibold text-white rounded-xl cursor-pointer">
                        <Download className="w-4 h-4 text-purple-400" /> Download MP4
                      </a>
                      <button onClick={clearVideo} className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-purple-600 to-indigo-600 text-xs font-semibold text-white rounded-xl cursor-pointer">
                        <RotateCcw className="w-3.5 h-3.5" /> New Video
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* ----------------------------------------------------------------- */}
      {/* Footer (sticky)                                                   */}
      {/* ----------------------------------------------------------------- */}
      <footer className="bg-[#070709] border-t border-[#141418] px-4 sm:px-6 py-4 mt-auto">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row items-center justify-between text-[11px] text-gray-500 gap-3">
          <span>AI Studio v2.0 — FastAPI + Supabase Edge Functions</span>
          <div className="flex gap-3">
            <span className="hover:text-purple-400 transition-colors">GPU: RTX 3090</span>
            <span>•</span>
            <span className="hover:text-purple-400 transition-colors">SDXL + SD 1.5</span>
          </div>
        </div>
      </footer>
    </div>
  );
}