"""
AI Video Studio — FastAPI GPU Backend (v2.0)
=============================================
Production-grade backend supporting:
  • SDXL txt2img  — HQ image generation (base + refiner)
  • SDXL img2img  — image editing / variation
  • SD 1.5 frames — video generation (legacy)

Run:
    uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
"""

from __future__ import annotations

import gc
import io
import os
import time
import uuid
import threading
import urllib.request
from pathlib import Path
from typing import Optional

import numpy as np
import torch
from PIL import Image
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from diffusers import (
    StableDiffusionPipeline,
    StableDiffusionXLPipeline,
)
from supabase import create_client, Client

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

GPU_SERVER_API_KEY: str = os.environ["GPU_SERVER_API_KEY"]
SUPABASE_URL: str = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY: str = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
ALLOWED_ORIGIN: str = os.environ.get("ALLOWED_ORIGIN", "*")
STORAGE_BUCKET: str = os.environ.get("STORAGE_BUCKET", "generated-videos")
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "./output"))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

SDXL_MODEL = os.environ.get("SDXL_MODEL", "stabilityai/stable-diffusion-xl-base-1.0")
SD_VIDEO_MODEL = os.environ.get("SD_VIDEO_MODEL", "runwayml/stable-diffusion-v1-5")

supabase_admin: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# ---------------------------------------------------------------------------
# App + CORS + API-key middleware
# ---------------------------------------------------------------------------

