// --- benchmark input injector -------------------------------------------------------------------
// Drives a deterministic, repeatable movement path so jiterpreter heat / bailout counters and frame
// time can be sampled over a fixed window. emscripten-glfw listens for keydown/keyup on `document`
// and reads e.code (KeyboardMapping.h), so dispatching synthetic KeyboardEvents drives the game
// exactly like real keys. GLFW tracks press/release state (polled via glfwGetKey each frame), so a
// single keydown "presses" a key until we send keyup — no need to spam repeat events.
//
// Mouse-look is deliberately NOT injected: turning needs movementX/Y under pointer lock, which a
// synthetic event can't acquire (pointer lock requires a real user gesture). Walking forward through
// a superflat world is the deterministic render workload we want — new chunks continuously come into
// view ahead and get meshed (the vertex-consumer / chunk-mesh hot path), without camera variance.
//
// Recommended setup before running: a frozen superflat world at a fixed spawn —
//   /gamerule doDaylightCycle false   /time set day
//   /gamerule doWeatherCycle false    /weather clear
//   /gamerule randomTickSpeed 0       /difficulty peaceful
// The button in the UI disables while this runs and re-enables when done: that is your measurement
// window. Snapshot counters (dumpJiterpHeat / bailout totals) when it disables and again when it
// re-enables, diff, and normalize per-frame.

function benchKey(type: "keydown" | "keyup", code: string, key: string) {
	document.dispatchEvent(new KeyboardEvent(type, { code, key, repeat: false, bubbles: true, cancelable: true }));
}
const benchSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let benchStop: (() => void) | null = null;
export const benchRunning = () => benchStop !== null;

/**
 * Walk the player on a fixed path for `durationMs` (default 60s): sprint forward the whole time,
 * alternating a strafe right/left every 4s so the path covers terrain in more than one direction
 * while staying deterministic. Resolves when finished or when stopBench() is called. Always releases
 * every key it pressed, even on error/stop.
 */
export async function benchWalk(durationMs = 60000): Promise<void> {
	if (benchStop) { console.warn("[bench] already running"); return; }

	let stopped = false;
	benchStop = () => { stopped = true; };
	const start = performance.now();
	const elapsed = () => performance.now() - start;

	// every key we might press; released unconditionally in finally
	const allKeys: [string, string][] = [["KeyW", "w"], ["ControlLeft", "Control"], ["KeyD", "d"], ["KeyA", "a"]];

	console.log(`[bench] walk start: ${durationMs}ms (sprint forward + alternating strafe)`);
	try {
		benchKey("keydown", "ControlLeft", "Control"); // sprint (1.16 default keybind)
		benchKey("keydown", "KeyW", "w");               // forward, held throughout

		let curStrafe: "KeyD" | "KeyA" | null = null;
		while (!stopped && elapsed() < durationMs) {
			// 4s phases: forward-only, +right, forward-only, +left, repeat
			const phase = Math.floor(elapsed() / 4000) % 4;
			const want: "KeyD" | "KeyA" | null = phase === 1 ? "KeyD" : phase === 3 ? "KeyA" : null;
			if (want !== curStrafe) {
				if (curStrafe) benchKey("keyup", curStrafe, curStrafe === "KeyD" ? "d" : "a");
				if (want) benchKey("keydown", want, want === "KeyD" ? "d" : "a");
				curStrafe = want;
			}
			await benchSleep(200); // poll stop/elapsed every 200ms
		}
	} finally {
		for (const [code, key] of allKeys) benchKey("keyup", code, key);
		benchStop = null;
		console.log(`[bench] walk done after ${Math.round(elapsed())}ms`);
	}
}
(globalThis as any).benchWalk = benchWalk;

/** Stop an in-progress benchWalk/benchMeasure early (resolves its promise within ~200ms). */
export function stopBench() { benchStop?.(); }
(globalThis as any).stopBench = stopBench;

// --- benchmark measurement harness --------------------------------------------------------------
// Passive: YOU walk the test area for the window; this samples it (no input injection). Brackets the
// window with a heat dump (so you get the abort@ method list before & after) and reports frames, fps,
// ms/frame and per-reason bailout deltas (total + per-frame) — the actionable numbers for A/B'ing a
// runtime change like --jiterpreter-call-continue. The button disables for the whole window = "walk now".
//
// Frame count is emscripten-glfw's swapBuffers() (one bump per presented frame) via a shared-memory
// atomic. CAVEAT: if the scene is under the vsync cap (e.g. a light world at 60fps/6rd), ms/frame is
// vsync-bound, not compute-bound — pick a heavy enough scene (real world / higher render distance) to
// drop below 60 so the metric reflects real frame cost. Bailout deltas are only nonzero on a
// --jiterpreter-count-bailouts build (which itself adds overhead), so read frametime from a clean
// build and bailout deltas from a count-bailouts build — two runs.

