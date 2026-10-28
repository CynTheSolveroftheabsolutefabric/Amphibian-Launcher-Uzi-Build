# Amphibian Launcher

A Minecraft: Java Edition launcher that runs in your browser. You open a web page, pick a version, press Play, and the game opens in its own full-size tab. You can play vanilla Minecraft or Fabric with mods.

It is not an official Minecraft product and has nothing to do with Mojang or Microsoft.

You need a recent Chrome or Edge on a desktop computer. Firefox and Safari are not supported. A decent amount of free RAM helps a lot, and the game is slower than the normal launcher, so don't expect miracles on an old laptop.

## Using it

The launcher window has four parts. Here is what each one is.

**Top tabs** (along the top)
- PLAY: the home page. Shows a short getting-started guide.
- INSTALLATIONS: where you choose Vanilla or Fabric, the Minecraft version, and whether the game goes fullscreen on first click.
- ACCOUNT: where you sign in, or pick an offline username.
- CONSOLE: the game's logs, download progress, live FPS and memory, and the Stop game, Thread dump and JIT dump buttons.
- MODS & FILES: opens the file manager, where you add mods.

**Left sidebar**
- The game list. There is only one game in it.
- At the bottom is your account. Click it to jump to the ACCOUNT tab.

**Bottom bar**
- Left side, INSTALLATION: the version that will launch.
- Middle, the big green PLAY button. It stays grey until you have an account. The small yellow line under it tells you what is missing.
- Right side, PLAYING AS: the name you will have in game.

### First launch, step by step

1. Open the ACCOUNT tab and pick one:
   - MICROSOFT: press SIGN IN WITH MICROSOFT. You get a link and a QR code. Open it, log in, and come back. You need an account that owns Minecraft: Java Edition.
   - OFFLINE: type a username, 3 to 16 letters, numbers or underscores. No account needed.
2. Open the INSTALLATIONS tab. Pick VANILLA or FABRIC (MODS), then type the Minecraft version you want, for example `1.21.4`. Versions from 1.13 up to 26.2 are supported. With Fabric, leave the loader version as it is unless a mod asks for a newer one. You can also switch Vanilla/Fabric right next to the PLAY button.
3. Press PLAY. The launcher switches to the CONSOLE tab and opens the game in a new tab.
4. The first time, the launcher downloads the game into your browser's storage. The progress bar and logs are in the CONSOLE tab. It can take several minutes. Later launches skip this and only download again if you change the version or type.

### Offline accounts

Offline mode lets you play without signing in. It has limits:
- Singleplayer works.
- Multiplayer only works on servers that have `online-mode=false` in their settings.
- Servers that check accounts will not let you in.
- You will not have a skin.

### Adding mods

1. Click MODS & FILES in the top tabs.
2. Navigate to `minecraft/mods` (create the folder if needed), then press Upload files and select your `.jar` files. The same upload control accepts any file type and uploads into the folder currently open. You can also drag files onto the file list.
3. Choose FABRIC (MODS) and press PLAY. Mods are only read when the game starts, so if the game is already running, quit it first.

Things that go wrong with mods:
- The mod must be made for the exact Minecraft version you are launching, and for Fabric.
- Many mods also need Fabric API. Download the Fabric API jar for the same version and add it the same way.
- If the log shows Fabric Loader classes loading and then the game stops, a mod was rejected. Scroll up in the log and look for lines like "requires version" or "incompatible mod set". They name the mod and the reason.
- Some mods change so much of the game that they may not work in a browser at all.

Other file-manager actions:
- Upload files: any file type, into the folder you have open.
- Upload Folder: a whole folder.
- Upload Folder Archive / Download Folder Archive: move a folder in or out as a `.tar` file. Handy for backing up worlds.

Your worlds, settings and mods are stored in the browser. Clearing site data for this page deletes them, so download an archive of anything you care about.

### The game tab

The launcher keeps everything: accounts, files, logs and stats. The game tab has only Minecraft in it, sized to fill the tab. Because that tab cannot make itself fullscreen without a click, the first click or key press in it goes fullscreen (turn this off in INSTALLATIONS, or press F11 yourself).

The game opens as a new tab of the same site (the same address with `?game=...` on the end), so you need to allow pop-ups for the site, because the launcher opens the tab when you press PLAY.

Vanilla and Fabric share the same downloaded game files, so switching between them only downloads the Fabric parts the first time. Vanilla ignores the `mods` folder.

### Quitting

Use Quit Game or Save and Quit inside Minecraft. When the game closes, its tab closes by itself and the launcher is ready for the next PLAY. This is the safe way, because it saves your world.

If the game freezes, press STOP GAME in the CONSOLE tab (or just close the game tab). That stops the game immediately and anything unsaved is lost.

If the game stops with an error, a red message appears in the CONSOLE tab with the exit code, and the log shows what happened.

### Which browser to use

The game needs a **WebGPU-capable desktop browser**. Best performance, in order:

