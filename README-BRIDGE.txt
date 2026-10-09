====================================================================
 OPENMUKTI AUDIOBOOK CREATOR — patched software + OS Speech Bridge 5
====================================================================

WHAT'S INSIDE
-------------
The complete app source PLUS the OS Speech Bridge version 5. The bridge
is the little local server that lets the web app render audio files with
the REAL voices installed on your Windows PC.

QUICK START (2 terminals, or use the standalone launcher)
---------------------------------------------------------
1) Install Node.js LTS from https://nodejs.org (once).
2) Terminal A:  npm install
                npm run dev            -> http://localhost:3000
3) Terminal B:  npm run os-tts
                -> "OS Speech Bridge listening on http://127.0.0.1:8477"
   Keep Terminal B OPEN while using the app.
4) In the app (TTS Studio -> Engine & Voice): leave the bridge URL field
   EMPTY and press Retry. The bridge box turns green.
   (You can also type the bare host: 127.0.0.1 — the app completes it.)

No Node/npm? Use the one-file launcher kit instead:
   scripts/bridge-standalone/start-bridge.bat  (see README-START-HERE.txt)

VERIFY THE BRIDGE IS v5
-----------------------
Open  http://127.0.0.1:8477/ping  in Chrome. You must see:
    "version":5  and  "platform":"win32"

WHAT IS NEW IN BRIDGE VERSION 5 — PIPER FIXED
---------------------------------------------
Piper voices could be listed but rendering them returned
"500 Internal Server Error". Root cause: the app never sends the model
file path (older app bundles only know voice NAMES), and the bridge
handed piper.exe an EMPTY --model, which exits instantly.

v5 fixes this completely, server-side (no app redeploy needed):
  - the bridge resolves the .onnx model path from the voice you picked
  - piper.exe runs with its own folder as working directory (DLLs and
    espeak-ng-data now resolve)
  - both piper CLI flavors work (classic C++ --output_file AND the
    newer Python piper1-gpl --output-file), with automatic fallback
  - partial piper installs are flagged: "piper: true, with warning —
    espeak-ng-data folder is missing next to it"
  - 500 responses now say "<engine> render failed: <real cause>" — the
    app toast shows the actual reason, never a bare error again

PIPER INSTALL CHECKLIST (free, offline)
---------------------------------------
1) piper Windows release zip from https://github.com/rhasspy/piper
2) Extract the WHOLE zip into C:\Program Files\piper (or %USERPROFILE%\piper)
   — piper.exe + all .dll + espeak-ng-data must stay together
3) Voice models (*.onnx + *.onnx.json) from
   https://huggingface.co/rhasspy/piper-voices into a "voices" folder
   next to piper.exe
4) Restart the bridge — /ping shows "piper":true, voices appear in the app

WHAT IS NEW IN BRIDGE VERSION 4 — NO MORE MYSTERIOUS "FALSE"
------------------------------------------------------------
v4 never leaves a "false" engine unexplained. The bridge console now
prints a REASON under every false entry, and /ping + /voices carry an
"engineInfo" map with the same reasons.

IF WINRT IS FALSE ON YOUR WINDOWS — THE TWO KNOWN CASES
-------------------------------------------------------
Case 1 — "0 OneCore voices are installed" (registry cross-check agrees):
Your Windows has NO modern voices. Typical of LTSC, Enterprise
evaluation, or de-bloated/custom images (Tiny11, Ghost Spectre, ...).
Fix (pick one, then restart the bridge):
  a) Settings -> Time & Language -> Speech -> Manage voices -> Add voices
     -> pick e.g. English (United States) / Microsoft Aria -> Install
  b) Admin PowerShell:
       Add-WindowsCapability -Online -Name Language.Speech~~~en-US~0.0.1.0
     (swap en-US for any language you want, e.g. hi-IN)
After installing, /ping must show "winrt":true and your voice count
jumps from 2 to 10+ (Aria, Jenny, Guy, language voices ...).

Case 2 — "WinRT projection failed: <error>":
The bridge could not load the modern speech API itself. Send the
console lines starting with  winrt  for diagnosis; v4+ prints the exact
exception (type + message + inner) and how many voice tokens the
registry holds, which pinpoints the cause (AV/WDAC policy, broken
speech runtime, ...).

WHAT IS NEW IN BRIDGE VERSION 3 — ALL YOUR WINDOWS VOICES
---------------------------------------------------------
Legacy SAPI 5 (System.Speech) can only ever see the two desktop voices
Microsoft David and Microsoft Zira. Bridge v3 ALSO talks to the modern
Windows speech stack (WinRT / OneCore), where the good voices live:

    winrt  ->  Microsoft Aria, Jenny, Guy, all "Natural" (neural)
               voices, plus every language pack you added
               (Hindi: Swara/Madhur, etc.)

Expected on a stock Windows 10/11:
    {"sapi":true,"winrt":true,"say":false,"espeak-ng":false,
     "espeak":false,"piper":false}
    Voices: 2 + (all OneCore voices — usually 10+)

The remaining "false" entries are engines that are simply not installed
on your PC — that is NORMAL, not an error:
    say        macOS only. Never true on Windows.
    espeak-ng  optional; https://github.com/espeak-ng/espeak-ng/releases
    piper      optional neural engine; see the checklist above

WANT MORE VOICES? (free, built into Windows)
--------------------------------------------
Settings -> Time & Language -> Speech -> Manage voices -> Add voices.
Pick any language/voice, let Windows download it, then restart the
bridge. It appears automatically.

ENGINE PRIORITY (when the app picks automatically)
--------------------------------------------------
Piper neural > Windows Natural (winrt) > legacy SAPI > espeak.
The engine that ACTUALLY rendered is always logged ("Engine actually
used") and returned in the X-OS-TTS-Engine header.

CONSOLE ERRORS, EXPLAINED
-------------------------
- net::ERR_CONNECTION_REFUSED on 127.0.0.1:8477/ping
      -> the bridge program was not running AT THAT MOMENT. Start it
         and keep the window open; then press Retry in the app.
         A web page can never start a PC program.
- "Could not find identifiable element" from web-client-content-script.js
      -> NOT this app. That file belongs to a Chrome EXTENSION you have
         installed. Ignore it, or test in an Incognito window.
- "No 'Access-Control-Allow-Origin' header..."
      -> your bridge is OLD (version 1). This zip ships version 5.
- Version check: /ping must say "version":5.

DEPLOYING THE APP TO GITHUB PAGES
---------------------------------
All bridge fixes are server-side — the GitHub Pages site does NOT need
to be redeployed to benefit from bridge v5. Redeploy only if you want
the app-side niceties (inline "why is an engine false" reasons, Piper
modelPath passthrough, WAV decode fallback).