// BailoutReason values (jiterpreter-enums.ts)
const BENCH_BAILOUTS: [string, number][] = [
	["Branch", 4], ["BackwardBranch", 5], ["Return", 14], ["Call", 15], ["AllocFailed", 17],
];
const benchFrameCount = (): number => {
	const f = (globalThis as any).wasm?.Module?._emscripten_glfw3_get_frame_count;
	return typeof f === "function" ? f() : NaN;
};
const benchBailout = (reason: number): number => {
	const f = (globalThis as any).wasm?.Module?._mono_jiterp_get_trace_bailout_count;
	return typeof f === "function" ? f(reason) : NaN;
};
// wasm method-JIT counters (need MONO_WASM_JIT_STATS=1). The runtime now exposes ONE generic getter
// (Module._mono_wasm_jit_get_counter(idx)) backed by a gint64 array; this enum mirrors the C WJC_*
// enum in src/mono/mono/mini/mini-wasm.h BY INDEX — KEEP IT IN SYNC (same order, append-only).
// ELAPSED_* are microseconds; BytesGenerated is bytes; everything else is a plain count.
const WJ = {
	Registered: 0, Bailed: 1, Invalid: 2,
	Invoke: 3, Residual: 4, Fastvcall: 5,
	AotRouted: 6, InterpRouted: 7,
	VicHit: 8, VicMiss: 9, VfastHad: 10, VfastNew: 11, VfbThresh: 12, VfbPerm: 13,
	VpermEh: 14, VpermLdaddr: 15, VpermLcmp: 16, VpermOtherop: 17, VpermOther: 18,
	BytesGenerated: 19, ElapsedGeneration: 20, ElapsedInstantiation: 21, CompileAttempts: 22,
	IslandAttempt: 23, IslandCompleted: 24, IslandBudgetExhausted: 25, IslandDepthExceeded: 26,
	IslandBlockedCold: 27, PromotedUp: 28, PromotedDown: 29,
	VpermSig: 30, VpermByref: 31, VpermGshared: 32, VpermSync: 33, VpermEhOther: 34, VpermAot: 35,
	VcallAotFast: 36,
	// event-driven blocker waiting: Parked = times a method parked on cold blocker(s) instead of
	// poll-retrying; WaiterWoken = total waiters re-queued when a blocker JITted.
	Parked: 37, WaiterWoken: 38,
	// below-threshold vcall fallback (VfbThresh) split by the target's slot state — cold (slot 0, interp is
	// fine) vs parked (-2, island won't close) vs retry (-3). Parked = the real interp-residual driver.
	VfbCold: 39, VfbParked: 40, VfbRetry: 41,
	// fast-path VOLUME counters (emitted, gated by MONO_WASM_JIT_PROFILE_FAST=1): dispatch paths that
	// otherwise call no counting helper, so we can attribute frame cost. FastInlineAot = INLINE_AOT direct;
	// FastVic = inline f-slot IC hit (JIT->JIT); FastAotic = inline AOT-IC hit (JIT->AOT). 0 unless profiling.
	FastInlineAot: 42, FastVic: 43, FastAotic: 44,
	// GC-classification alignment: vregs the REFBASES deref-pinning pass flipped that structural seeds missed.
	RefbasesExtra: 45,
	// rgctx CALLSITE bails (bail -12, split out of VpermGshared): concrete method whose body makes an
	// indirect/virtual call carrying the callsite rgctx — per-site fixable, unlike the whole-method gate (-8).
	VpermRgctx: 46,
	// vtype ABI coverage (WS-B B3): methods registered with >=1 by-addr vtype arg / with a hidden vret.
	VtByaddrMethods: 47, VretMethods: 48,
	// transition-elision paths: immutable direct residual sites whose callee later acquired an f-slot,
	// and scalar Delegate.Invoke recipes dispatched straight to the target f-thunk.
	ResidualHealed: 49, FastDelegate: 50, DelegateIcHit: 51,
	// GC pin-pressure accounting (compile-time, summed over all compiles): frame ref slots allocated;
	// write-through ref vregs (local is home, slot is the pin mirror); isref vregs that needed NO slot
	// (no GC point in their def->use range); dead-slot zero stores emitted; total C-stack frame bytes.
	RefSlots: 52, RefWtVregs: 53, SlotsElided: 54, SlotZeroStores: 55, FrameBytes: 56,
	// MONO_WASM_JIT_LCSE reach. Read Hits/LoadsSeen for the true elimination rate — Adds/Hits is NOT it,
	// because Adds silently under-counts whenever the table is full. Evict tells you if the table is the
	// binding constraint.
	LcseLoadsSeen: 57, LcseAdds: 58, LcseHits: 59, LcseEvict: 60,
	// Compile-lock contention — the island driver's dominant failure mode (jit1: 66% of island attempts
	// ended BUSY, with blocked/budget-exhausted/depth-exceeded all zero, so the lock was the only thing
	// stopping methods from JITting). BusySelf vs BusyOther is the actionable split: Self = a re-entrant
	// compile (force_compile ran a cctor, the cctor re-entered the interpreter and tried to take a lock
	// its own caller holds) and can never clear by retrying on this thread; Other = a cross-worker race
	// that clears in ~one compile. BusyRequeued = losses handed to the promotion queue for an early retry
	// instead of a full hit-counter cycle; DrainSuppressed = drains skipped because the calling thread was
	// itself inside a compile.
	// Residual calls that entered the callee's own JITted e-slot directly, skipping interp_entry.
	EslotResidual: 61,
	// Call-form census, counted when a module is ASSEMBLED rather than when a call runs: every relocation
	// a body left, by the form the assembler chose. This is the direct mechanism reading for the import
	// conversion and for co-location — a change meant to remove call_indirect shows up here in one run,
	// where the fps A/B that would confirm it costs hours against a ~9% resolution floor.
	//   local     `call <funcidx>`  1 x86, and the only form V8 will inline through
	//   import    `call <import>`   ~5 x86
	//   indirect  `i32.const <slot>; call_indirect`  ~15 x86, never inlined
	CallLocal: 62, CallImport: 63, CallIndirect: 64,
	// Admissions deferred because an imported dependency was still mid-DFS. Not failures -- the method
	// runs interpreted and a later dispatch retries. Read against CallImport.
	// Members re-framed into a shared module at publish (mono_wasm_jit_colocate_deps_now), counted per group
	// formed. Read against Registered for the co-located fraction of the tier, and against CallLocal for
	// whether the grouping actually retargeted any call -- those two can move apart.
	ColocatedMembers: 65,
	// MONO_WASM_JIT_COLOCATE_TIGHT_DEPS: dependency entries dropped because a re-framed module's dep set
	// was recomputed from the assembler rather than inherited from the generation each member was compiled
	// as. Every one is a callee that became a module-local `call <funcidx>` and needs no admission, so this
	// is the size of the admission closure that used to be demanded for nothing. Read beside the
	// WASM_JIT_BATCH_ADMIT_FAIL / WASM_JIT_ADMIT_DEFER_GIVEUP console counts, which is what it was costing.
	TightDepsDropped: 78,
	// Members handed back to their standalone modules because the group they were bound into could not be
	// admitted (MONO_WASM_JIT_COLOCATE_ROLLBACK). Every one of these was previously a method permanently
	// denied the JIT tier and interpreted for the rest of the run.
	ColocateRollback: 79,
	// Groups NOT formed because dropping a callee would have left a dependency cycle spanning two modules,
	// which admission cannot order (MONO_WASM_JIT_COLOCATE_SCC). Expected small: 11 such cycles tier-wide.
	ColocateSccRefused: 80,
	// --- everything below was MISSING until the colocation/delegate work, i.e. this mirror stopped at 83
	// while the C enum ran to 111. All of it read as a permanent zero from here, which is exactly the
	// drift the comment below warns about, arriving in the file that carries the warning.
	// R166. Admission failures split by whether this worker will EVER retry: FailPerm = state 3 (bytes
	// failed to compile/link here), FailRetry = state 0 (an ordering miss). VfbNotlive is the fourth arm
	// of the VfbThresh split -- target IS compiled but is not dispatchable on THIS worker -- and its
	// absence is what hid R166 for a session. CHECK VfbCold+VfbParked+VfbRetry+VfbNotlive == VfbThresh
	// before quoting any share of the fallback pool.
	AdmitFailPerm: 81, AdmitFailRetry: 82, VfbNotlive: 83,
	// mono_wasm_jit_admit_live's refusal split; these five must account for the whole of VfbNotlive.
	AlAdmit0: 84, AlState: 85, AlGen: 86, AlElive: 87, AlFlive: 88,
	// Registrations that reused an f-slot still owned by an EARLIER descriptor for the SAME method.
	// A different method hitting that slot is refused loudly (WASM_JIT_FSLOT_COLLISION). Re-emission
	// taking back its own pinned pair was the original producer; rebatch/repartition reaches it now.
	FslotReregister: 89,
	// WHY a co-location group was not formed, one counter per exit of mono_wasm_jit_colocate_deps_now.
	// The identity to assert before quoting a share:
	//   ColocateTry == ColocateFormed + ColocateSelfBatched + ColocateSelfNoDepset + ColocateSelfRefused
	//                  + ColocateSingleton + ColocateSccRefused + ColocateRebatchFail
	// The ColocateDep* arms are per-CALLEE volumes and sit OUTSIDE that sum. Read ColocateDepBatched
	// first: it is the append-only partition refusing a callee another caller already claimed.
	ColocateTry: 90, ColocateFormed: 91,
	ColocateSelfBatched: 92, ColocateSelfNoDepset: 93, ColocateSelfRefused: 94,
	ColocateDepUnreg: 95, ColocateDepNobody: 96, ColocateDepBatched: 97, ColocateDepRefused: 98,
	ColocateDepByteCap: 99, ColocateMemberCap: 100, ColocateSingleton: 101, ColocateRebatchFail: 102,
	// CO-LOCATION REACH AS EXECUTED, from the IC miss/publish path. CallLocal counts relocations the
	// assembler turned into a module-local call funcidx -- the call-FORM half. R183's differential put the
	// GROUPING half at -7.0% of a -12.8% total (55% of the win) and R182 saw CallLocal at 4.0% of calls
	// even at 73% reach, so reading reach off CallLocal is what made four Minecraft arms call co-location
	// inert. A site gets the grouping half exactly when its runtime target is a sibling, because V8's
	// CallIndirectIC records a precise target only while implicitArg == the current instance.
	// VicTgtNotours is the AOT wall and wants over_aot, not a planner.
	VicTgtSibling: 103, VicTgtForeign: 104, VicTgtNotours: 105,
	// MONO_WASM_JIT_COLOCATE_MERGE. ColocateMerged = existing groups absorbed into a new request;
	// ColocateMergeSplit = refused because a group was only partially present (a split, never allowed).
	// Read Merged against ColocateDepBatched -- the two split what used to be all batched.
	ColocateMerged: 106, ColocateMergeSplit: 107,
	// Merges undone. A merge rollback restores each absorbed member to its PREVIOUS group rather than
	// clearing it; implemented and untested while this reads 0.
	ColocateMergeRollback: 108,
	// Why a merge closure was refused: sibling preconditions (fixable in the rules) vs caps (a knob).
	ColocateMergePrecond: 109, ColocateMergeCap: 110,
	// Late-f-slot healing sites EMITTED: each pays a helper call, a branch and a dynamic call_indirect on
	// every dispatch (~19.5M/run) to re-discover an f-slot the callee usually acquires shortly after.
	// HEAL_WAIT's HealWoken pair went with re-emission; this sizes the pool a relocatable f-slot hole
	// would address instead.
	HealSites: 111,
	// MUST stay 0: a member assembled with a NULL name loses its perf symbol, which silently degrades
	// that method to a bare 'wasmjit' and blinds every name-resolving instrument.
	AsmNoname: 112,
	// R205: executed IC hits tagged by their site's devirt outcome. FastVicPred = alternate receiver
	// at a site that DID devirt; coverage work cannot remove it. These six sum to FastVic.
	FastVicPred: 113, FastVicNoRec: 114, FastVicCold: 115,
	FastVicPoly: 116, FastVicNoFslot: 117, FastVicOther: 118,
	// R206 second guarded arm; Arm2Thin = break-even refusing a site. FastDevirt2 needs profile_fast.
	Arm2Emitted: 119, Arm2Thin: 120, Arm2NoAlt: 121,
	Arm2NoFslot: 122, Arm2Sig: 123, Arm2Self: 124, FastDevirt2: 125,
	// poly sites given a FIRST arm; double-counted in poly AND emitted.
	PolyArm1: 126,
	// R207: why wj_arm_abi_ok refused. ArmAbiShape = overrides lowering differently.
	ArmAbiInvalid: 127, ArmAbiByaddr: 128, ArmAbiShape: 129,
	// R207: split out of the old ARM2_SIG catch-all.
	ArmUnjittable: 130,
	// R215 delegate devirt; read FastDelegateDevirt against FastDelegate.
	DelegateDevirtArm: 131, DelegateDevirtThin: 132,
	DelegateDevirtRefused: 133, FastDelegateDevirt: 134,
	// R215b: no usable delegate record; split out of the thin catch-all.
	DelegateDevirtNorec: 135,
	// 2026-09-05: DelegateDevirtRefused merged an ORDERING artifact (target not compiled yet -- what a
	// blocker fixes) with a PERMANENT one (lowered signature the shared call sequence cannot express).
	// 4,360 merged, and the two lead to opposite decisions. Refused still carries their sum.
	DelegateDevirtNoFslot: 136, DelegateDevirtSig: 137,
	// 2026-09-06: WHY a delegate dispatch fell off the direct e-thunk into the full interp marshal.
	// call_delegate is 97% of call_interp's traffic and the interp-boundary complex is ~5.7-6.1% of the
	// client render thread, but its fast path is `eslot > 0 && scalar` and which conjunct fails was never
	// measured. noeslot is an admission/ordering problem, nonscalar an ABI one -- opposite fixes.
	DelegateSlowNorecipe: 138, DelegateSlowNoeslot: 139, DelegateSlowNonscalar: 140,
	// GUARDED DEVIRTUALIZED INLINING (method-to-ir.c). There is no inliner in this pipeline for virtual
	// calls at all -- V8 cannot inline across modules and mono's own gate refuses every callvirt -- so
	// GiSite is the whole population that pass would reach.
	//
	// GiCandidate is measured with the knob OFF (pure profile + pointer checks only), so a plain STATS
	// run sizes the addressable population for free. Read GiRefusedClauses next:
	// mono_method_check_inlining rejects ANY method with a try/catch and Java is EH-dense, so it may be
	// the whole story. GiRefusedProf is `no_rec` arriving here -- 99.3% of profile observations land
	// after the method is JITted. ASSERT GiAdmitted == GiEmitted + GiRefusedLate.
	GiSite: 141, GiCandidate: 142, GiAdmitted: 143, GiEmitted: 144,
	GiRefusedProf: 145, GiRefusedClauses: 146, GiRefusedSize: 147,
	GiRefusedSig: 148, GiRefusedSelf: 149, GiRefusedLate: 150,
	// Everything check_inlining refuses that is NOT clauses and NOT size (NOINLINING, SYNCHRONIZED,
	// gsharedvt, depth, cctor-needs-context). Exists so the other two cannot absorb an unnamed cause.
	GiRefusedOther: 151,
	// Split of DelegateSlowNonscalar into causes needing OPPOSITE fixes. Byref params are already
	// layout-compatible with the e-thunk; vtarg/vtret need real ABI work. These three sum to nonscalar.
	DelegateSlowVtret: 152, DelegateSlowVtarg: 153, DelegateSlowByref: 154,
	/* R230: interp->JIT entries refused because the snapshotted e-slot was not live on THIS worker.
	 * NON-ZERO IS HEALTHY -- it is the guard catching R209's torn read at the entry gate, which would
	 * otherwise call_indirect the jiterpreter's prefilled placeholder through the wrong functype and
	 * trap with `function signature mismatch` in wasm_jit_ethunk_cb, killing the worker. R209 fixed one
	 * of the six callers; an audit found four of six unguarded, three of them also re-reading the slot.
	 * Zero forever would mean the guard is dead code, not that the race is impossible. */
	EntrySlotStale: 155,
} as const;
// Mirrors WJC_MAX. The C side carries `g_static_assert (WJC_MAX == 184)` directly above
// mono_wasm_jit_dump_stats so appending a counter breaks the runtime build until BOTH printers are
// updated. That tripwire only exists because drift is undetectable from here: mono_wasm_jit_get_counter
// returns 0 for an out-of-range index, so a mirror running past the C enum reads as "that counter never
// moved", never as an error.
//
// Two ways this file has already drifted, both of which read as plausible zeros rather than as errors:
//  - it once mirrored six indices 64-69 for a "cohort batching" redesign that does not exist in this
//    runtime (module batching here is the WjBatch / MONO_WASM_JIT_BATCH_MODULE path in mini-wasm.c, which
//    has no WJC_* counters at all), and reported the resulting zeros as "batching is off";
//  - index 20 was RefHwm, the old ref shadow stack's high-water depth. That stack is gone (pins are
//    per-frame C-stack slots now: RefSlots / FrameBytes), it had no writer, and it was DELETED from the C
//    enum rather than left as a permanently-zero hole — so everything below it shifted down by one.
// Hence: every counter below has a live writer, and index order is authoritative, not name order.
// Re-verify against the runtime with:
//   grep -rn 'wj_count *(\|wj_add *(\|wj_emit_fast_count *(\|mono_wasm_jit_count *(\|mono_wasm_jit_add *(' src/mono
// WAS 69 while the enum ran to 111 and the table above named indices up to 83 -- so the full dump
// truncated even the counters this file already mirrored.
//
// DERIVED, not written down, because a hand-maintained copy of this number drifts SILENTLY and did:
// it read 176 while the table above named indices up to 183 and the C side asserted WJC_MAX == 184, so
// the last eight counters printed nothing -- and they were precisely the ones added to close the
// accounting (DelegateDevirtNoFslot/Sig and the re-emission drain's own distinct-method denominator,
// which its conclusion rested on). Deriving it removes the class of bug: the
// dump can now under-run the C enum (harmless, and the C static_assert catches it) but can never again
// hide a counter this file already names.
const WJ_MAX = Math.max(...Object.values(WJ)) + 1;
/** Index -> mirror name, for the full-counter dump. Built from WJ so it can never drift from it. */
const WJ_NAMES: readonly string[] = (() => {
	const names = new Array<string>(WJ_MAX).fill("(unmirrored)");
	for (const [name, idx] of Object.entries(WJ)) names[idx] = name;
	return names;
})();
// registered = methods JITted (cumulative); invoke = interp->wasm-JIT entries; residual = outbound calls
// from JITted wasm that fell back to interp; fastvcall = virtual calls dispatched DIRECTLY to a JITted
// override's f-slot (gap #3 fast path, no interp).
const BENCH_WASMJIT = [WJ.Registered, WJ.Invoke, WJ.Residual, WJ.Fastvcall] as const;
// granular virtual-dispatch breakdown (mono_wasm_jit_vcall_resolve_fslot): ic hit/miss, fast-path returns
// (override already JITted vs compiled this call), fallback reasons (below threshold/retriable vs perm
// un-JITtable), and sync_thread instantiation work. Isolates the virtual-dispatch bottleneck under RESIDUAL=0.
const BENCH_VCALL = [WJ.VicHit, WJ.VicMiss, WJ.VfastHad, WJ.VfastNew, WJ.VfbThresh, WJ.VfbPerm] as const;
// breakdown of the perm-unjittable vcall residual (vfbperm) by WHY the override can't JIT — tells us,
// runtime-weighted, whether to invest in EH codegen (Phase 4) or a specific opcode (e.g. ldaddr).
const BENCH_VPERM = [WJ.VpermAot, WJ.VpermEh, WJ.VpermLdaddr, WJ.VpermLcmp, WJ.VpermSig, WJ.VpermByref, WJ.VpermGshared, WJ.VpermRgctx, WJ.VpermSync, WJ.VpermEhOther, WJ.VpermOtherop, WJ.VpermOther] as const;
// split of the residual by inline-AOT-fastpath routing: aotrouted = ran natively via inline do_jit_call,
// interprouted = fell back to interp_entry/interpretation. shows how much boundary cost the fastpath captures.
const BENCH_AOTROUTE = [WJ.AotRouted, WJ.InterpRouted, WJ.VcallAotFast] as const;
// below-threshold vcall fallback split by target slot state: [cold, parked, retry]. parked>0 => hot methods
// whose islands won't close (interpreted every call) — the interp-residual driver, fixable by island closure.
const BENCH_VFB_SPLIT = [WJ.VfbCold, WJ.VfbParked, WJ.VfbRetry] as const;
// fast-path VOLUME (only nonzero under MONO_WASM_JIT_PROFILE_FAST=1): [inline-aot, f-slot-ic-hit, aot-ic-hit].
// un-confounds cost attribution — these dispatches are otherwise uncounted (pure emitted wasm, no helper).
const BENCH_FAST = [WJ.FastInlineAot, WJ.FastVic, WJ.FastAotic] as const;
// transition elision: [healed residual sites, direct delegate dispatches, delegate-IC hits]. DelegateIcHit
// is the subset of FastDelegate that also consumed the recipe inline, bypassing vcall_resolve_fslot.
const BENCH_TRANSITION = [WJ.ResidualHealed, WJ.FastDelegate, WJ.DelegateIcHit] as const;
// compile outcomes: [bailed, invalid]. bailed counts per-ATTEMPT emitter bails (the island driver re-emits
// blocked methods, so it exceeds the distinct-method total in [wasm-jit bails]); invalid = registration
// refused. registered/(registered+bailed) over the window is the emitter's hit rate.
const BENCH_COMPILE_OUT = [WJ.Bailed, WJ.Invalid] as const;
// vtype ABI coverage: [by-addr vtype args, hidden vret] — proves the vtype ABI paths are exercised rather
// than silently bailed. RefbasesExtra is the GC-classification counterexample count (see below).
const BENCH_VTABI = [WJ.VtByaddrMethods, WJ.VretMethods, WJ.RefbasesExtra] as const;
// GC pin pressure, summed over all compiles: [ref slots, write-through vregs, slots elided, dead-slot zero
// stores, frame bytes]. elided/(elided+slots) is the slot-elision rate; frame_bytes/method is C-stack cost.
const BENCH_GCPIN = [WJ.RefSlots, WJ.RefWtVregs, WJ.SlotsElided, WJ.SlotZeroStores, WJ.FrameBytes] as const;
// LCSE reach (MONO_WASM_JIT_LCSE=1 only): [loads seen, adds, hits, evictions]. hits/loads_seen is the true
// elimination rate; evict>0 means the load table size is the binding constraint, not the kill policy.
const BENCH_LCSE = [WJ.LcseLoadsSeen, WJ.LcseAdds, WJ.LcseHits, WJ.LcseEvict] as const;
// Call forms chosen at assembly: [local, import, indirect]. Counted per module BUILT, so a re-assembly
// counts its members again — which is the point: comparing the shares across generations is how a rebatch
// is shown to have actually retargeted anything.
const BENCH_CALLFORM = [WJ.CallLocal, WJ.CallImport, WJ.CallIndirect, WJ.ColocatedMembers] as const;
// compile-lock contention: [busy-self, busy-other, requeued, drain-suppressed]. busy counts every lost
// try-acquire (islands plus the module batcher), so read it against the island attempt/completed pair
// rather than as an exact island loss rate. self>0 means re-entrant compiles (cctor work re-entering the
// interpreter) — those can only be fixed by deferring to the promotion queue, never by backing off.
/* The compile-lock counters (BusySelf/BusyOther/BusyRequeued/BusyDropped/DrainSuppressed) were mirrored at
 * indices 63-67 but DO NOT EXIST in this runtime's WJC_* enum, which ends at 64. mono_wasm_jit_get_counter
 * returns 0 out of range, so the "compile lock: 0 busy" line was never evidence of no contention -- and once
 * WJC_ESLOT_RESIDUAL was appended at 63 the same line started printing that counter's value as "busy",
 * i.e. a large meaningless number. Removed rather than left reading whatever lands at those indices next. */
