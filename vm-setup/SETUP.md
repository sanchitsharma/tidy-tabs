# Optional: a private Ollama backend on a Linux VM (Tailscale-only)

Tidy Tabs uses Claude Haiku by default. If some windows must never leave your network, you can run a
small local model with Ollama on a Linux VM. The VM must be reachable **only over Tailscale**, and then
you point the extension's Ollama backend at it.

Placeholders used below:

| Placeholder | Meaning |
|---|---|
| `<VM_TAILSCALE_IP>` | The VM's Tailscale IPv4 (`tailscale ip -4` on the VM) |
| `<vm-host>.<tailnet>.ts.net` | The VM's MagicDNS name |
| `<mac-host>` | Your Mac's Tailscale machine name (the client) |
| `<PUBLIC_IP>` | The VM's public IP, if it has one (`curl -s ifconfig.me`) |

Tested on Ubuntu 22.04, x86_64, 8 vCPU, 32 GB RAM, no GPU. A 1.7B–4B model runs fine on CPU.

## Ground rules

- If the VM has a public IP, Ollama must **not** listen on `0.0.0.0` or the public interface. Bind it to
  the Tailscale IP only.
- Don't touch other services on the VM. Use `sudo` only for the Ollama install and its systemd override.
- If a step fails twice, stop and write the problem down. Don't improvise around the security rules.

## 1. Install Ollama

```
curl -fsSL https://ollama.com/install.sh | sh
ollama --version
```

This creates the `ollama.service` systemd unit.

## 2. Bind to Tailscale only (systemd override)

`sudo systemctl edit ollama` writes `/etc/systemd/system/ollama.service.d/override.conf`:

```
[Unit]
After=tailscaled.service network-online.target
Wants=tailscaled.service network-online.target

[Service]
Environment="OLLAMA_HOST=<VM_TAILSCALE_IP>:11434"
Environment="OLLAMA_ORIGINS=chrome-extension://*"
Environment="OLLAMA_KEEP_ALIVE=30m"
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
Restart=always
RestartSec=5
```

If binding fails at boot because the Tailscale IP isn't up yet, add:
`ExecStartPre=/bin/sh -c 'for i in $(seq 1 30); do ip addr | grep -q <VM_TAILSCALE_IP> && exit 0; sleep 2; done; exit 1'`

Then:

```
sudo systemctl daemon-reload && sudo systemctl enable --now ollama && sudo systemctl restart ollama
```

For local CLI use from then on: `OLLAMA_HOST=<VM_TAILSCALE_IP>:11434 ollama ...`

## 3. Pull models

```
OLLAMA_HOST=<VM_TAILSCALE_IP>:11434 ollama pull qwen3:1.7b     # fast, weak grouping
OLLAMA_HOST=<VM_TAILSCALE_IP>:11434 ollama pull llama3.2:3b    # middle
OLLAMA_HOST=<VM_TAILSCALE_IP>:11434 ollama pull gemma3:4b      # best quality, slowest
```

## 4. Verify

| # | Check | Pass criteria |
|---|---|---|
| 1 | `systemctl is-active ollama` and `systemctl is-enabled ollama` | active + enabled |
| 2 | `ss -ltnp \| grep 11434` | listens on `<VM_TAILSCALE_IP>:11434` only, not `0.0.0.0`, `*`, or the public IP |
| 3 | `curl -s --max-time 5 http://<PUBLIC_IP>:11434/` and `curl http://127.0.0.1:11434/` from the VM | both fail |
| 4 | `curl -s http://<VM_TAILSCALE_IP>:11434/api/tags` from `<mac-host>` | lists the pulled models |
| 5 | CORS preflight: `curl -si -X OPTIONS http://<VM_TAILSCALE_IP>:11434/api/chat -H 'Origin: chrome-extension://abcdefghijklmnop' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: content-type'` | 2xx/204 with `Access-Control-Allow-Origin` echoing the origin |
| 6 | The same with `Origin: https://evil.example` | no allow-origin header |
| 7 | `sudo systemctl restart ollama`, then checks 2 and 4 again | still Tailscale-only |
| 8 | `systemctl show ollama -p Environment` | the override's variables are present |

## 5. Point the extension at it

Open the extension's options. Set **Backend** to Ollama and the endpoint to
`http://<VM_TAILSCALE_IP>:11434` (or `http://<vm-host>.<tailnet>.ts.net:11434`), then click **Save**.
The browser asks for permission for that origin, because only `http://localhost:11434` is pre-approved.

The request contract is in `extension/lib/ollama-request.js`: `POST /api/chat` with `stream:false`,
`think:false`, `temperature 0`, `num_ctx 8192`, and a JSON schema in `format`. Use the two-pass strategy
for small models. See `bench/RESULTS.md` for how the local models compare with Haiku.
