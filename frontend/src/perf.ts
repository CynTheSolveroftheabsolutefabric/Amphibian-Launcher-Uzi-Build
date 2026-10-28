// First-launch performance defaults, applied by rewriting lines of the game's options.txt before
// Minecraft reads it (the loader's IKVM_GAME_OPTIONS hook in loader/IkvmWasm.cs).
//
// Why: the game renders through a GL-on-WebGPU translation stack that is much heavier than native,
// and single-digit FPS on multiplayer servers is the common first impression when vanilla defaults
// (12 chunks, fancy graphics, all particles) meet it. The presets below trade a little visual
// range for a playable frame rate, on every machine, regardless of whether the browser's hardware
// acceleration toggle is on -- the GPU probe only decides HOW strict the first defaults are.
//
// They are applied exactly once: only when minecraft/options.txt does not exist yet in OPFS.
// After that the game owns its settings and user changes persist. Power users can override
// everything with ?wj.IKVM_GAME_OPTIONS=key:value,... or opt out with ?perf=0.
import type { GpuKind } from "./gpu-info";

// keys match options.txt lines: graphicsMode 0=fast 1=fancy, particleStatus 2=minimal,
// entityDistanceScaling is a fraction of the default entity render distance.
const SOFTWARE_SPEC =
        "renderDistance:5,simulationDistance:5,graphicsMode:0,particleStatus:2," +
        "entityShadows:false,entityDistanceScaling:0.5,biomeBlendRadius:0,mipmapLevels:0";
const HARDWARE_SPEC =
        "renderDistance:8,simulationDistance:8,graphicsMode:0,particleStatus:1," +
        "entityShadows:false,entityDistanceScaling:0.75,biomeBlendRadius:1";

export function performanceOptionsSpec(kind: GpuKind): string {
        return kind === "hardware" ? HARDWARE_SPEC : SOFTWARE_SPEC;
}

export interface AutoPerfInput {
        // A user-supplied ?wj.IKVM_GAME_OPTIONS=... (any value, even empty, counts as explicit).
        explicitSpec?: [string, string] | undefined;
        // Raw ?perf= query parameter, null when absent: "0"/"off" opts out, any other value
        // force-reapplies the defaults even when options.txt already exists.
        perfParam: string | null;
        // Whether minecraft/options.txt already exists in OPFS (i.e. the game ran here before).
        optionsTxtExists: boolean;
        // Result of the GPU probe (detectGpu()).
        gpuKind: GpuKind;
}

export interface AutoPerfDecision {
        // IKVM_GAME_OPTIONS value to set, or undefined when the launcher must not touch options.
        spec?: string;
        reason: string;
}

const PERF_OFF = new Set(["0", "off", "false", "no"]);

export function autoPerfOptions(input: AutoPerfInput): AutoPerfDecision {
        if (input.explicitSpec) {
                return { reason: `explicit ?wj.${input.explicitSpec[0]} wins` };
        }
        if (input.perfParam !== null && input.perfParam !== "") {
                if (PERF_OFF.has(input.perfParam.toLowerCase())) {
                        return { reason: `disabled via ?perf=${input.perfParam}` };
                }
                return { spec: performanceOptionsSpec(input.gpuKind), reason: `forced via ?perf=${input.perfParam}` };
        }
        if (input.optionsTxtExists) {
                return { reason: "minecraft/options.txt already exists — first-launch defaults are one-shot" };
        }
        const spec = performanceOptionsSpec(input.gpuKind);
        return { spec, reason: `first launch on ${input.gpuKind} WebGPU` };
}

// The game directory is /libsdl/minecraft inside the runtime; WASMFS mounts OPFS at /libsdl, so
// from the browser side it is the "minecraft" folder in the OPFS root -- the same folder the File
// Manager shows.
export async function gameOptionsFileExists(): Promise<boolean> {
        try {
                const root = await navigator.storage.getDirectory();
                await root.getFileHandle("minecraft/options.txt");
                return true;
        } catch {
                return false;
        }
}