const BENCH_LOCK: readonly number[] = [];
const wjCounter = (idx: number): number => {
	const f = (globalThis as any).wasm?.Module?._mono_wasm_jit_get_counter;
	return typeof f === "function" ? f(idx) : NaN;
};

/**
 * Is the wasm method-JIT actually running? Every WJC_* counter is gated behind MONO_WASM_JIT_STATS,
 * so a clean timing run — the only kind worth timing — reads zero for all of them and cannot tell
 * "the JIT is off" from "the JIT is slow". mono_wasm_jit_liveness() reads process state that exists
 * regardless of stats: 0 = auto, 1 = threshold, 2 = registered method count, 3 = function-table
 * exhaustion events.
 *
 * Print this before every timed run. MONO_WASM_JIT_AUTO=0 disables the entire tier silently, and
 * that already cost one real measurement.
 */
export function jitLiveness(): {
	auto: number; threshold: number; registered: number; tableExhausted: number;
	slotsRemaining: number; slotsConsumed: number; slotsLeaked: number;
	instantiations: number; instantiateMs: number; instantiationsViaAdmit: number;
	instPerModule: number;
} | null {
	const f = (globalThis as any).wasm?.Module?._mono_wasm_jit_liveness;
	if (typeof f !== "function") return null;
	// -1 is the "unknown field" sentinel from a runtime predating a counter; normalise it away.
	const exhausted = f(3), remaining = f(4);
	const registered = f(2);
	const baseline = (globalThis as any).__wjSlotBaseline;
	// Every JITted method owns exactly two table entries (an e and an f), so consumed should track
	// 2*registered. Any excess was allocated and never published -- precisely the leak that reservation
	// parking (wj_park_reservation / mono_wasm_jit_reserve_self) exists to prevent. The runtime exposes
	// only "entries remaining", never the table's size, so this needs the startup baseline below; -1
	// means it was not captured and the number is unknown rather than zero.
	const consumed = typeof baseline === "number" && remaining >= 0 ? baseline - remaining : -1;
	// PER-WORKER INSTANTIATION, and it is stats-INDEPENDENT like everything else here -- which it only
	// became once the C-side census gate was split (mini-wasm.c: the ENTRY half still needs
	// MONO_WASM_JIT_ENTRYCENSUS, the INSTANTIATION half no longer does). Before that these read 0 on
	// every timed run, so the cost of the function table being per-worker had never been measured on a
	// shipped configuration; `[wasm-jit time] instantiate=` looked like the answer and is not -- it is
	// charged at ONE site, the compiling thread's validating instantiation.
	//
	// instPerModule is the headline: instantiations divided by REGISTERED methods. It is not a duplication
	// factor on its own, because co-location puts up to 16 methods in one module (so one instantiation
	// serves many methods, pushing it below 1) while every worker that admits a module instantiates it
	// again (pushing it up). Read it as a trend across a change, not as an absolute.
	// -1 from a runtime predating a field; normalise so a caller can sum without checking.
	const z = (v: number) => (v < 0 ? 0 : v);
	const instantiations = z(f(8)), instantiateMs = z(f(13));
	return {
		auto: f(0), threshold: f(1), registered,
		tableExhausted: exhausted < 0 ? 0 : exhausted,
		slotsRemaining: remaining,
		slotsConsumed: consumed,
		slotsLeaked: consumed >= 0 ? consumed - 2 * registered : -1,
		instantiations,
		instantiateMs,
		instantiationsViaAdmit: z(f(10)),
		instPerModule: registered > 0 ? Number((instantiations / registered).toFixed(3)) : -1,
	};
}

