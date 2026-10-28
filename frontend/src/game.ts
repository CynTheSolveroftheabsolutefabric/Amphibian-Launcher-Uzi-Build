import { loglisteners, type Log } from "./dotnet/log";
import { bridgeName, type ToGame, type ToLauncher } from "./bridge";
import { reportGpuAdapter } from "./gpu-info";

// Prints what WebGPU adapter the browser actually offers. The game's own log shows "(Mesa)" either
// way (its GL layer is Mesa-in-WASM), so this probe is the only honest answer: if the browser hands
// out a software adapter the game crawls at single-digit FPS, and the log line + the launcher's
// first-launch perf defaults (perf.ts) both react to it.
void reportGpuAdapter("game");

// The game page. It shows Minecraft and nothing else: the canvas fills the whole tab. Everything the launcher used to
// show around the game (logs, stats, thread dump, mods) lives in the launcher now, and this page reports to it over
// the bridge channel.

const id = new URLSearchParams(location.search).get("game") ?? "";
const channel = new BroadcastChannel(bridgeName(id));
const send = (message: ToLauncher) => channel.postMessage(message);

// Forward every console line to the launcher. Batched, because the runtime can be very chatty.
const pending: Log[] = [];
loglisteners.push((line) => pending.push(line));
setInterval(() => {
        for (let i = 0; i < pending.length; i += 400)
                send({ type: "logs", lines: pending.slice(i, i + 400) });
        pending.length = 0;
}, 100);
addEventListener("error", (e) => console.error("[game] uncaught error:", e.message));
addEventListener("unhandledrejection", (e) => console.error("[game] unhandled rejection:", String(e.reason)));

// Page: one full-size canvas. The wrapper keeps the "canvas" class because the runtime resizes the canvas to follow
// the element matching ".canvas" (see glfwMakeCanvasResizable in dotnet/index.ts).
const style = document.createElement("style");
style.textContent = `
        html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: #000; }
        .canvas { position: fixed; inset: 0; width: 100vw; height: 100vh; background: #000; }
        .canvas canvas { display: block; width: 100%; height: 100%; outline: none; }
        .note { position: absolute; left: 0; right: 0; bottom: 1.5rem; text-align: center; color: rgba(255,255,255,.55);
                font: 500 .9rem system-ui, sans-serif; pointer-events: none; padding: 0 1rem; }
`;
document.head.append(style);
document.title = "Minecraft";

const canvas = document.createElement("canvas");
canvas.id = "canvas";
canvas.addEventListener("contextmenu", (e) => e.preventDefault());
const note = document.createElement("div");
note.className = "note";
note.textContent = "Waiting for the launcher...";
const root = document.createElement("div");
root.className = "canvas";
root.append(canvas, note);
// A stale service worker can serve an index.html without the #app placeholder; fall back to the body
// instead of crashing on the replaceWith.
const host = document.querySelector("#app");
if (host) host.replaceWith(root);
else document.body.append(root);

// Close this tab (it was opened by the launcher, so the browser allows it).
const closeTab = () => window.close();

const fail = (message: string) => {
        console.error(message);
        send({ type: "failed", message });
        note.textContent = message;
        setTimeout(closeTab, 400);
};

// Fullscreen needs a user gesture inside this document, so the first click or key press on the game does it.
const armFullscreen = () => {
        const go = () => {
                removeEventListener("pointerdown", go, true);
                removeEventListener("keydown", go, true);
                document.documentElement.requestFullscreen?.({ navigationUI: "hide" }).catch(() => {});
        };
        addEventListener("pointerdown", go, true);
        addEventListener("keydown", go, true);
};

let jit: typeof import("./dotnet/jitbench") | undefined;
let started = false;

async function boot(config: Extract<ToGame, { type: "config" }>) {
        note.textContent = "Starting runtime...";
        if (!crossOriginIsolated) {
                fail(
                        "This tab is not cross-origin isolated, so the game cannot start here. Reload the launcher once (the first visit installs the service worker that enables it) and press PLAY again."
                );
                return;
        }
        if (config.fullscreen) armFullscreen();

        try {
                // Registers the JIT debug globals the runtime looks for (captureJitSlotBaseline and friends) before it starts.
                jit = await import("./dotnet/jitbench");
                const { initDotnet, play, dotnetState, setGameExitHandler } = await import("./dotnet");

                // The runtime can only start once per page, so a finished game ends the whole tab; the next Play opens a new one.
                setGameExitHandler((code) => {
                        send({ type: "exit", code });
                        setTimeout(closeTab, 400);
                });

                await initDotnet(canvas);

                setInterval(
                        () =>
                                send({
                                        type: "stats",
                                        stats: {
                                                fps: dotnetState.fps,
                                                fpsAvg: dotnetState.fpsAvg,
                                                gcMemory: dotnetState.gcMemory,
                                                gcHeapMemory: dotnetState.gcHeapMemory,
                                                nativeMemory: dotnetState.nativeMemory,
                                                heapMemory: dotnetState.heapMemory,
                                                wasmMemory: dotnetState.wasmMemory,
                                        },
                                }),
                        1000
                );
                // The status line goes away with the first rendered frame, leaving only the game.
                const frames = setInterval(() => {
                        const count = (globalThis as any).wasm?.Module?._emscripten_glfw3_get_frame_count?.();
                        if (count > 0) {
                                clearInterval(frames);
                                note.remove();
                        }
                }, 250);

                note.textContent = "Starting Minecraft...";
                send({ type: "running" });
                await play(config.versionId, config.auth);
        } catch (error) {
                console.error("Minecraft launch failed", error);
                fail(error instanceof Error ? error.message : String(error));
        }
}

channel.onmessage = (event: MessageEvent<ToGame>) => {
        const message = event.data;
        switch (message.type) {
                case "config":
                        if (started) break;
                        started = true;
                        clearInterval(hello);
                        void boot(message);
                        break;
                case "status":
                        if (!started) note.textContent = message.text + "...";
                        break;
                case "command":
                        try {
                                if (message.command === "threadDump")
                                        (globalThis as any).wasm.Module.ccall("perform_thread_dump");
                                else jit?.dumpWasmJit();
                        } catch (error) {
                                console.error("[game] command failed", message.command, error);
                        }
                        break;
        }
};

// The launcher answers "hello" with the config once the game files are ready, so this keeps asking until it does.
const hello = setInterval(() => send({ type: "hello" }), 500);
send({ type: "hello" });