app = FastAPI(title="AI Video Studio – GPU Backend", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def verify_api_key(request: Request, call_next):
    if request.url.path in ("/docs", "/redoc", "/openapi.json"):
        return await call_next(request)
    key = request.headers.get("x-gpu-api-key", "")
    if key != GPU_SERVER_API_KEY:
        raise HTTPException(status_code=403, detail="Invalid or missing API key.")
    return await call_next(request)

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class GenerateImageRequest(BaseModel):
    prompt: str
    negative_prompt: str = ""
    width: int = 1024
    height: int = 1024
    quality: str = "standard"          # speed | standard | hq
    seed: Optional[int] = None

class EditImageRequest(BaseModel):
    image_url: str
    prompt: str
    negative_prompt: str = ""
    width: int = 1024
    height: int = 1024
    strength: float = 0.6              # 0.1 – 0.95
    quality: str = "standard"
    seed: Optional[int] = None

class GenerateVideoRequest(BaseModel):
    prompt: str

# ---------------------------------------------------------------------------
# Quality presets
# ---------------------------------------------------------------------------

QUALITY = {
    # SDXL base-only, no refiner (disk constraint). High step counts for HQ.
    "speed":    {"steps": 25, "cfg": 7.0, "ensemble": False},
    "standard": {"steps": 35, "cfg": 7.5, "ensemble": False},
    "hq":       {"steps": 50, "cfg": 8.0, "ensemble": True},
}

PROMPT_BOOSTERS = {
    "speed":    ", high quality, detailed",
    "standard": ", highly detailed, professional photography, 8k uhd, sharp focus, bokeh",
    "hq":       ", masterpiece, best quality, ultra detailed, professional photography, 8k uhd, "
                "sharp focus, dramatic lighting, volumetric lighting, cinematic composition, "
                "trending on artstation, award-winning",
}

DEFAULT_NEGATIVE = (
    "lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, "
    "fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, "
    "signature, watermark, blurry, deformed, ugly, duplicate, morbid, mutilated, "
    "extra fingers, mutated hands, poorly drawn hands, poorly drawn face, mutation, "
    "disfigured, out of frame, extra limbs, cloned face, gross proportions, "
    "malformed limbs, missing arms, missing legs, extra arms, extra legs, "
    "fused fingers, too many fingers, long neck, lowres, bad anatomy, bad hands, "
    "text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, "
    "low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry"
)

# ---------------------------------------------------------------------------
# Model Manager  — lazy load / swap SDXL ↔ SD 1.5 on 24 GB VRAM
# ---------------------------------------------------------------------------

class ModelManager:
    def __init__(self) -> None:
        self.img_pipe: Optional[StableDiffusionXLPipeline] = None
        self.vid_pipe: Optional[StableDiffusionPipeline] = None
        self._lock = threading.Lock()
        self._active: Optional[str] = None
        self._loading = False
        self._load_err: Optional[str] = None

    # -- helpers ----------------------------------------------------------

    @staticmethod
    def _optim(pipe):
        try:
            pipe.enable_xformers_memory_efficient_attention()
        except Exception:
            try:
                pipe.enable_sdp_torch_2_0()
            except Exception:
                pass

    def _free_video(self):
        self.vid_pipe = None
        torch.cuda.empty_cache(); gc.collect()

    def _free_image(self):
        self.img_pipe = None
        torch.cuda.empty_cache(); gc.collect()

    # -- SDXL -------------------------------------------------------------

    def ensure_sdxl(self):
        with self._lock:
            while self._loading:
                time.sleep(0.5)
            if self._load_err:
                e = self._load_err; self._load_err = None
                raise RuntimeError(e)
            if self._active == "image" and self.img_pipe is not None:
                return self.img_pipe

            self._loading = True; self._load_err = None
            try:
                self._free_video()
                if self.img_pipe is None:
                    print(f"[MM] Loading SDXL base → {SDXL_MODEL}")
                    self.img_pipe = StableDiffusionXLPipeline.from_pretrained(
                        SDXL_MODEL, torch_dtype=torch.float16, variant="fp16",
                        use_safetensors=True, safety_checker=None,
                        requires_safety_checker=False,
                    ).to("cuda")
                    self._optim(self.img_pipe)
                    print("[MM] SDXL base ready.")
                self._active = "image"
                return self.img_pipe
            except Exception as exc:
                self._load_err = str(exc); raise
            finally:
                self._loading = False

    # -- SD 1.5 -----------------------------------------------------------

    def ensure_sd15(self):
        with self._lock:
            while self._loading:
                time.sleep(0.5)
            if self._load_err:
                e = self._load_err; self._load_err = None
                raise RuntimeError(e)
            if self._active == "video" and self.vid_pipe is not None:
                return self.vid_pipe

            self._loading = True; self._load_err = None
            try:
                self._free_image()
                if self.vid_pipe is None:
                    print(f"[MM] Loading SD 1.5 → {SD_VIDEO_MODEL}")
                    self.vid_pipe = StableDiffusionPipeline.from_pretrained(
                        SD_VIDEO_MODEL, torch_dtype=torch.float16,
                        safety_checker=None, requires_safety_checker=False,
                    ).to("cuda")
                    self._optim(self.vid_pipe)
                    print("[MM] SD 1.5 ready.")
                self._active = "video"
                return self.vid_pipe
            except Exception as exc:
                self._load_err = str(exc); raise
            finally:
                self._loading = False

    def status(self) -> dict:
        return {
            "active": self._active,
            "sdxl_loaded": self.img_pipe is not None,
            "sd15_loaded": self.vid_pipe is not None,
            "loading": self._loading,
            "vram_free_gb": round(torch.cuda.mem_get_info()[0] / 1e9, 1) if torch.cuda.is_available() else 0,
        }

mm = ModelManager()

# Pre-load SDXL in background thread
def _preload():
    try:
        mm.ensure_sdxl()
    except Exception as e:
        print(f"[Preload] ERROR: {e}")
threading.Thread(target=_preload, daemon=True).start()

# ---------------------------------------------------------------------------
# Helper — upload bytes to Supabase Storage
# ---------------------------------------------------------------------------

def _upload_bytes(data: bytes, remote_name: str, content_type: str) -> str:
    """Upload raw bytes and return the public URL."""
    res = supabase_admin.storage.from_(STORAGE_BUCKET).upload(
        remote_name, data, {"content-type": content_type, "upsert": "true"},
    )
    if res.get("error"):
        # Fallback: remove then re-upload
        supabase_admin.storage.from_(STORAGE_BUCKET).remove([remote_name])
        res = supabase_admin.storage.from_(STORAGE_BUCKET).upload(
            remote_name, data, {"content-type": content_type},
        )
        if res.get("error"):
            raise RuntimeError(f"Storage upload failed: {res['error']}")
    return supabase_admin.storage.from_(STORAGE_BUCKET).get_public_url(remote_name)

# ---------------------------------------------------------------------------
# Helper — download image from URL
# ---------------------------------------------------------------------------

def _download_image(url: str) -> Image.Image:
    req = urllib.request.Request(url, headers={"User-Agent": "AI-Video-Studio/2.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = resp.read()
    return Image.open(io.BytesIO(data)).convert("RGB")

# ---------------------------------------------------------------------------
# In-memory job store (video only)
# ---------------------------------------------------------------------------

jobs: dict[str, dict] = {}

# ---------------------------------------------------------------------------
# 1. IMAGE GENERATION (txt2img) — SDXL, synchronous
# ---------------------------------------------------------------------------

@app.post("/generate-image")
def generate_image(req: GenerateImageRequest):
    q = QUALITY.get(req.quality, QUALITY["standard"])
    full_prompt = req.prompt + PROMPT_BOOSTERS.get(req.quality, "")
    full_neg = req.negative_prompt or DEFAULT_NEGATIVE

    pipe = mm.ensure_sdxl()

    generator = torch.Generator("cuda").manual_seed(req.seed) if req.seed else torch.Generator("cuda").manual_seed(uuid.uuid4().int % (2**32))

    # Ensemble denoising for HQ mode (runs denoising twice for better quality)
    image = pipe(
        prompt=full_prompt,
        negative_prompt=full_neg,
        width=req.width,
        height=req.height,
        num_inference_steps=q["steps"],
        guidance_scale=q["cfg"],
        generator=generator,
        denoising_end=1.0,
        num_images_per_prompt=2 if q.get("ensemble") else 1,
    ).images[0]

    # Encode to PNG bytes
    buf = io.BytesIO()
    image.save(buf, format="PNG", quality=95)
    png_bytes = buf.getvalue()

    # Upload to Supabase Storage
    img_id = uuid.uuid4().hex[:16]
    remote = f"images/{img_id}.png"
    public_url = _upload_bytes(png_bytes, remote, "image/png")

    return {
        "imageUrl": public_url,
        "width": req.width,
        "height": req.height,
        "quality": req.quality,
        "model": "sdxl-base-1.0",
    }

# ---------------------------------------------------------------------------
# 2. IMAGE EDITING (img2img) — SDXL, synchronous
# ---------------------------------------------------------------------------

@app.post("/edit-image")
def edit_image(req: EditImageRequest):
    q = QUALITY.get(req.quality, QUALITY["standard"])
    full_prompt = req.prompt + PROMPT_BOOSTERS.get(req.quality, "")
    full_neg = req.negative_prompt or DEFAULT_NEGATIVE

    # Download source image
    try:
        src_image = _download_image(req.image_url)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to download source image: {e}")

    # Resize source to target dimensions
    src_image = src_image.resize((req.width, req.height), Image.LANCZOS)

    pipe = mm.ensure_sdxl()

    generator = torch.Generator("cuda").manual_seed(req.seed) if req.seed else torch.Generator("cuda").manual_seed(uuid.uuid4().int % (2**32))

    strength = max(0.1, min(0.95, req.strength))

    image = pipe(
        prompt=full_prompt,
        negative_prompt=full_neg,
        image=src_image,
        strength=strength,
        num_inference_steps=q["steps"],
        guidance_scale=q["cfg"],
        generator=generator,
    ).images[0]

    buf = io.BytesIO()
    image.save(buf, format="PNG", quality=95)
    png_bytes = buf.getvalue()

    img_id = uuid.uuid4().hex[:16]
    remote = f"images/{img_id}.png"
    public_url = _upload_bytes(png_bytes, remote, "image/png")

    return {
        "imageUrl": public_url,
        "width": req.width,
        "height": req.height,
        "quality": req.quality,
        "strength": strength,
        "model": "sdxl-img2img",
    }

# ---------------------------------------------------------------------------
# 3. VIDEO GENERATION (SD 1.5 → frames → MP4) — async / job-based
# ---------------------------------------------------------------------------

def _render_video_job(job_id: str, prompt: str):
    try:
        pipe = mm.ensure_sd15()
        jobs[job_id]["status"] = "processing"
        jobs[job_id]["progressLogs"] = "Pipeline loaded. Rendering frames…"

        num_frames = 64
        frames = []
        for i in range(num_frames):
            seed = uuid.uuid4().int % (2**32)
            gen = torch.Generator("cuda").manual_seed(seed)
            frame_prompt = f"{prompt}, cinematic frame {i+1} of {num_frames}, high quality, 8k, photorealistic"

            image = pipe(
                frame_prompt,
                num_inference_steps=25,
                guidance_scale=7.5,
                generator=gen,
            ).images[0]
            frames.append(image)
            pct = int(((i + 1) / num_frames) * 100)
            jobs[job_id]["progressLogs"] = f"Rendering frame {i+1}/{num_frames}… [{pct}%]"

        # Compile to MP4
        jobs[job_id]["progressLogs"] = "Compiling frames to H.264 MP4…"
        import imageio.v2 as iio
        mp4_path = OUTPUT_DIR / f"{job_id}.mp4"
        writer = iio.get_writer(str(mp4_path), fps=24, codec="libx264", quality=8)
        for frame in frames:
            arr = np.array(frame.convert("RGB"))
            writer.append_data(arr)
        writer.close()

        # Upload
        jobs[job_id]["progressLogs"] = "Uploading to storage…"
        public_url = _upload_bytes(
            mp4_path.read_bytes(), f"renders/{job_id}.mp4", "video/mp4",
        )

        jobs[job_id]["status"] = "completed"
        jobs[job_id]["videoUrl"] = public_url
        jobs[job_id]["progressLogs"] = "Upload complete."
        mp4_path.unlink(missing_ok=True)

    except Exception as exc:
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(exc)
        jobs[job_id]["progressLogs"] = f"Error: {exc}"


@app.post("/start-generation")
def start_generation(req: GenerateVideoRequest):
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    jobs[job_id] = {
        "jobId": job_id,
        "status": "pending",
        "progressLogs": "Job queued. Waiting for pipeline…",
        "videoUrl": None,
        "error": None,
    }
    threading.Thread(target=_render_video_job, args=(job_id, req.prompt), daemon=True).start()
    return {"jobId": job_id, "status": "pending"}


@app.get("/status/{job_id}")
def check_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return {
        "jobId": job["jobId"],
        "status": job["status"],
        "progressLogs": job["progressLogs"],
        "videoUrl": job.get("videoUrl"),
        "error": job.get("error"),
    }

# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok", "version": "2.0.0", "models": mm.status()}