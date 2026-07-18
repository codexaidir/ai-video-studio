#!/usr/bin/env python3
import paramiko, sys, time

HOST, PORT, USER, KEY = "137.175.76.24", 10155, "root", "/home/z/.ssh/vast_ed25519"

def connect():
    s = paramiko.SSHClient()
    s.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    s.connect(HOST, port=PORT, username=USER, pkey=paramiko.Ed25519Key.from_private_key_file(KEY), timeout=30)
    return s

def r(s, cmd, t=120):
    print(f">>> {cmd[:200]}")
    i, o, e = s.exec_command(cmd, timeout=t)
    out = o.read().decode().strip()
    err = e.read().decode().strip()
    if out:
        for ln in out.split("\n")[-25:]:
            print(f"  {ln}")
    if err:
        for ln in err.split("\n")[-10:]:
            print(f"  [E] {ln}")
    return out, err

s = connect()
step = sys.argv[1] if len(sys.argv) > 1 else "check"

if step == "check":
    r(s, "pip list 2>/dev/null | grep -iE 'torch|diffusers|fastapi|supabase|imageio|uvicorn|accelerate|transformers|pydantic|pillow|numpy'")

elif step == "install_missing":
    # Only install what's NOT already there
    r(s, "pip install fastapi 'uvicorn[standard]' python-multipart 2>&1 | tail -5", t=180)
    r(s, "pip install supabase imageio imageio-ffmpeg 2>&1 | tail -5", t=180)
    r(s, "pip install diffusers transformers accelerate 2>&1 | tail -5", t=600)

elif step == "install_fast":
    # Fast deps only (skip diffusers/transformers heavy ones)
    r(s, "pip install fastapi 'uvicorn[standard]' python-multipart 2>&1 | tail -3", t=180)
    r(s, "pip install supabase imageio imageio-ffmpeg 2>&1 | tail -3", t=180)

elif step == "install_heavy":
    # Only the heavy ML deps
    r(s, "pip install diffusers transformers accelerate 2>&1 | tail -5", t=600)

elif step == "start":
    r(s, "pkill -f 'uvicorn main:app' 2>/dev/null; sleep 1; echo cleaned")
    r(s, "cd /root/gpu-backend && nohup python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 --workers 1 > server.log 2>&1 &")
    time.sleep(5)
    r(s, "ps aux | grep uvicorn | grep -v grep")
    r(s, "ss -tlnp | grep 8000")
    r(s, "tail -10 /root/gpu-backend/server.log")

elif step == "health":
    r(s, "curl -s http://localhost:8000/health -H 'x-gpu-api-key: giz_studio_gpu_key_a3f8b2c1d4e5f67890abcdef12'")

elif step == "tunnel":
    r(s, "pkill -f 'cloudflared tunnel --url http://localhost:8000' 2>/dev/null; sleep 1")
    r(s, "nohup /opt/portal-aio/tunnel_manager/cloudflared tunnel --url http://localhost:8000 > /root/gpu-backend/tunnel.log 2>&1 &")
    print("Waiting 12s for tunnel...")
    time.sleep(12)
    out, _ = r(s, "grep -oE 'https://[a-z0-9-]+\\.trycloudflare\\.com' /root/gpu-backend/tunnel.log | tail -1")
    url = out.strip().split("\n")[-1] if out.strip() else ""
    if url:
        print(f"\n*** TUNNEL URL: {url} ***")
        time.sleep(2)
        r(s, f"curl -s '{url}/health' -H 'x-gpu-api-key: giz_studio_gpu_key_a3f8b2c1d4e5f67890abcdef12'")
    else:
        print("No URL. Log:")
        r(s, "cat /root/gpu-backend/tunnel.log")

elif step == "logs":
    r(s, "tail -30 /root/gpu-backend/server.log")

s.close()