/**
 * Sample the JIT_CALL table's free count as the baseline for slot accounting. Must run before any
 * method is JITted, since the runtime reports only what is left, never the table's size. Safe to call
 * repeatedly -- only the first (highest) reading is kept.
 */
export function captureJitSlotBaseline(): number {
	const f = (globalThis as any).wasm?.Module?._mono_wasm_jit_liveness;
	if (typeof f !== "function") return -1;
	const remaining = f(4);
	const prev = (globalThis as any).__wjSlotBaseline;
	if (remaining > 0 && (typeof prev !== "number" || remaining > prev))
		(globalThis as any).__wjSlotBaseline = remaining;
	return remaining;
}
(globalThis as any).captureJitSlotBaseline = captureJitSlotBaseline;
(globalThis as any).jitLiveness = jitLiveness;

/** One line stating whether the JIT tier is live, safe to call in a clean (stats-off) run. */
export function jitLivenessLine(): string {
	const l = jitLiveness();
	if (!l) return "[bench] wasm-jit liveness: unavailable (runtime predates mono_wasm_jit_liveness)";
	if (l.auto <= 0) {
		return `[bench] wasm-jit is DISABLED (MONO_WASM_JIT_AUTO=${l.auto}) — running interp+jiterpreter only.`
			+ ` Any number from this run says nothing about the wasm JIT.`;
	}
	// Exhaustion is the one failure that looks like a slowdown rather than an error: the function table
	// allocator has no free, so once it is full every later method silently declines to JIT.
	const exhausted = l.tableExhausted > 0
		? ` — WARNING: function table EXHAUSTED (${l.tableExhausted} events); methods past that point ran`
		  + ` interpreted. Raise --jiterpreter-table-size; this run understates the JIT.`
		: "";
	// Instantiation is appended rather than given its own line so a run that greps for this one string
	// still gets the whole liveness picture. `admit` is the per-worker, demand-driven path and is the
	// only one that ever instantiates on a worker other than the compiler's.
	const inst = ` | instantiated=${l.instantiations} modules (${l.instantiateMs}ms, ${l.instantiationsViaAdmit} via admit,`
		+ ` ${l.instPerModule}/registered)`;
	return `[bench] wasm-jit live: auto=${l.auto} threshold=${l.threshold} registered=${l.registered} methods${exhausted}${inst}`;
}
(globalThis as any).jitLivenessLine = jitLivenessLine;

