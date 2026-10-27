# Base44 sandbox notes (FM1 Open)

## What runs here
Only the **browser workbench** (`web/` + `app/` + `third_party/synth` compiled to WebAssembly and
served as one self-contained HTML page). The device firmware (`build.bat`, `sdk/Build.ps1`) needs
Windows and the JieLi PI32 clang toolchain and is out of scope in this sandbox.

- Compose: `docker-compose.base44.yml` → service `web` on host port **3000**.
- Image `.base44/Dockerfile.web`: `node:22` plus WASI SDK 27 (Linux archive, checksum pinned) at
  `/opt/wasi-sdk`. Only the toolchain lives in the image; the repo is bind-mounted at `/workspace`.
- Startup: `node tools/Build-Web-Preview.mjs && node tools/Serve-Web-Preview.mjs`.

No database, API, or external credentials are involved, so there are no secrets.

## Why the extra scripts exist
`tools/Build-Web.ps1` is the reference (Windows/PowerShell) build. It hardcodes `clang.exe`, a
Windows WASI SDK path and `\\?\` long-path handling, so it cannot run on Linux.
`tools/Build-Web-Preview.mjs` mirrors `Build-Web.ps1 -LocalPreview`: same compiler flags, same
source set (`app/` minus `app/board/`, `web/`, `third_party/synth/`), same `sdk/Update.html.in`
templating. Output: `build/web/simulator.wasm` and `build/preview/index.html` (both gitignored).
`tools/Serve-Web-Preview.mjs` is a plain static server for that one file.

The build is cached: a restart reuses the existing `simulator.wasm` when no C source changed.

## Rebuilding after a C edit
```bash
docker compose -f docker-compose.base44.yml exec -T web node tools/Build-Web-Preview.mjs
```
The server re-reads the file per request, so reloading the page picks up the new build (no restart).
Compile errors surface in `docker compose -f docker-compose.base44.yml logs web`; the build uses
`-Werror`, so any warning fails it.

## Quirks worth knowing
- `sdk/Update.html.in` has **no explicit `<head>`/`<body>`** (the parser infers them). Tooling that
  injects scripts by HTML rewrite — including this sandbox's preview bridge — then finds nothing to
  inject into and the app cannot be inspected. `Serve-Web-Preview.mjs` therefore frames the served
  document with `<head>`/`<body>` at request time; the built file stays exactly as the build made it.
- Audio runs in an `AudioWorklet` thread and needs a user gesture; a headless browser has no audio
  device, so playback itself cannot be verified automatically — the panel, engine and LCD can.
- `build/` is gitignored, so the preview output never gets committed.

## Verify it works
```bash
curl -s -o /tmp/p.html -w '%{http_code} %{size_download}\n' http://localhost:3000/
grep -c 'id="sim-screen"' /tmp/p.html      # expect ~3
```
In the browser the engine status reads "Panel ready" / "Ready to play", the LCD canvas is painted,
and loading the next built-in preset renames the project and redraws the LCD.
