README — Running the OS Speech Bridge (read this first!)
=========================================================

The "Bridge not ready / not reachable" message in the app is EXPECTED until
you start the local bridge server. The app (web page) and the bridge are TWO
separate programs. Typing an IP into the app only changes WHERE it looks —
it does not start anything. You must start the bridge yourself in a terminal.

WHAT IS INSIDE THIS ZIP
-----------------------
This is your current GitHub repository state (your latest commits, vendored
public/ort runtime, PATCH-NOTES.txt) WITH both bridge reachability fixes
applied:
  1. Instant /ping (first voice scan no longer races the probe) + Chrome
     Private-Network-Access preflight support + probe timeout 2.5s -> 10s
  2. CORS headers on EVERY JSON/WAV response (the root cause of
     "No 'Access-Control-Allow-Origin' header" from GitHub Pages) — bridge
     version is now 2.

WINDOWS — 5 steps
-----------------
1) Install Node.js 20.9 or newer (https://nodejs.org → LTS installer).
   Check in Command Prompt:      node -v

2) Open a terminal IN THIS FOLDER (the one containing package.json):
   - Open the folder in File Explorer, click the address bar, type: cmd
   - First time only, run:        npm install

3) Start the app (terminal window 1) — OR use the GitHub Pages deployment:
                                  npm run dev
   Then open http://localhost:3000 in your browser.

4) Start the OS speech bridge (terminal window 2 — a SECOND cmd window,
   opened the same way, in the same folder):
                                  npm run os-tts
   KEEP THIS WINDOW OPEN while you use the app.
   Success looks like:
     [os-tts] ..:..:.. OS Speech Bridge listening on http://127.0.0.1:8477
   Verify in your browser:  http://127.0.0.1:8477/ping
   It must show JSON with  "version":2  (older unpatched bridges show 1 and
   will NOT work from GitHub Pages — the CORS fix is in bridge version 2).
   If Windows Firewall asks for permission → click "Allow access".

5) Back in the app — whether http://localhost:3000 or https://img2vid.github.io:
   - Leave the bridge URL field EMPTY (built-in default http://127.0.0.1:8477).
     A typo like port 9477 instead of 8477 keeps the bridge "not ready".
   - Click "Retry". The box turns green: "online (N OS voices)".
     If the first Retry shows 0 voices or still not ready, wait ~5 seconds
     and press Retry once more — the first voice scan (Windows runs
     PowerShell for it) can take a few seconds. Probes share one scan.

CONSOLE ERRORS, EXPLAINED
-------------------------
- net::ERR_CONNECTION_REFUSED on http://127.0.0.1:8477/ping
  → the bridge is simply not running. Start it (step 4).
- "blocked by CORS policy: No 'Access-Control-Allow-Origin' header..."
  from https://img2vid.github.io → the RUNNING bridge is an older version.
  Bridge v2 (this tree) answers CORS on every response and Chrome's
  Private-Network-Access preflight, so the GitHub Pages site can talk to it.

WHAT THE BRIDGE DOES
--------------------
Windows SAPI 5 voices (including the modern "Natural" ones where installed)
render your previews and file exports with the real voices installed on your
PC. Optional: Piper neural voices are used automatically if the bridge finds
a Piper installation. Nothing else to download or upload.

FILES & BUILD
-------------
- npm run dev     → run the app in development mode (uses port 3000)
- npm run build   → regenerate the static out/ directory (not included in
                    this ZIP to keep the download small; it is rebuilt from
                    source automatically)
- npm run os-tts  → the OS speech bridge (port 8477)
- docs/OS_TTS_BRIDGE.md → full bridge documentation
- PATCH-NOTES.txt → notes shipped with your repository