1. **Chrome or Edge (113 or newer) on Windows** — the standard choice. They share the same engine,
   so performance is equal; pick whichever you keep updated. If you are on Edge, that is completely
   fine. Turn off "Efficiency mode" while gaming (edge://settings/system), plug the laptop in, and
   make sure **hardware acceleration** is on: edge://settings/system for Edge,
   chrome://settings/system for Chrome. You can check what the browser actually gives the game at
   `edge://gpu` / `chrome://gpu` — the "WebGPU" row should say **Hardware accelerated**. The
   launcher also prints its own probe line, `[gpu:game] ...`, in the Console tab.
2. **Chrome or Edge on macOS and on Linux with working GPU drivers** — equally good when
   `chrome://gpu` shows hardware WebGPU.
3. **Firefox 141 or newer on Windows** — works, WebGPU there is Windows-only for now and generally
   a bit behind Chromium in speed for this game.

Not recommended / not working:

- **Mobile browsers** (Android or iOS) — the runtime needs desktop-class WebAssembly and a large
  memory budget that phones do not provide.
- **Safari** — WebGPU support is too new and the game's runtime is not supported there.
- **Chromebooks** — many only expose a software WebGPU, which means single-digit FPS no matter
  what settings you use (see the `[gpu:game]` line in the Console).

Whatever browser you pick: keep it updated, update your GPU drivers, and close other heavy tabs
while playing. The Console tab's `[gpu:game]` line tells you in one glance whether you got a
hardware or a software adapter.

### Performance and FPS

The game renders through a GL-on-WebGPU translation stack, which is much heavier than native
Minecraft, so vanilla's default video settings can land you at single-digit FPS — especially on
multiplayer servers. To avoid that first impression, the launcher applies tuned settings
(render distance 5–8, simulation distance, fast graphics, minimal particles, no entity shadows) to
`options.txt` exactly once, on the very first launch of the game in a browser profile. How strict
they are depends on what WebGPU adapter the browser offers: a software adapter (SwiftShader,
llvmpipe — hardware acceleration off, blocklisted drivers, many Chromebooks, VMs) gets the strict
set, and the Console log prints a `[gpu:game]` line plus a `[perf]` line showing exactly what was
applied.

After that first launch the launcher never touches your settings again — change everything in-game
under Options > Video Settings (or edit `minecraft/options.txt` in the File Manager). Escape
hatches: `?perf=0` disables the auto defaults entirely, `?perf=1` re-applies them on the next
launch, and `?wj.IKVM_GAME_OPTIONS=renderDistance:12,...` overrides the preset with your own lines.

If FPS is still low with a hardware adapter in the `[gpu:game]` line, the usual fixes apply:
hardware acceleration on (chrome://settings/system), current GPU drivers, few other tabs open.
Note that the game log always shows its device as "(Mesa)" — that is the game's own GL layer, not
a sign that your GPU is unused; the `[gpu:game]` line is the one that tells the truth.

### Changing the wallpapers

The background pictures are in `frontend/public/backgrounds`. To use your own, put an image there (wide screenshots work best, around 1920 pixels across) and add its file name to the `BACKGROUNDS` list near the top of the launcher code in `frontend/src/main.tsx`. With more than one picture, the launcher fades between them every few seconds.

## Putting it online with GitHub Pages

This repo has a workflow that builds the site and publishes it. It is **manual-only** — it never runs on push, because the build is very heavy and running it on every push can get young accounts flagged by GitHub's automation. Test locally with Docker instead, and run the workflow by hand only when you have a batch of changes ready to go live.

1. Make a public repository on GitHub and push this project to its `main` branch.
2. In the repository go to Settings, then Pages, then set Source to GitHub Actions.
3. Open the Actions tab, pick "Build and deploy to GitHub Pages" and press Run workflow — only when you actually want to publish. The first build takes a long time.
4. When both jobs are green, the site is at `https://<your-username>.github.io/<repository-name>/`.

The first time you open the site it reloads once. That is normal. GitHub Pages can't send the headers the game needs, so a small service worker (`frontend/public/coi-serviceworker.js`) adds them.

Pages sites are limited to 1 GB. If the build is bigger, the deploy fails and the Actions log says so.

## Building it yourself

You need Linux, .NET 10, a JDK, and mono.

1. In the `loader` folder run `sudo dotnet workload restore`.
2. In the top folder run `make build`.
3. `make serve` starts a development copy. Don't host that one publicly.
4. `make publish` makes the real build in `frontend/dist`.

### A note on the `dreamland` dependency

The UI framework (`dreamland`) is vendored as a prebuilt tarball in `vendor/dreamland-0.1.3.tgz` and
referenced from `frontend/package.json` as `file:../vendor/dreamland-0.1.3.tgz`. The upstream git
repository does not ship its built `dist/` files (and its build script never runs during a plain
`npm install` / `pnpm install`), so depending on it directly used to break the whole build with
"Cannot find module 'dreamland/core'". If you ever want to bump it, clone the repo, run its build,
`npm pack`, and drop the new tarball in `vendor/`.

## Debugging knobs

- `?netlog=1` on either page turns per-packet network tracing back on. It is off by default because
  dumping every TCP chunk to the console (and mirroring it into the launcher log) is expensive
  enough on a multiplayer server to cost a large chunk of FPS.
- `?perf=0` / `?perf=1` disable or force the first-launch performance defaults (see "Performance
  and FPS" above); `?wj.IKVM_GAME_OPTIONS=key:value,...` overrides any game option before launch.
- The Console tab keeps the thread dump / JIT dump / Stop game buttons; memory and FPS stats update
  there live while a game runs.

## Credits

This launcher is a front end for ikvmcraft by r58Playz (https://github.com/r58playz/ikvmcraft), which does the hard part: running Minecraft in the browser with mono-wasm and a modified IKVM. All the credit for that goes to them.
