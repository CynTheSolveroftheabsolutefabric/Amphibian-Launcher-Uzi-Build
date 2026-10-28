// One-glance answer to "what will the game render with?". ikvmcraft renders through its own
// Mesa-in-WASM GL layer on top of the browser's WebGPU, so the "(Mesa)" device string in the game
// log appears even when real hardware sits underneath -- it does NOT tell you whether the browser
// handed out a hardware or a software adapter. When the browser only offers a software adapter
// (SwiftShader / llvmpipe / lavapipe -- hardware acceleration off, blocklisted GPU drivers,
// Chromebooks without hardware WebGPU, VMs/remote desktop), the game crawls at single-digit FPS.
//
// This probe classifies the adapter once per page and is shared by the boot log line and the
// launcher's first-launch performance defaults in perf.ts.
export type GpuKind = "hardware" | "software" | "none" | "unknown";

export interface GpuProbe {
        kind: GpuKind;
        // Human-readable one-liner for logs, e.g. "hardware WebGPU adapter (ANGLE (NVIDIA, ...))".
        summary: string;
}

// Device strings of the CPU rasterizers browsers fall back to. Plain "Mesa" is deliberately NOT
// on this list: Mesa is also the driver stack under hardware WebGPU on Linux/ChromeOS.
const SOFTWARE_PATTERN = /swiftshader|llvmpipe|lavapipe|softpipe|software renderer/i;

// Pure classification of one adapter, split out of the probe so tests can drive it directly.
export function classifyAdapter(
        isFallback: boolean | undefined,
        info: Record<string, unknown>
): { kind: GpuKind; text: string } {
        const text = [info.vendor, info.architecture, info.device, info.description]
                .filter((v) => typeof v === "string" && v !== "")
                .join(" ");
        if (isFallback === true || SOFTWARE_PATTERN.test(text)) return { kind: "software", text };
        if (text !== "") return { kind: "hardware", text };
        return { kind: "unknown", text };
}

let probe: Promise<GpuProbe> | undefined;

export function detectGpu(): Promise<GpuProbe> {
        if (!probe) probe = requestGpuProbe();
        return probe;
}

async function requestGpuProbe(): Promise<GpuProbe> {
        try {
                const gpu = (navigator as any).gpu;
                if (!gpu) {
                        return {
                                kind: "none",
                                summary:
                                        "WebGPU is not available in this browser at all. The game needs a WebGPU-capable browser (Chrome/Edge 113+, Firefox 141+ on Windows).",
                        };
                }
                const adapter = await gpu.requestAdapter();
                if (!adapter) {
                        return {
                                kind: "none",
                                summary:
                                        "requestAdapter() returned null: the browser exposes no WebGPU adapter (open chrome://gpu to see why).",
                        };
                }
                // adapter.info is standard in newer builds; older ones expose requestAdapterInfo().
                const info = (adapter.info ?? (typeof (adapter as any).requestAdapterInfo === "function"
                        ? await (adapter as any).requestAdapterInfo()
                        : {})) as Record<string, unknown>;
                const { kind, text } = classifyAdapter(adapter.isFallbackAdapter, info);
                const short = text !== "" ? ` (${text.slice(0, 120)})` : "";
                if (kind === "software") {
                        return { kind, summary: `software WebGPU adapter${short}` };
                }
                if (kind === "hardware") {
                        return { kind, summary: `hardware WebGPU adapter${short}` };
                }
                return {
                        kind,
                        summary:
                                "WebGPU adapter that exposes no info (some browsers hide it); conservatively treated as software",
                };
        } catch (error) {
                return {
                        kind: "unknown",
                        summary: `adapter probe failed: ${error instanceof Error ? error.message : String(error)}`,
                };
        }
}

export async function reportGpuAdapter(scope: string): Promise<void> {
        const p = await detectGpu();
        switch (p.kind) {
                case "hardware":
                        console.info(`[gpu:${scope}] ${p.summary}`);
                        break;
                case "software":
                        console.warn(
                                `[gpu:${scope}] ${p.summary} — the game will run slowly. Enable hardware acceleration (chrome://settings/system), check chrome://gpu, update your GPU drivers, or use a different browser/device.`
                        );
                        break;
                default:
                        console.info(`[gpu:${scope}] ${p.summary}.`);
                        break;
        }
}
