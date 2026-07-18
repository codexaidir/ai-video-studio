"""
AI Video Studio — FastAPI GPU Backend
======================================
Receives generation requests from Supabase Edge Functions, renders video
frames using Stable Diffusion (with AnimateDiff / SVD extensions), compiles
to .mp4, uploads to Supabase Storage, and returns the public URL.

Run:
    uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1
"""

from __future__ import annotations

import io
import os
import uuid
import time
import threading
from pathlib import Path

import torch
from fastapi import FastAPI, HTTPException, Header, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from diffusers import (
    StableDiffusionPipeline,
    StableVideoDiffusionPipeline,
    # Uncomment the imports below when you add AnimateDiff:
    # from diffusers import AnimateDiffPipeline,
    # from diffusers import MotionAdapter,
)
from supabase import create_client, Client

# ---------------------------------------------------------------------------
# Config (populated from environment secrets)
# ---------------------------------------------------------------------------

GPU_SERVER_API_KEY: str = os.environ["GPU_SERVER_API_KEY"]
SUPABASE_URL: str = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_ROLE_KEY: str = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
ALLOWED_ORIGIN: str = os.environ.get("ALLOWED_ORIGIN", "*")
STORAGE_BUCKET: str = os.environ.get("STORAGE_BUCKET", "generated-videos")
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "./output"))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

