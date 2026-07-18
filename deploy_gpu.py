#!/usr/bin/env python3
import paramiko, base64, sys

HOST, PORT, USER, KEY = "137.175.76.24", 10155, "root", "/home/z/.ssh/vast_ed25519"

def connect():
    s = paramiko.SSHClient()
    s.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    s.connect(HOST, port=PORT, username=USER, pkey=paramiko.Ed25519Key.from_private_key_file(KEY), timeout=30)
    return s

def run(s, cmd, timeout=120):
    print(f">>> {cmd[:200]}")
    i, o, e = s.exec_command(cmd, timeout=timeout)
    out = o.read().decode().strip()
    err = e.read().decode().strip()
    if out:
        for line in out.split("\n")[-25:]:
            print(f"  {line}")
    if err:
        for line in err.split("\n")[-10:]:
            print(f"  [E] {line}")
    return out, err

def upload_b64(s, filepath, remote):
    with open(filepath, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    cs = 50000
    chunks = [b64[i:i+cs] for i in range(0, len(b64), cs)]
    for idx, chunk in enumerate(chunks):
        op = ">" if idx == 0 else ">>"
        run(s, f"echo '{chunk}' | base64 -d {op} {remote}")
    run(s, f"wc -c {remote}")

step = sys.argv[1] if len(sys.argv) > 1 else "check"
s = connect()
print(f"Connected! Step: {step}")

if step == "check":
    run(s, "whoami && python3 --version && nvidia-smi --query-gpu=name,mem --format=csv,noheader")
    run(s, "ss -tlnp 2>/dev/null")
    run(s, "ps aux | grep cloudflare | grep -v grep || echo no_cf")
    run(s, "cat /etc/cloudflared/config.yml 2>/dev/null || ls /root/.cloudflared/ 2>/dev/null || echo no_cf_config")
    run(s, "env | grep -i tunnel 2>/dev/null || echo no_tunnel_env")
    run(s, "pip list 2>/dev/null | grep -iE 'diffusers|torch|fastapi|imageio|uvicorn' || echo need_install")

elif step == "upload":
    run(s, "mkdir -p /root/gpu-backend/output")
    upload_b64(s, "/home/z/my-project/gpu_backend/main.py", "/root/gpu-backend/main.py")
    upload_b64(s, "/home/z/my-project/gpu_backend/requirements.txt", "/root/gpu-backend/requirements.txt")
    env = "GPU_SERVER_API_KEY=giz_studio_gpu_key_a3f8b2c1d4e5f67890abcdef12\nOUTPUT_DIR=./output\n"
    run(s, f"echo '{base64.b64encode(env.encode()).decode()}' | base64 -d > /root/gpu-backend/.env")
    run(s, "cat /root/gpu-backend/.env")

elif step == "install":
    run(s, "pip install fastapi uvicorn[standard] python-multipart pydantic 2>&1 | tail -5", timeout=300)
    run(s, "pip install diffusers transformers accelerate 2>&1 | tail -5", timeout=300)

elif step == "install2":
    run(s, "pip install imageio[ffmpeg] imageio-ffmpeg numpy pillow 2>&1 | tail -5", timeout=300)

elif step == "start":
    run(s, "pkill -f 'uvicorn main:app' 2>/dev/null; sleep 1; echo killed")
    run(s, "cd /root/gpu-backend && nohup python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 > server.log 2>&1 &")
    import time; time.sleep(4)
    run(s, "ps aux | grep uvicorn | grep -v grep")
    run(s, "ss -tlnp | grep 8000")

elif step == "health":
    run(s, "curl -s http://localhost:8000/health -H 'x-gpu-api-key: giz_studio_gpu_key_a3f8b2c1d4e5f67890abcdef12'")

elif step == "logs":
    run(s, "tail -40 /root/gpu-backend/server.log 2>/dev/null || echo no_log")

elif step == "tunnel":
    run(s, "ps aux | grep -E 'cloudflare|tunnel' | grep -v grep")
    run(s, "cat /root/.cloudflared/*.yml 2>/dev/null || cat /etc/cloudflared/*.yml 2>/dev/null || echo no_yml")
    run(s, "ls -la /root/.cloudflared/ 2>/dev/null")
    run(s, "systemctl status cloudflared 2>/dev/null || echo no_systemd")
    run(s, "curl -s http://localhost:8000/health 2>/dev/null || echo not_listening")

s.close()
print("Done.")