/**
 * Measure a fixed window while you manually walk the test area. Snapshots heat at start and end, then
 * reports frames / fps / ms/frame and per-reason bailout deltas. Resolves after `durationMs` or when
 * stopBench() is called.
 */
export async function benchMeasure(durationMs = 60000, walk = false): Promise<void> {
	if (benchStop) { console.warn("[bench] already running"); return; }
	let stopped = false;
	benchStop = () => { stopped = true; };

	const f0 = benchFrameCount();
	const b0 = BENCH_BAILOUTS.map(([, r]) => benchBailout(r));
	const wj0 = BENCH_WASMJIT.map(wjCounter);
	const wjv0 = BENCH_VCALL.map(wjCounter);
	const wjp0 = BENCH_VPERM.map(wjCounter);
	const wja0 = BENCH_AOTROUTE.map(wjCounter);
	const wjfb0 = BENCH_VFB_SPLIT.map(wjCounter);
	const wjf0 = BENCH_FAST.map(wjCounter);
	const wjx0 = BENCH_TRANSITION.map(wjCounter);
	const wjo0 = BENCH_COMPILE_OUT.map(wjCounter);
	const wjab0 = BENCH_VTABI.map(wjCounter);
	const wjg0 = BENCH_GCPIN.map(wjCounter);
	const wjl0 = BENCH_LCSE.map(wjCounter);
	const wjc0 = BENCH_CALLFORM.map(wjCounter);
	const wjk0 = BENCH_LOCK.map(wjCounter);
	// compile-time accounting: [gen µs, instantiate µs, bytes, attempts]
	const wjt0 = [WJ.ElapsedGeneration, WJ.ElapsedInstantiation, WJ.BytesGenerated, WJ.CompileAttempts].map(wjCounter);
	// island outcomes: [attempt, completed, budgetExhausted, depthExceeded, blockedCold, promotedUp, promotedDown, parked, waiterWoken]
	const wji0 = [WJ.IslandAttempt, WJ.IslandCompleted, WJ.IslandBudgetExhausted, WJ.IslandDepthExceeded, WJ.IslandBlockedCold, WJ.PromotedUp, WJ.PromotedDown, WJ.Parked, WJ.WaiterWoken].map(wjCounter);
	// reset the per-window hot entry-edge counters so the END-of-window dump reflects just this window
	(globalThis as any).wasm?.Module?._mono_wasm_jit_snapshot?.();
	const t0 = performance.now();

	console.log(jitLivenessLine());
	console.log(`[bench] measure START — ${walk ? "auto-walking (deterministic)" : "walk the test area now"} for ${(durationMs / 1000).toFixed(0)}s. heat snapshot A:`);
	dumpJiterpHeat(60);

	// when walk=true, drive a deterministic path (sprint forward + alternating strafe every 4s) inside
	// the sampling loop so off/on runs traverse identically. all keys released in finally.
	const walkKeys: [string, string][] = [["KeyW", "w"], ["ControlLeft", "Control"], ["KeyD", "d"], ["KeyA", "a"]];
	const end = t0 + durationMs;
	try {
		if (walk) {
			benchKey("keydown", "ControlLeft", "Control"); // sprint (1.16 default)
			benchKey("keydown", "KeyW", "w");               // forward, held throughout
		}
		let curStrafe: "KeyD" | "KeyA" | null = null;
		while (!stopped && performance.now() < end) {
			if (walk) {
				// 4s phases: forward-only, +right, forward-only, +left, repeat
				const phase = Math.floor((performance.now() - t0) / 4000) % 4;
				const want: "KeyD" | "KeyA" | null = phase === 1 ? "KeyD" : phase === 3 ? "KeyA" : null;
				if (want !== curStrafe) {
					if (curStrafe) benchKey("keyup", curStrafe, curStrafe === "KeyD" ? "d" : "a");
					if (want) benchKey("keydown", want, want === "KeyD" ? "d" : "a");
					curStrafe = want;
				}
			}
			await benchSleep(200);
		}
	} finally {
		if (walk) for (const [code, key] of walkKeys) benchKey("keyup", code, key);
	}

	const t1 = performance.now();
	const f1 = benchFrameCount();
	const b1 = BENCH_BAILOUTS.map(([, r]) => benchBailout(r));
	const wj1 = BENCH_WASMJIT.map(wjCounter);
	const wjv1 = BENCH_VCALL.map(wjCounter);
	const wjp1 = BENCH_VPERM.map(wjCounter);
	const wja1 = BENCH_AOTROUTE.map(wjCounter);
	const wjfb1 = BENCH_VFB_SPLIT.map(wjCounter);
	const wjf1 = BENCH_FAST.map(wjCounter);
	const wjx1 = BENCH_TRANSITION.map(wjCounter);
	const wjo1 = BENCH_COMPILE_OUT.map(wjCounter);
	const wjab1 = BENCH_VTABI.map(wjCounter);
	const wjg1 = BENCH_GCPIN.map(wjCounter);
	const wjl1 = BENCH_LCSE.map(wjCounter);
	const wjc1 = BENCH_CALLFORM.map(wjCounter);
	const wjk1 = BENCH_LOCK.map(wjCounter);
	const wjt1 = [WJ.ElapsedGeneration, WJ.ElapsedInstantiation, WJ.BytesGenerated, WJ.CompileAttempts].map(wjCounter);
	const wji1 = [WJ.IslandAttempt, WJ.IslandCompleted, WJ.IslandBudgetExhausted, WJ.IslandDepthExceeded, WJ.IslandBlockedCold, WJ.PromotedUp, WJ.PromotedDown, WJ.Parked, WJ.WaiterWoken].map(wjCounter);
	benchStop = null;

	console.log(`[bench] measure END. heat snapshot B:`);
	dumpJiterpHeat(60);
	// island diagnostics: top blocking callees (what to make jittable to grow islands) + the per-window
	// hot interp->JIT entry edges (the boundary the transition storm crosses).
	(globalThis as any).wasm?.Module?._mono_wasm_jit_dump_blockers?.(40);
	(globalThis as any).wasm?.Module?._mono_wasm_jit_dump_hot_edges?.(40);

	const wall = t1 - t0;
	const frames = f1 - f0;
	const out: string[] = [];
	out.push(`=== bench summary — ${(wall / 1000).toFixed(1)}s window ===`);
	if (Number.isFinite(frames) && frames > 0)
		out.push(`frames ${frames}   fps ${(frames / (wall / 1000)).toFixed(1)}   ms/frame ${(wall / frames).toFixed(2)}`);
	else
		out.push(`frames: unavailable — rebuild emscripten-glfw with the frame-counter patch (Module._emscripten_glfw3_get_frame_count missing)`);

	if (Number.isFinite(b0[0])) {
		out.push(`bailouts over window (Δtotal / per-frame):`);
		for (let i = 0; i < BENCH_BAILOUTS.length; i++) {
			const d = b1[i] - b0[i];
			const perFrame = frames > 0 ? (d / frames).toFixed(1) : "?";
			out.push(`  ${BENCH_BAILOUTS[i][0].padEnd(16)} ${Math.round(d).toLocaleString().padStart(16)}   ${perFrame}/frame`);
		}
	} else {
		out.push(`bailout deltas: unavailable — run with --jiterpreter-count-bailouts`);
	}

	if (Number.isFinite(wj0[0])) {
		const [reg0, inv0, res0, fvc0] = wj0, [reg1, inv1, res1, fvc1] = wj1;
		const perFrame = (d: number) => frames > 0 ? (d / frames).toFixed(1) : "?";
		out.push(`wasm-jit over window (Δ): registered +${reg1 - reg0} (total ${reg1})  invoked +${(inv1 - inv0).toLocaleString()} (${perFrame(inv1 - inv0)}/frame)  residual +${(res1 - res0).toLocaleString()} (${perFrame(res1 - res0)}/frame)  fastvcall +${(fvc1 - fvc0).toLocaleString()} (${perFrame(fvc1 - fvc0)}/frame)`);
		// compile time (Δ): generation/instantiation are microseconds in the counter; show ms. attempts = emits.
		const dGenMs = (wjt1[0] - wjt0[0]) / 1000, dInstMs = (wjt1[1] - wjt0[1]) / 1000, dBytes = wjt1[2] - wjt0[2], dAtt = wjt1[3] - wjt0[3];
		const dReg = reg1 - reg0;
		out.push(`  compile (Δ): ${dGenMs.toFixed(1)}ms gen + ${dInstMs.toFixed(1)}ms instantiate over ${dAtt} attempts → +${dReg} registered, +${(dBytes / 1024).toFixed(1)}kb (${dReg > 0 ? (dBytes / dReg / 1024).toFixed(2) : "?"}kb/method, ${dReg > 0 ? ((dGenMs + dInstMs) / dReg).toFixed(2) : "?"}ms/method)`);
		// Hotness-trigger outcomes (Δ): "triggered" is a method crossing the threshold, "JITted" one whose
		// island actually closed and published; the gap is bails plus methods still parked/queued when the
		// window ended. The island walk is a bounded DFS, so budget-exhausted / depth-exceeded are the two
		// ways it gives up early (raise --wasm-jit island budget/depth if either dominates); blocked-cold
		// is a callee that just has not heated yet. (blocked-perm was removed with WJC_ISLAND_BLOCKED_PERM,
		// whose only bump site was dead code behind `if (1)` -- it read 0 for the life of the counter.)
		const di = wji1.map((v, i) => v - wji0[i]);
		const [iAtt, iDone, iBudget, iDepth, iCold, iUp, iDown, iParked, iWoken] = di;
		out.push(`  hotness (Δ): ${iAtt} triggered → ${iDone} JITted (${iAtt > 0 ? (100 * iDone / iAtt).toFixed(0) : "?"}%); blocked cold ${iCold}; budget-exhausted ${iBudget}, depth-exceeded ${iDepth}`);
		out.push(`    promoted up ${iUp}, down ${iDown}; parked ${iParked}, waiters woken ${iWoken} (${iParked > 0 ? (iWoken / iParked).toFixed(1) : "?"} woken/park)`);
		if (Number.isFinite(wjk0[0])) {
			// Compile-lock contention. `busy` spans ALL five lock users (island trigger, promotion drain,
			// SCC, batcher, auto-planner) plus nested compile_publish inside an island DFS — only the first
			// two can requeue, so requeued/busy is NOT a recovery rate and dividing by island attempts is
			// meaningless (it read 396% on jit2). requeued vs dropped is the pair that means something:
			// dropped>0 is the only direct evidence the promotion queue is saturating.
			const [bSelf, bOther, bReq, bDrop, bSup] = wjk1.map((v, i) => v - wjk0[i]);
			const busy = bSelf + bOther;
			out.push(`    compile lock: ${busy} busy (self ${bSelf}, other ${bOther})`
				+ `; ${bReq} requeued, ${bDrop} dropped (queue full), ${bSup} drains suppressed`);
		}
		// compile outcomes (Δ): bails are per-ATTEMPT (the island driver re-emits blocked methods every
		// iteration), so this exceeds the distinct-method total in the runtime's [wasm-jit bails] dump.
		// NB `inv0`/`inv1` above are Invoke; these are Invalid — different counters, hence the names.
		const [bailed0, invalid0] = wjo0, [bailed1, invalid1] = wjo1;
		const dBail = bailed1 - bailed0, dInvalid = invalid1 - invalid0, dTried = dReg + dBail;
		out.push(`  compile outcomes (Δ): ${dReg} registered / ${dBail} bailed (attempts) / ${dInvalid} invalid`
			+ `  → ${dTried > 0 ? (100 * dReg / dTried).toFixed(0) : "?"}% emit hit rate   [totals ${reg1} / ${bailed1} / ${invalid1}]`);
		if (Number.isFinite(wja0[0])) {
			// residual routing: how much of the residual ran natively via the inline do_jit_call AOT fastpath
			// (aot-native) vs fell back to interp_entry/interpretation (interpreted). % of routed residual.
			const da = wja1[0] - wja0[0], di = wja1[1] - wja0[1], tr = da + di;
			const dvaf = wja1[2] - wja0[2];   // vcalls that took the fast AOT dispatch (MONO_WASM_JIT_VCALL_AOT) — bypass the residual entirely
			const rpct = (n: number) => tr > 0 ? `${(100 * n / tr).toFixed(1)}%` : "?";
			out.push(`  residual routing (Δ, /frame): aot-native ${perFrame(da)} (${rpct(da)})  interpreted ${perFrame(di)} (${rpct(di)})  vcall-aot-fast ${perFrame(dvaf)} (${(dvaf / 1000).toFixed(0)}k total)`);
		}
		if (Number.isFinite(wjv0[0])) {
			// vcall breakdown: [vichit, vicmiss, vfasthad, vfastnew, vfbthresh, vfbperm, vsyncwork]
			const dv = wjv1.map((v, i) => v - wjv0[i]);
			const [vih, vim, vfh, vfn, vbt, vbp, vsw] = dv;
			const tot = vih + vim; // total vcalls = ic hits + ic misses
			const pct = (n: number) => tot > 0 ? `${(100 * n / tot).toFixed(1)}%` : "?";
			out.push(`  vcall breakdown (Δ, /frame): total ${tot.toLocaleString()} (${perFrame(tot)})  ic_hit ${perFrame(vih)} (${pct(vih)})  ic_miss ${perFrame(vim)} (${pct(vim)})`);
			out.push(`    fast: already-JITted ${perFrame(vfh)} (${pct(vfh)})  compiled-now ${perFrame(vfn)} (${pct(vfn)})   fallback: below-threshold ${perFrame(vbt)} (${pct(vbt)})  perm-unjittable ${perFrame(vbp)} (${pct(vbp)})   sync-instantiated ${perFrame(vsw)}`);
			// below-threshold fallback split by target slot state: cold (interp acceptable) vs PARKED (crossed
			// thresh but island won't close = interpreted every call, the real interp-residual driver) vs retry.
			const dfb = wjfb1.map((v, i) => v - wjfb0[i]);
			const [fbc, fbp, fbr] = dfb;
			const bpct = (n: number) => vbt > 0 ? `${(100 * n / vbt).toFixed(1)}%` : "?";
			out.push(`      below-threshold split (/frame, % of below-thresh): cold ${perFrame(fbc)} (${bpct(fbc)})  PARKED ${perFrame(fbp)} (${bpct(fbp)})  retry ${perFrame(fbr)} (${bpct(fbr)})`);
			if (Number.isFinite(wjp0[0])) {
				// perm-unjittable residual by reason: [aot, eh, ldaddr, lcompare, sig, byref, gshared, rgctx, sync, eh-other, other-opcode, other]
				const dp = wjp1.map((v, i) => v - wjp0[i]);
				const [paot, peh, pld, plc, psig, pbyref, pgsh, prgctx, psync, pehx, pop, pot] = dp;
				const ppct = (n: number) => vbp > 0 ? `${(100 * n / vbp).toFixed(1)}%` : "?";
				out.push(`    perm-residual by reason (/frame, % of perm): aot-backed ${perFrame(paot)} (${ppct(paot)})  EH ${perFrame(peh)} (${ppct(peh)})  ldaddr ${perFrame(pld)} (${ppct(pld)})  lcompare ${perFrame(plc)} (${ppct(plc)})  sig ${perFrame(psig)} (${ppct(psig)})  byref ${perFrame(pbyref)} (${ppct(pbyref)})  gshared ${perFrame(pgsh)} (${ppct(pgsh)})  rgctx ${perFrame(prgctx)} (${ppct(prgctx)})  sync ${perFrame(psync)} (${ppct(psync)})  eh-other ${perFrame(pehx)} (${ppct(pehx)})  other-opcode ${perFrame(pop)} (${ppct(pop)})  other ${perFrame(pot)} (${ppct(pot)})`);
			}
		}
		// fast-path VOLUME (nonzero only under MONO_WASM_JIT_PROFILE_FAST=1): these dispatches call no
		// counting helper, so without this they are invisible and frame-cost attribution vs residuals is
		// confounded. inline-aot = INLINE_AOT direct AOT call; f-slot-ic-hit = JIT->JIT; aot-ic-hit = JIT->AOT.
		const df = wjf1.map((v, i) => v - wjf0[i]);
		if (df.some((v) => v !== 0))
			out.push(`  fast-path volume (Δ, /frame): inline-aot ${perFrame(df[0])}  f-slot-ic-hit ${perFrame(df[1])}  aot-ic-hit ${perFrame(df[2])}`);
		else
			out.push(`  fast-path volume: not profiled (set MONO_WASM_JIT_PROFILE_FAST=1 to count inline-aot / f-slot-ic / aot-ic dispatches)`);
		const dx = wjx1.map((v, i) => v - wjx0[i]);
		out.push(`  transition elision (Δ, /frame): healed-residual ${perFrame(dx[0])}  direct-delegate ${perFrame(dx[1])}  delegate-ic-hit ${perFrame(dx[2])}${dx[1] === 0 && dx[2] === 0 ? " (both delegate counters require PROFILE_FAST=1)" : ""}`);

		// --- compile-time / codegen-quality counters ---------------------------------------------------
		// These are bumped once per COMPILE, not per call, so per-frame is meaningless; report the window Δ
		// against the methods compiled in that window, plus the since-boot total. A steady-state window
		// compiles almost nothing, so the totals are the interesting half here.
		{
			// vtype ABI coverage: direct evidence the by-addr-vtype-arg and hidden-vret paths are being
			// exercised rather than silently bailed. refbases-extra must stay 0 — every nonzero hit is a named
			// counterexample to "REFBASES is subsumed by the structural GC seeds" (logged under REFVERIFY).
			const [vtb1, vret1, rbx1] = wjab1;
			const dab = wjab1.map((v, i) => v - wjab0[i]);
			out.push(`  vtype ABI (totals): ${vtb1} methods with by-addr vtype args, ${vret1} with a hidden vret`
				+ `  [Δ +${dab[0]} / +${dab[1]}]   refbases-extra ${rbx1}${rbx1 > 0 ? ` *** ${dab[2]} this window — structural seeds MISSED a ref vreg; see the REFVERIFY log` : " (0 = REFBASES subsumed by structural seeds)"}`);
			// GC pin pressure. slots-elided/(slots-elided + ref-slots) is the elision rate: isref vregs that
			// needed no frame slot because nothing in their def->use range is a GC point. frame-bytes/method is
			// the C-stack cost each JITted method carries for pinning.
			const [rs1, wt1, se1, sz1, fb1] = wjg1;
			const dg = wjg1.map((v, i) => v - wjg0[i]);
			const isref1 = rs1 + se1;
			out.push(`  gc pin (totals): ${rs1} ref slots, ${wt1} write-through vregs, ${se1} elided (${isref1 > 0 ? (100 * se1 / isref1).toFixed(1) : "?"}% of isref vregs), ${sz1} dead-slot zero stores`
				+ `  ${(fb1 / 1024).toFixed(1)}kb frame total (${reg1 > 0 ? (fb1 / reg1).toFixed(0) : "?"}b/method)   [Δ +${dg[0]} slots, +${dg[2]} elided]`);
			// LCSE. hits/loads_seen is the elimination RATE; adds/hits is NOT, because adds under-counts once
			// the table is full. evict>0 means the table size is the binding constraint, not the kill policy.
			const [ls1, la1, lh1, le1] = wjl1;
			const dl = wjl1.map((v, i) => v - wjl0[i]);
			if (ls1 > 0)
				out.push(`  lcse (totals): ${lh1.toLocaleString()} hits / ${ls1.toLocaleString()} loads seen = ${(100 * lh1 / ls1).toFixed(2)}% eliminated`
					+ `  (${la1.toLocaleString()} adds, ${le1.toLocaleString()} evictions${le1 > 0 ? " — table is the binding constraint, raise WJ_LCSE_LOADS" : ""})   [Δ +${dl[2]} hits / +${dl[0]} seen]`);
			else
				out.push(`  lcse: off (set MONO_WASM_JIT_LCSE=1; it defaults off — measured reach was 0.69% of loads on jbox2d)`);
			// Call forms. The indirect share is the thing every call-boundary change is trying to move.
			const [cl1, ci1, cx1, cd1] = wjc1;
			const dc = wjc1.map((v, i) => v - wjc0[i]);
			const ctot = cl1 + ci1 + cx1;
			if (ctot > 0)
				out.push(`  call forms (totals): ${cl1.toLocaleString()} local / ${ci1.toLocaleString()} import / ${cx1.toLocaleString()} indirect`
					+ `  = ${(100 * cl1 / ctot).toFixed(1)}% / ${(100 * ci1 / ctot).toFixed(1)}% / ${(100 * cx1 / ctot).toFixed(1)}%`
					+ `   [Δ +${dc[0]} / +${dc[1]} / +${dc[2]}]   admit deferred ${cd1.toLocaleString()} [Δ +${dc[3]}]`);
		}
	} else {
		out.push(`wasm-jit deltas: unavailable — set MONO_WASM_JIT_STATS=1`);
	}

	console.log(out.join("\n"));
}
(globalThis as any).benchMeasure = benchMeasure;

