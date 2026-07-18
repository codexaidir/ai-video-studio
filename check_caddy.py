#!/usr/bin/env python3
import paramiko, sys

HOST, PORT, USER, KEY = "137.175.76.24", 10155, "root", "/home/z/.ssh/vast_ed25519"

def connect():
    s = paramiko.SSHClient()
    s.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    s.connect(HOST, port=PORT, username=USER, pkey=paramiko.Ed25519Key.from_private_key_file(KEY), timeout=30)
    return s

def run(s, cmd, timeout=30):
    print(f">>> {cmd[:200]}")
    i, o, e = s.exec_command(cmd, timeout=timeout)
    out = o.read().decode().strip()
    err = e.read().decode().strip()
    if out: print(out[:3000])
    if err: print(f"[E] {err[:1500]}")
    return out, err

s = connect()
step = sys.argv[1] if len(sys.argv) > 1 else "caddy"

if step == "caddy":
    # Find Caddy config
    run(s, "cat /etc/caddy/Caddyfile 2>/dev/null || echo no_etc_caddy")
    run(s, "find / -name 'Caddyfile' -type f 2>/dev/null | head -5")
    run(s, "caddy version 2>/dev/null")
    run(s, "ps aux | grep caddy | grep -v grep")
    run(s, "cat /opt/portal-aio/Caddyfile 2>/dev/null || echo no_portal_caddy")
    run(s, "ls /etc/caddy/ 2>/dev/null")

elif step == "set_caddy":
    # Add reverse proxy to Caddy config
    # We need to add: reverse_proxy /gpu/* localhost:8000
    # Or better: make the entire port 1111 proxy to port 8000
    caddyfile = """
:1111 {
    reverse_proxy localhost:8000
}
"""
    import base64
    b64 = base64.b64encode(caddyfile.encode()).decode()
    run(s, f"cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak 2>/dev/null")
    run(s, f"echo '{b64}' | base64 -d > /etc/caddy/Caddyfile")
    run(s, "cat /etc/caddy/Caddyfile")
    run(s, "caddy reload --config /etc/caddy/Caddyfile 2>&1 || echo reload_failed")
    run(s, "pkill -HUP caddy 2>/dev/null; sleep 1; echo 'caddy reloaded'")

s.close()
print("Done.")