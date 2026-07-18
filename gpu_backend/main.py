"""
AI Video Studio - FastAPI GPU Backend (Direct Serve)
=====================================================
Serves generated videos directly via HTTP. No Supabase key needed on GPU server.
Videos are accessible at /videos/{job_id}.mp4

Run: uvicorn main:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import os
import uuid
import time
import threading
from pathlib import Path

import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
GPU_SERVER_API_KEY: str = os.environ.get("GPU_SERVER_API_KEY", "changeme")
OUTPUT_DIR = Path(os.environ.get("OUTPUT_DIR", "./output"))
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="AI Video Studio GPU Backend", version="2.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# API Key middleware
# ---------------------------------------------------------------------------
@app.middleware("http")
async def verify_api_key(request: Request, call_next):
    skip = ("/docs", "/redoc", "/openapi.json", "/videos/")
    if any(request.url.path.startswith(p) for p in skip):
        return await call_next(request)
    provided = request.headers.get("x-gpu-api-key", "")
    if provided != GPU_SERVER_API_KEY:
        raise HTTPException(status_code=403, detail="Invalid or missing API key.")
    return await call_next(request)

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class GenerateRequest(BaseModel):
    prompt: str

# ---------------------------------------------------------------------------
# Job store
# ---------------------------------------------------------------------------
jobs: dict[str, dict] = {}

# ---------------------------------------------------------------------------
# Pipeline (lazy load in background thread)
# ---------------------------------------------------------------------------
_pipe = None

def _load_pipeline():
    global _pipe
    model_id = os.environ.get("SD_MODEL_ID", "runwayml/stable-diffusion-v1-5")
    from diffusers import StableDiffusionPipeline
    _pipe = StableDiffusionPipeline.from_pretrained(
        model_id,
        torch_dtype=torch.float16,
        safety_checker=None,
        requires_safety_checker=False,
    )
    _pipe = _pipe.to("cuda")
    print("[Pipeline] SD pipeline loaded on CUDA.")

threading.Thread(target=_load_pipeline, daemon=True).start()

def _get_pipe():
    while _pipe is None:
        time.sleep(2)
    return _pipe

# ---------------------------------------------------------------------------
# Render worker
# ---------------------------------------------------------------------------
def _render_job(job_id: str, prompt: str):
    try:
        pipe = _get_pipe()
        jobs[job_id]["status"] = "processing"
        jobs[job_id]["progressLogs"] = "Pipeline loaded. Rendering frames..."

        num_frames = 32
        frames = []
        for i in range(num_frames):
            seed = uuid.uuid4().int % (2**32)
            generator = torch.Generator("cuda").manual_seed(seed)
            frame_prompt = f"{prompt}, cinematic frame {i+1} of {num_frames}, high quality, 8k"
            image = pipe(frame_prompt, num_inference_steps=20, guidance_scale=7.5, generator=generator).images[0]
            frames.append(image)
            pct = int(((i + 1) / num_frames) * 100)
            jobs[job_id]["progressLogs"] = f"Rendering frame {i+1}/{num_frames} [{pct}%]"

        jobs[job_id]["progressLogs"] = "Compiling to MP4..."
        import imageio.v2 as iio
        import numpy as np
        mp4_path = OUTPUT_DIR / f"{job_id}.mp4"
        writer = iio.get_writer(str(mp4_path), fps=12, codec="libx264", quality=8)
        for frame in frames:
            arr = np.array(frame.convert("RGB"))
            writer.append_data(arr)
        writer.close()

        video_url = f"/videos/{job_id}.mp4"
        jobs[job_id]["status"] = "completed"
        jobs[job_id]["videoUrl"] = video_url
        jobs[job_id]["progressLogs"] = "Video ready!"

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
    job_id = f"job_{uuid.uuid4().hex[:12]}"
    jobs[job_id] = {
        "jobId": job_id,
        "status": "pending",
        "progressLogs": "Queued. Loading pipeline...",
        "videoUrl": None,
        "error": None,
    }
    threading.Thread(target=_render_job, args=(job_id, req.prompt), daemon=True).start()
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

@app.get("/videos/{filename}")
def serve_video(filename: str):
    path = OUTPUT_DIR / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="Video not found.")
    return FileResponse(str(path), media_type="video/mp4")