/**
 * Dump the hottest jiterpreter trace entry points
 * A hot method showing jit<eps (few/no compiled entry points) is one the jiterpreter couldn't
 * trace — i.e. an interpreter-time / inlining target.
 */
export function dumpJiterpHeat(top = 60): void {
	(globalThis as any).wasm?.Module._dump_jiterp_trace_heat(top);
	(globalThis as any).wasm.runtime.INTERNAL.jiterpreter_dump_stats(false);
}
(globalThis as any).dumpJiterpHeat = dumpJiterpHeat;

/**
 * Every mirrored counter as a flat name=value table, in WJC_* index order. The grouped reports above are
 * curated and can fall behind the C enum; this cannot, because it walks WJ itself — so a counter that no
 * group happens to read is still visible here. An index showing "(unmirrored)" means the C enum grew past
 * this file's WJ and the mirror needs updating (it will read 0 regardless, since mono_wasm_jit_get_counter
 * returns 0 out of range — that is exactly the silent drift the C-side g_static_assert guards).
 */
export function dumpWasmJitCounters(): void {
	const f = (globalThis as any).wasm?.Module?._mono_wasm_jit_get_counter;
	if (typeof f !== "function") { console.log("[wasm-jit counters] unavailable — Module._mono_wasm_jit_get_counter missing"); return; }
	const lines = [`[wasm-jit counters] all ${WJ_MAX} WJC_* counters (cumulative since boot):`];
	for (let i = 0; i < WJ_MAX; i++)
		lines.push(`  ${String(i).padStart(2)} ${WJ_NAMES[i].padEnd(24)} ${Math.round(wjCounter(i)).toLocaleString().padStart(18)}`);
	console.log(lines.join("\n"));
}
(globalThis as any).dumpWasmJitCounters = dumpWasmJitCounters;

