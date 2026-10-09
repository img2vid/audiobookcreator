README — Running the OS Speech Bridge (read this first!)
=========================================================

The "Bridge not ready / not reachable" message in the app is EXPECTED until
you start the local bridge server. The app (web page) and the bridge are TWO
separate programs. Typing an IP into the app only changes WHERE it looks —
it does not start anything. You must start the bridge yourself in a terminal.

WINDOWS — 5 steps
-----------------
1) Install Node.js 20.9 or newer (https://nodejs.org → LTS installer).
   Check in Command Prompt:      node -v

2) Open a terminal IN THIS FOLDER (the one containing package.json):
   - Open the folder in File Explorer, click the address bar, type: cmd
   - First time only, run:        npm install

3) Start the app (terminal window 1):
                                  npm run dev
   Then open http://localhost:3000 in your browser.

4) Start the OS speech bridge (terminal window 2 — a SECOND cmd window,
   opened the same way, in the same folder):
                                  npm run os-tts
   KEEP THIS WINDOW OPEN while you use the app.
   Success looks like:
     [os-tts] ..:..:.. OS Speech Bridge listening on http://127.0.0.1:8477
   (A first voice scan may add a line a few seconds later. If Windows
   Firewall asks for permission → click "Allow access".)

5) Back in the app (TTS Studio → "OS speech bridge" box):
   - Leave the URL field EMPTY (the app then uses the built-in default
     http://127.0.0.1:8477). If you typed anything there before, clear it —
     a typo like port 9477 instead of 8477 will keep the bridge "not ready".
   - Click "Retry". The box turns green: "online (N OS voices)".
     If the first Retry shows 0 voices or still not ready, wait ~5 seconds
     and press Retry once more — the very first voice scan (Windows runs
     PowerShell for it) can take a few seconds.

QUICK SELF-TEST
---------------
With the bridge running, open this in your browser:
    http://127.0.0.1:8477/ping
You should see JSON like {"ok":true,"platform":"win32","engines":{"sapi":true},...}
If that page works but the app still says "not reachable", tell the assistant
exactly what address your app is open at (http://localhost:3000 or a
https://... address) — HTTPS-hosted pages need the newest patch, which is
already applied in this ZIP.

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
- PATCH-NOTES.txt → notes shipped with this tree
