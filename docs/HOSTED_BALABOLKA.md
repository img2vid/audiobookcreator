# Hosted Balabolka for GitHub Pages

**Architecture:** GitHub Pages hosts only the static React interface. A separate
Windows server runs the Balabolka command-line utility (`balcon.exe`) behind
the project's Node.js speech bridge. A TLS reverse proxy exposes the service
to authorized browsers over HTTPS. The user's PC needs only a browser; **no
Balabolka installation is needed on a visitor's device**.

> GitHub Pages cannot run executable programs or speech jobs. GitHub-hosted
> Actions runners are short-lived CI/batch computers, not always-on speech
> servers. A permanent hosted Windows service is required for a responsive
> audiobook editor. This repository does not provision or pay for that host.

## 1. Provision Windows speech host (operator only)

Use a Windows VM or managed Windows server that permits speech synthesis,
outbound package installation, and HTTPS ingress. Install Node.js 22+ and a
licensed set of Windows SAPI 5 / Microsoft Speech Platform voice(s). Confirm
the selected speech voice can generate files while running under the server
account, not only in an interactive desktop session.

Obtain the separately distributed Balabolka **command-line utility** from
https://www.cross-plus-a.com/bconsole.htm. Extract the command-line executable
`balcon.exe`. The desktop application `balabolka.exe` is not a replacement.

In PowerShell on the Windows speech host:

```powershell
cd C:\apps\audiobookcreator
npm ci
$env:BALABOLKA_CMD = 'C:\Tools\Balabolka\balcon.exe'
& $env:BALABOLKA_CMD -l  # verify installed voices
$env:PORT = '8477'
$env:BRIDGE_ALLOWED_HOSTS = 'tts.example.com'
$env:BRIDGE_ALLOWED_ORIGINS = 'https://img2vid.github.io'

# Generate a unique secret on the Windows host, NOT in GitHub Pages:
$secretBytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($secretBytes)
$env:BRIDGE_ACCESS_TOKEN = [Convert]::ToBase64String($secretBytes)

npm run os-tts
```

Replace `tts.example.com` with your real HTTPS speech hostname and
`https://img2vid.github.io` with the frontend's **origin**, not its
`/audiobookcreator` path. Set the same environment variables in the
service manager when running the bridge persistently; PowerShell environment
variables set this way only last for the current shell.

The speech bridge intentionally binds to `127.0.0.1:8477` on the Windows
host. **Never open port 8477 to the public internet.** Use a TLS reverse proxy
for external traffic.

## 2. Add a TLS reverse proxy and DNS

Point a DNS hostname such as `tts.example.com` at the Windows server.
Install and configure Caddy or another HTTPS reverse proxy, for example:

```caddyfile
tts.example.com {
    reverse_proxy 127.0.0.1:8477
}
```

Caddy normally obtains a trusted TLS certificate automatically when DNS and
ports 80/443 are set up correctly. Restrict ingress to HTTPS and enforce
upstream request body size, rate limits and abuse controls if the service
will be used by anyone outside a small trusted group. Keep Node/Windows and
the voice software patched. The bridge's host allowlist, origin allowlist,
single-active-render admission limit, input-size cap and bearer token are
additional controls, not replacements for gateway-level protection.

Use **only HTTPS** in the deployed web app. The bridge rejects requests from
unexpected Host or Origin values, and when hosted mode is enabled it refuses
startup without a secret token of at least 24 characters. The same secret
is required on `/ping`, `/voices` and `/synthesize`. The server does not
publish that secret in its responses.

## 3. Configure the GitHub Pages frontend

In the GitHub repository, go to **Settings → Secrets and variables →
Actions → Variables**. Add this **non-secret** repository variable:

```text
SPEECH_BRIDGE_URL=https://tts.example.com
```

The `.github/workflows/deploy-pages.yml` build exports this URL as
`NEXT_PUBLIC_SPEECH_BRIDGE_URL` into the static frontend. Merge the feature
branch to `main`, run the Pages deployment, and open the web app. The
frontend now connects to the Windows host instead of to visitors' localhost.

Never publish `BRIDGE_ACCESS_TOKEN` via `NEXT_PUBLIC_*`, repository
Variables, JavaScript source, a query parameter, or bundled assets. A static
GitHub Pages site cannot safely hide a shared server secret.

For private / operator use: open **TTS Studio → Engine & Voice**, enter
the service's access token, and click **Connect / Retry**. The token
is held only in browser memory for that tab. The same connection is used by
Book Desk, AutoBook, Dialogue Studio, TTS previews, and file exports.

For a **public anonymous** audiobook website, do NOT give the master token
to visitors. Instead deploy a separate authenticated gateway with
individual user sessions, abuse prevention, quotas, concurrency-aware
job queueing and short-lived scoped credentials. Those identity/hosting
services are not included in this repository.

## 4. Verify

On the Windows host, `http://127.0.0.1:8477/ping` works with the bearer
header. From the web app, **Connect / Retry** should list Balabolka voices.
A generated short preview should be returned as WAV with the response header
`X-OS-TTS-Engine: balabolka`. A missing voice or inaccessible server causes
an explicit error; the site does not silently substitute a robotic voice.

Check actual sound quality with a real SAPI voice. Our automated fixture
tests only exercise protocol and audio-file delivery. Neither Balabolka nor
the GitHub runner adds neural voice quality to a classic SAPI voice.

## Licensing and privacy

Balabolka's separately published licence allows noncommercial use and may
require permission for commercial use or redistribution. Verify the current
publisher terms before operating a public/commercial service. The server
will receive the text users choose to synthesize; publish an appropriate
privacy notice, limit logs, and ensure the hosting provider complies with
applicable data-handling requirements.
