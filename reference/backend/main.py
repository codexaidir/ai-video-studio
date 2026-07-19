"""
AI Video Studio — FastAPI GPU Backend (v3.0)
=============================================
Production 10/10 backend:
  • SDXL txt2img + Refiner  — two-stage HQ generation
  • SDXL img2img + IP-Adapter FaceID — face-preserving edits
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
import traceback
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import torch
from PIL import Image
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from diffusers import (
    StableDiffusionPipeline,
    StableDiffusionXLPipeline,
    StableDiffusionXLRefinerPipeline,
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
SDXL_REFINER = os.environ.get("SDXL_REFINER", "stabilityai/stable-diffusion-xl-refiner-1.0")
SD_VIDEO_MODEL = os.environ.get("SD_VIDEO_MODEL", "runwayml/stable-diffusion-v1-5")
HF_HOME = os.environ.get("HF_HOME", "~/.cache/huggingface")

supabase_admin: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# ---------------------------------------------------------------------------
# App + CORS + API-key middleware
# ---------------------------------------------------------------------------

app = FastAPI(title="AI Video Studio - GPU Backend", version="3.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def verify_api_key(request: Request, call_next):
    if request.url.path in ("/docs", "/redoc", "/openapi.json", "/health"):
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
    strength: float = 0.6
    quality: str = "standard"
    seed: Optional[int] = None
    face_lock: bool = True             # IP-Adapter FaceID on/off

class GenerateVideoRequest(BaseModel):
    prompt: str

# ---------------------------------------------------------------------------
# Quality presets — v3.0 with refiner steps
# ---------------------------------------------------------------------------

QUALITY = {
    "speed":    {"base_steps": 25, "refiner_steps": 0,  "cfg": 7.0},
    "standard": {"base_steps": 30, "refiner_steps": 15, "cfg": 7.5},
    "hq":       {"base_steps": 40, "refiner_steps": 25, "cfg": 8.0},
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
# Model Manager v2  — SDXL base + refiner + IP-Adapter FaceID + SD 1.5
# ---------------------------------------------------------------------------

class ModelManager:
    """
    Manages GPU memory across mutually-exclusive modes:
      image  = SDXL base (+ refiner for standard/hq)
      edit   = SDXL base + IP-Adapter FaceID
      video  = SD 1.5
    """
    def __init__(self) -> None:
        self.sdxl_base: Optional[StableDiffusionXLPipeline] = None
        self.sdxl_refiner: Optional[StableDiffusionXLRefinerPipeline] = None
        self.ip_adapter = None           # IPAdapterFaceID instance
        self.face_analyzer = None        # InsightFace
        self.vid_pipe: Optional[StableDiffusionPipeline] = None
        self._lock = threading.Lock()
        self._active: Optional[str] = None
        self._loading = False
        self._load_err: Optional[str] = None

    @staticmethod
    def _optim(pipe):
        try:
            pipe.enable_xformers_memory_efficient_attention()
        except Exception:
            try:
                pipe.enable_sdp_torch_2_0()
            except Exception:
                pass

    def _free_all(self):
        """Free everything except face_analyzer (lightweight)."""
        self.sdxl_base = None
        self.sdxl_refiner = None
        self.ip_adapter = None
        self.vid_pipe = None
        torch.cuda.empty_cache(); gc.collect()

    # -- InsightFace (lightweight, loads once) -----------------------------

    def _ensure_face_analyzer(self):
        if self.face_analyzer is not None:
            return self.face_analyzer
        print("[MM] Loading InsightFace buffalo_l...")
        import insightface
        self.face_analyzer = insightface.app.FaceAnalysis(name="buffalo_l", root=os.path.expanduser("~/.insightface/models"))
        self.face_analyzer.prepare(ctx_id=0, det_size=(640, 640))
        print("[MM] InsightFace ready.")
        return self.face_analyzer

    # -- SDXL base -------------------------------------------------------

    def ensure_sdxl(self):
        with self._lock:
            while self._loading:
                time.sleep(0.5)
            if self._load_err:
                e = self._load_err; self._load_err = None; raise RuntimeError(e)
            if self._active in ("image", "edit") and self.sdxl_base is not None:
                return self.sdxl_base

            self._loading = True; self._load_err = None
            try:
                self._free_all()
                print(f"[MM] Loading SDXL base -> {SDXL_MODEL}")
                self.sdxl_base = StableDiffusionXLPipeline.from_pretrained(
                    SDXL_MODEL, torch_dtype=torch.float16, variant="fp16",
                    use_safetensors=True, safety_checker=None,
                    requires_safety_checker=False,
                ).to("cuda")
                self._optim(self.sdxl_base)
                print("[MM] SDXL base ready.")
                self._active = "image"
                return self.sdxl_base
            except Exception as exc:
                self._load_err = str(exc); raise
            finally:
                self._loading = False

    # -- SDXL refiner (loaded alongside base for standard/hq) ------------

    def ensure_refiner(self):
        """Load refiner. Call after ensure_sdxl()."""
        if self.sdxl_refiner is not None:
            return self.sdxl_refiner
        print(f"[MM] Loading SDXL refiner -> {SDXL_REFINER}")
        self.sdxl_refiner = StableDiffusionXLRefinerPipeline.from_pretrained(
            SDXL_REFINER, torch_dtype=torch.float16, variant="fp16",
            use_safetensors=True, safety_checker=None,
            requires_safety_checker=False,
        ).to("cuda")
        self._optim(self.sdxl_refiner)
        print("[MM] SDXL refiner ready.")
        return self.sdxl_refiner

    def free_refiner(self):
        """Free refiner to reclaim VRAM after use."""
        if self.sdxl_refiner is not None:
            self.sdxl_refiner = None
            torch.cuda.empty_cache(); gc.collect()
            print("[MM] Refiner freed.")

    # -- IP-Adapter FaceID (for editing) ---------------------------------

    def ensure_ip_adapter(self):
        """Load SDXL + IP-Adapter FaceID for face-preserving edits."""
        with self._lock:
            while self._loading:
                time.sleep(0.5)
            if self._load_err:
                e = self._load_err; self._load_err = None; raise RuntimeError(e)
            if self._active == "edit" and self.ip_adapter is not None:
                return self.ip_adapter

            self._loading = True; self._load_err = None
            try:
                self._free_all()
                self._ensure_face_analyzer()

                # Load SDXL base first
                print(f"[MM] Loading SDXL base for IP-Adapter -> {SDXL_MODEL}")
                self.sdxl_base = StableDiffusionXLPipeline.from_pretrained(
                    SDXL_MODEL, torch_dtype=torch.float16, variant="fp16",
                    use_safetensors=True, safety_checker=None,
                    requires_safety_checker=False,
                ).to("cuda")
                self._optim(self.sdxl_base)

                # Load IP-Adapter FaceID
                print("[MM] Loading IP-Adapter FaceID...")
                from ip_adapter.ip_adapter_faceid import IPAdapterFaceID
                self.ip_adapter = IPAdapterFaceID(
                    self.sdxl_base,
                    ipadapter_path="h94/IP-Adapter-FaceID",
                    image_encoder_path="h94/IP-Adapter",
                    device="cuda",
                )
                print("[MM] IP-Adapter FaceID ready.")
                self._active = "edit"
                return self.ip_adapter
            except Exception as exc:
                self._load_err = str(exc); raise
            finally:
                self._loading = False

    # -- SD 1.5 ----------------------------------------------------------

    def ensure_sd15(self):
        with self._lock:
            while self._loading:
                time.sleep(0.5)
            if self._load_err:
                e = self._load_err; self._load_err = None; raise RuntimeError(e)
            if self._active == "video" and self.vid_pipe is not None:
                return self.vid_pipe

            self._loading = True; self._load_err = None
            try:
                self._free_all()
                print(f"[MM] Loading SD 1.5 -> {SD_VIDEO_MODEL}")
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
            "sdxl_loaded": self.sdxl_base is not None,
            "refiner_loaded": self.sdxl_refiner is not None,
            "ip_adapter_loaded": self.ip_adapter is not None,
            "sd15_loaded": self.vid_pipe is not None,
            "loading": self._loading,
            "vram_free_gb": round(torch.cuda.mem_get_info()[0] / 1e9, 1) if torch.cuda.is_available() else 0,
        }

mm = ModelManager()

# Pre-load SDXL base in background
def _preload():
    try:
        mm.ensure_sdxl()
    except Exception as e:
        print(f"[Preload] ERROR: {e}")
threading.Thread(target=_preload, daemon=True).start()

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _upload_bytes(data: bytes, remote_name: str, content_type: str) -> str:
    try:
        supabase_admin.storage.from_(STORAGE_BUCKET).upload(
            remote_name, data, {"content-type": content_type, "upsert": "true"},
        )
    except Exception:
        try:
            supabase_admin.storage.from_(STORAGE_BUCKET).remove([remote_name])
        except Exception:
            pass
        try:
            supabase_admin.storage.from_(STORAGE_BUCKET).upload(
                remote_name, data, {"content-type": content_type},
            )
        except Exception as e:
            raise RuntimeError(f"Storage upload failed: {e}")
    return supabase_admin.storage.from_(STORAGE_BUCKET).get_public_url(remote_name)

def _download_image(url: str) -> Image.Image:
    req = urllib.request.Request(url, headers={"User-Agent": "AI-Video-Studio/3.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = resp.read()
    return Image.open(io.BytesIO(data)).convert("RGB")

def _download_image_cv2(url: str) -> np.ndarray:
    """Download image as numpy array for InsightFace."""
    req = urllib.request.Request(url, headers={"User-Agent": "AI-Video-Studio/3.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        arr = np.asarray(bytearray(resp.read()), dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)

def _extract_face_embedding(image_url: str) -> torch.Tensor:
    """Detect face and extract identity embedding."""
    analyzer = mm._ensure_face_analyzer()
    img_array = _download_image_cv2(image_url)
    faces = analyzer.get(img_array)
    if len(faces) == 0:
        raise HTTPException(status_code=400, detail="No face detected in the source image.")
    # Use the largest face
    face = max(faces, key=lambda f: (f.bbox[2]-f.bbox[0]) * (f.bbox[3]-f.bbox[1]))
    embedding = torch.from_numpy(face.normed_embedding).unsqueeze(0).unsqueeze(0).to("cuda", dtype=torch.float16)
    print(f"[FaceID] Extracted embedding, face score: {face.det_score:.2f}")
    return embedding

def _img_to_bytes(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()

# ---------------------------------------------------------------------------
# In-memory job store (video only)
# ---------------------------------------------------------------------------

jobs: dict[str, dict] = {}

# ---------------------------------------------------------------------------
# 1. IMAGE GENERATION — SDXL base + optional refiner
# ---------------------------------------------------------------------------

@app.post("/generate-image")
def generate_image(req: GenerateImageRequest):
    q = QUALITY.get(req.quality, QUALITY["standard"])
    full_prompt = req.prompt + PROMPT_BOOSTERS.get(req.quality, "")
    full_neg = req.negative_prompt or DEFAULT_NEGATIVE

    # Ensure SDXL base
    pipe = mm.ensure_sdxl()

    generator = torch.Generator("cuda").manual_seed(req.seed) if req.seed else torch.Generator("cuda").manual_seed(uuid.uuid4().int % (2**32))

    model_used = "sdxl-base-1.0"

    if q["refiner_steps"] > 0:
        # === Two-stage: base (partial denoise) -> refiner (finish) ===
        print(f"[Gen] Two-stage: {q['base_steps']} base + {q['refiner_steps']} refiner")
        latents = pipe(
            prompt=full_prompt,
            negative_prompt=full_neg,
            width=req.width,
            height=req.height,
            num_inference_steps=q["base_steps"],
            guidance_scale=q["cfg"],
            generator=generator,
            denoising_end=0.8,
            output_type="latent",
        ).images

        # Load refiner (frees IP-Adapter if present, keeps base)
        refiner = mm.ensure_refiner()

        image = refiner(
            prompt=full_prompt,
            negative_prompt=full_neg,
            image=latents,
            num_inference_steps=q["refiner_steps"],
            guidance_scale=q["cfg"],
            denoising_start=0.8,
            generator=generator,
        ).images[0]

        model_used = "sdxl-base+refiner-1.0"
        mm.free_refiner()
    else:
        # === Single-stage: base only (speed mode) ===
        image = pipe(
            prompt=full_prompt,
            negative_prompt=full_neg,
            width=req.width,
            height=req.height,
            num_inference_steps=q["base_steps"],
            guidance_scale=q["cfg"],
            generator=generator,
        ).images[0]

    png_bytes = _img_to_bytes(image)
    img_id = uuid.uuid4().hex[:16]
    public_url = _upload_bytes(png_bytes, f"images/{img_id}.png", "image/png")

    return {
        "imageUrl": public_url,
        "width": req.width,
        "height": req.height,
        "quality": req.quality,
        "model": model_used,
    }

# ---------------------------------------------------------------------------
# 2. IMAGE EDITING — IP-Adapter FaceID + SDXL img2img
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

    src_image = src_image.resize((req.width, req.height), Image.LANCZOS)
    strength = max(0.1, min(0.95, req.strength))
    generator = torch.Generator("cuda").manual_seed(req.seed) if req.seed else torch.Generator("cuda").manual_seed(uuid.uuid4().int % (2**32))

    model_used = "sdxl-img2img"

    if req.face_lock:
        # === Face-preserving edit with IP-Adapter FaceID ===
        print(f"[Edit] Face-lock mode: strength={strength}")
        try:
            ip_model = mm.ensure_ip_adapter()
            face_embeds = _extract_face_embedding(req.image_url)

            images = ip_model.generate(
                prompt=full_prompt,
                negative_prompt=full_neg,
                faceid_embeds=face_embeds,
                image=src_image,
                strength=strength,
                width=req.width,
                height=req.height,
                num_inference_steps=q["base_steps"],
                guidance_scale=q["cfg"],
                seed=generator.initial_seed(),
            )
            image = images[0]
            model_used = "sdxl-ipadapter-faceid"
        except HTTPException:
            raise
        except Exception as exc:
            print(f"[Edit] IP-Adapter failed ({exc}), falling back to basic img2img")
            traceback.print_exc()
            # Fallback to basic img2img
            pipe = mm.ensure_sdxl()
            face_neg = "different face, different person, changed identity, altered facial features"
            full_neg = full_neg + ", " + face_neg
            image = pipe(
                prompt=full_prompt, negative_prompt=full_neg,
                image=src_image, strength=strength,
                num_inference_steps=q["base_steps"], guidance_scale=q["cfg"],
                generator=generator,
            ).images[0]
    else:
        # === Basic img2img (no face preservation) ===
        print(f"[Edit] Basic mode: strength={strength}")
        pipe = mm.ensure_sdxl()
        image = pipe(
            prompt=full_prompt, negative_prompt=full_neg,
            image=src_image, strength=strength,
            num_inference_steps=q["base_steps"], guidance_scale=q["cfg"],
            generator=generator,
        ).images[0]

    png_bytes = _img_to_bytes(image)
    img_id = uuid.uuid4().hex[:16]
    public_url = _upload_bytes(png_bytes, f"images/{img_id}.png", "image/png")

    return {
        "imageUrl": public_url,
        "width": req.width,
        "height": req.height,
        "quality": req.quality,
        "strength": strength,
        "model": model_used,
    }

# ---------------------------------------------------------------------------
# 3. VIDEO GENERATION (SD 1.5 -> frames -> MP4) — async / job-based
# ---------------------------------------------------------------------------

def _render_video_job(job_id: str, prompt: str):
    try:
        pipe = mm.ensure_sd15()
        jobs[job_id]["status"] = "processing"
        jobs[job_id]["progressLogs"] = "Pipeline loaded. Rendering frames..."

        num_frames = 64
        frames = []
        for i in range(num_frames):
            seed = uuid.uuid4().int % (2**32)
            gen = torch.Generator("cuda").manual_seed(seed)
            frame_prompt = f"{prompt}, cinematic frame {i+1} of {num_frames}, high quality, 8k, photorealistic"
            image = pipe(frame_prompt, num_inference_steps=25, guidance_scale=7.5, generator=gen).images[0]
            frames.append(image)
            pct = int(((i + 1) / num_frames) * 100)
            jobs[job_id]["progressLogs"] = f"Rendering frame {i+1}/{num_frames}... [{pct}%]"

        jobs[job_id]["progressLogs"] = "Compiling frames to H.264 MP4..."
        import imageio.v2 as iio
        mp4_path = OUTPUT_DIR / f"{job_id}.mp4"
        writer = iio.get_writer(str(mp4_path), fps=24, codec="libx264", quality=8)
        for frame in frames:
            writer.append_data(np.array(frame.convert("RGB")))
        writer.close()

        jobs[job_id]["progressLogs"] = "Uploading to storage..."
        public_url = _upload_bytes(mp4_path.read_bytes(), f"renders/{job_id}.mp4", "video/mp4")

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
        "jobId": job_id, "status": "pending",
        "progressLogs": "Job queued. Waiting for pipeline...",
        "videoUrl": None, "error": None,
    }
    threading.Thread(target=_render_video_job, args=(job_id, req.prompt), daemon=True).start()
    return {"jobId": job_id, "status": "pending"}


@app.get("/status/{job_id}")
def check_status(job_id: str):
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found.")
    return {
        "jobId": job["jobId"], "status": job["status"],
        "progressLogs": job["progressLogs"],
        "videoUrl": job.get("videoUrl"), "error": job.get("error"),
    }

# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok", "version": "3.0.0", "models": mm.status()}