/**
 * Dump wasm method-JIT counters (analog of dumpJiterpHeat for the native wasm JIT tier): how many
 * methods were JITted (registered) vs bailed/invalid, how many interp->wasm entries happened, and how
 * many outbound calls fell back to the interpreter (residual). Needs MONO_WASM_JIT_STATS=1 (set above).
 *
 * Prints the runtime's own grouped dump (mono_wasm_jit_dump_stats — same counters, plus the bail
 * histogram / island blockers / hot entry edges, which have no JS getter) and then the flat table.
 */
export function dumpWasmJit(): void {
	(globalThis as any).wasm?.Module?._mono_wasm_jit_dump_stats?.();
	dumpWasmJitCounters();
}
(globalThis as any).dumpWasmJit = dumpWasmJit;

/**
 * Dump the residual-callee ring buffer (last <=128 outbound interp-residual calls). Call this AFTER a
 * crash (e.g. the mode-1 recursive-finish) to name the residual whose interp_entry triggered it — the
 * culprit is among the last entries. Needs MONO_WASM_JIT_STATS=1.
 */
export function dumpResidualRing(): void {
	(globalThis as any).wasm?.Module?._mono_wasm_jit_dump_residual_ring?.();
}
(globalThis as any).dumpResidualRing = dumpResidualRing;
