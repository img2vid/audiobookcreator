START HERE — OS Speech Bridge (standalone, no npm install needed)
==================================================================

This kit is the bridge PROGRAM alone. The app (https://img2vid.github.io
or localhost:3000) is only a web page — a web page can NEVER start a
program on your PC. This kit IS the program, and it must be running
while you use the app.

1) You need Node.js 20.9+ once: install the LTS from https://nodejs.org
   (check: open Command Prompt and type  node -v)

2) BEFORE extracting (only if the .bat still flashes and closes):
   Right-click the downloaded ZIP -> Properties -> tick "Unblock"
   -> OK. Then extract the WHOLE zip into a folder (e.g. C:\bridge\).

3) Double-click  start-bridge.bat
   - A black window opens and must show:
       OS Speech Bridge listening on http://127.0.0.1:8477
   - KEEP THAT WINDOW OPEN (minimizing is fine). Closing it stops TTS.
   - If Windows Firewall asks: click "Allow access".
   - If it says "node is not recognized": install Node.js from
     https://nodejs.org and run the .bat again.

4) Prove it works: open  http://127.0.0.1:8477/ping  in Chrome.
   You must see JSON containing  "version":5  and  "platform":"win32".

5) In the app: leave the bridge URL field EMPTY, press Retry.
   The bridge box turns green: "online (N OS voices)".

WHAT THE ENGINE LIST MEANS ("Detected engines: {...}")
------------------------------------------------------
true  = that engine is installed and usable on your PC.
false = that engine is NOT on your PC. That is NORMAL and expected:

  winrt      Windows Natural Voices — Aria, Jenny, Guy, all "Natural"
             (neural) voices and every language pack you added.
             TRUE on Windows 10/11 by default. This is the BEST engine
             on Windows and the app uses it first.
  sapi       Legacy Windows voices (Microsoft David, Zira). TRUE by
             default. Only these 2 exist there — that is a Windows
             limitation, not a bug.
  say        macOS only — always false on Windows. Normal.
  espeak-ng  Optional free engine. FALSE until you install it from
             https://github.com/espeak-ng/espeak-ng/releases
  espeak     Same as above (classic version).
  piper      Optional neural engine. FALSE until you download the
             piper release zip from https://github.com/rhasspy/piper
             and put *.onnx voice models in a "voices" folder next to
             piper.exe (or the folder this kit is in).

"Voices: 2" earlier meant only the legacy SAPI voices were visible.
Bridge version 3+ ALSO enumerates the modern natural voices, so the
app lists Aria/Jenny/Guy and friends automatically — no install
needed. Want MORE voices? Windows Settings -> Time & Language ->
Speech -> Manage voices -> Add voices, then restart this .bat.

IF winrt SHOWS FALSE ON YOUR WINDOWS — v4 PRINTS THE REASON
-----------------------------------------------------------
Right under "Detected engines: {...}" the console now prints one line
for every false engine. The winrt case has two known causes:

1) "0 OneCore voices are installed" + registry cross-check shows
   Speech_OneCore tokens = MISSING or 0:
   Your Windows build ships WITHOUT modern voices (typical of LTSC,
   Enterprise evaluation, or de-bloated images like Tiny11). Fix:
     Settings -> Time & Language -> Speech -> Manage voices ->
     Add voices -> pick English (United States) -> Install
   or, in an ADMIN PowerShell:
     Add-WindowsCapability -Online -Name Language.Speech~~~en-US~0.0.1.0
   Then close this window and run start-bridge.bat again. /ping must
   then show "winrt":true and 10+ voices.

2) "WinRT projection failed: <exception>":
   The modern speech API itself could not load (security software or a
   broken speech runtime). Screenshot the console lines that start
   with  winrt  and send them to the assistant — they contain the
   exact error needed to fix it.

The remaining false engines are normal: say = macOS-only, espeak-ng /
espeak / piper = optional installs (see the list above).

IF THE WINDOW STILL CLOSES INSTANTLY — see the real error:
   a) Press Start, type: cmd, press Enter
   b) Drag start-bridge.bat FROM the folder INTO the black window
   c) Press Enter — now the window stays open and shows the error
   Screenshot what it prints and send it to the assistant.

PIPER 500 ERRORS — FIXED IN BRIDGE v5
-------------------------------------
If Piper voices were listed but rendering them gave a 500 error, that
was a bridge bug: the app never sends the model file path, and the old
bridge passed an EMPTY --model to piper.exe, which exits instantly.
v5 resolves the model path on the bridge side from the voice you
picked — no app redeploy needed, just replace the kit.

v5 also:
- runs piper.exe with its own folder as working directory (fixes DLL /
  espeak-ng-data "file not found" crashes)
- supports BOTH piper CLI flavors (classic C++ --output_file and the
  newer Python piper1-gpl --output-file), falling back automatically
- prints "piper: true, with warning — espeak-ng-data folder is missing
  next to it" when the piper release zip was only partially extracted
- puts the REAL failure reason into the 500 response, so the app toast
  names the engine and cause instead of a bare "Internal Server Error"

Piper install checklist (free, offline, ~60 MB per voice):
  1. Download the piper Windows release zip (github.com/rhasspy/piper)
  2. Extract the WHOLE zip (piper.exe + *.dll + espeak-ng-data together)
     into C:\Program Files\piper  (or %USERPROFILE%\piper)
  3. Download .onnx + .onnx.json voice models from
     https://huggingface.co/rhasspy/piper-voices — put them in a
     "voices" folder next to piper.exe
  4. Restart this .bat — /ping must show "piper":true and the voice
     appears in the app automatically