supabase_admin: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(title="AI Video Studio – GPU Backend", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# API Key middleware
# ---------------------------------------------------------------------------

@app.middleware("http")
async def verify_api_key(request: Request, call_next):
    """Reject any request that doesn't carry the correct API key header."""
    if request.url.path in ("/docs", "/redoc", "/openapi.json"):
        return await call_next(request)

    provided_key = request.headers.get("x-gpu-api-key", "")
    if provided_key != GPU_SERVER_API_KEY:
        raise HTTPException(status_code=403, detail="Invalid or missing API key.")
    return await call_next(request)

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class GenerateRequest(BaseModel):
    prompt: str

# ---------------------------------------------------------------------------
# In-memory job store
# ---------------------------------------------------------------------------

jobs: dict[str, dict] = {}

# ---------------------------------------------------------------------------
# Pipeline (loaded lazily in a background thread to avoid blocking startup)
# ---------------------------------------------------------------------------

_pipe = None
_pipe_lock = threading.Lock()


def _load_pipeline():
    """
    Load the Stable Diffusion pipeline.

    NSFW / Safety-checker notice
    =============================
    This is a personal, private application. The safety checker is explicitly
    DISABLED below. If distributing publicly, re-enable it.

    To use AnimateDiff instead of plain SD, replace the pipeline class and
    load a MotionAdapter:

        from diffusers import AnimateDiffPipeline, MotionAdapter
        adapter = MotionAdapter.from_pretrained("guoyww/animatediff-motion-adapter-v1-5-2")
        pipe = AnimateDiffPipeline.from_pretrained(
            "runwayml/stable-diffusion-v1-5",
            motion_adapter=adapter,
        ).to("cuda")

    To use Stable Video Diffusion (SVD):

        from diffusers import StableVideoDiffusionPipeline
        pipe = StableVideoDiffusionPipeline.from_pretrained(
            "stabilityai/stable-video-diffusion-img2vid-xt",
            variant="fp16",
        ).to("cuda")
    """
    global _pipe
    model_id = os.environ.get("SD_MODEL_ID", "runwayml/stable-diffusion-v1-5")

    # ---- NSFW BYPASS: safety_checker is set to None ----
    _pipe = StableDiffusionPipeline.from_pretrained(
        model_id,
        torch_dtype=torch.float16,
        safety_checker=None,          # <-- NSFW check disabled
        requires_safety_checker=False, # <-- skips the built-in filter
    )
    _pipe = _pipe.to("cuda")
    _pipe.enable_model_cpu_offload()  # saves VRAM for long renders
    print("[Pipeline] Stable Diffusion pipeline loaded on CUDA.")


# Start loading in background
threading.Thread(target=_load_pipeline, daemon=True).start()


def _get_pipe():
    """Block until the pipeline is ready."""
    while _pipe is None:
        time.sleep(1)
    return _pipe

# ---------------------------------------------------------------------------
# Helper – upload file to Supabase Storage
# ---------------------------------------------------------------------------

def _upload_to_supabase(local_path: Path, remote_name: str) -> str:
    """Upload a file to Supabase Storage and return the public URL."""
    with open(local_path, "rb") as f:
        res = supabase_admin.storage.from_(STORAGE_BUCKET).upload(
            remote_name,
            f,
            {"content-type": "video/mp4"},
        )

    # If the file already exists, Supabase returns an error name.
    # Try upsert by deleting first.
    if "error" in res and res.get("error"):
        error_msg = res["error"]
        if "already exists" in str(error_msg):
            supabase_admin.storage.from_(STORAGE_BUCKET).remove([remote_name])
            with open(local_path, "rb") as f:
                res = supabase_admin.storage.from_(STORAGE_BUCKET).upload(
                    remote_name, f, {"content-type": "video/mp4"}
                )
        else:
            raise RuntimeError(f"Storage upload error: {error_msg}")

    # Construct public URL
    public_url = supabase_admin.storage.from_(STORAGE_BUCKET).get_public_url(remote_name)
    return public_url

# ---------------------------------------------------------------------------
# Background render worker
# ---------------------------------------------------------------------------

def _render_job(job_id: str, prompt: str):
    """
    Run the full SD → frames → MP4 pipeline in a background thread.
    Updates the job dict and uploads the result to Supabase Storage.
    """
    try:
        pipe = _get_pipe()
        jobs[job_id]["status"] = "processing"
        jobs[job_id]["progressLogs"] = "Pipeline loaded. Rendering frames…"

        # ---- Step 1: Generate frames ----
        num_frames = 64
        frames = []
        for i in range(num_frames):
            seed = uuid.uuid4().int % (2**32)
            generator = torch.Generator("cuda").manual_seed(seed)

            # Inject a frame-number hint into the negative prompt to vary
            # each frame slightly while keeping the scene coherent.
            frame_prompt = (
                f"{prompt}, cinematic frame {i+1} of {num_frames}, "
                f"high quality, 8k, photorealistic"
            )

            image = pipe(
                frame_prompt,
                num_inference_steps=25,
                guidance_scale=7.5,
                generator=generator,
            ).images[0]
            frames.append(image)

            pct = int(((i + 1) / num_frames) * 100)
            jobs[job_id]["progressLogs"] = (
                f"Rendering frame {i+1}/{num_frames}… [{pct}%]"
            )

        # ---- Step 2: Compile to MP4 ----
        jobs[job_id]["progressLogs"] = "Compiling frames to H.264 MP4…"

        import imageio.v2 as iio  # type: ignore
        mp4_path = OUTPUT_DIR / f"{job_id}.mp4"
        writer = iio.get_writer(str(mp4_path), fps=24, codec="libx264", quality=8)
        for frame in frames:
            # Convert PIL → numpy RGB
            import numpy as np
            arr = np.array(frame.convert("RGB"))
            writer.append_data(arr)
        writer.close()

        # ---- Step 3: Upload to Supabase Storage ----
        jobs[job_id]["progressLogs"] = "Uploading to storage bucket…"
        public_url = _upload_to_supabase(mp4_path, f"renders/{job_id}.mp4")

        # ---- Done ----
        jobs[job_id]["status"] = "completed"
        jobs[job_id]["videoUrl"] = public_url
        jobs[job_id]["progressLogs"] = "Upload complete."

        # Clean up local file
        mp4_path.unlink(missing_ok=True)

    except Exception as exc:
        jobs[job_id]["status"] = "failed"
        jobs[job_id]["error"] = str(exc)
        jobs[job_id]["progressLogs"] = f"Error: {exc}"

# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def health():
    return {"status": "ok", "pipeline_ready": _pipe is not None}


@app.post("/start-generation")
def start_generation(req: GenerateRequest):
    """Accept a prompt, create a job, start rendering in background."""
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    jobs[job_id] = {
        "jobId": job_id,
        "status": "pending",
        "progressLogs": "Job queued. Waiting for pipeline…",
        "videoUrl": None,
        "error": None,
    }

    # Launch background render
    threading.Thread(
        target=_render_job,
        args=(job_id, req.prompt),
        daemon=True,
    ).start()

    return {"jobId": job_id, "status": "pending"}


@app.get("/status/{job_id}")
def check_status(job_id: str):
    """Return the current status of a generation job."""
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