/**
 * wasmfs's OPFS backend remembers the names a directory lookup found missing (FNA-WASM-Build emsdk.9.patch), so
 * repeated misses -- JDK_Canonicalize probing `/minecraft/file:` ~82,000 times a boot -- stop costing a browser
 * round trip each. Its view is only as fresh as wasmfs's: an entry created through the OPFS API directly, as this
 * frontend does, stays invisible to the game until the cache is invalidated. Call this after creating OPFS files or
 * directories. Before the runtime is up it does nothing, and there is nothing cached to drop.
 */
export function opfsInvalidate(): void {
	(globalThis as any).wasm?.Module?._wasmfs_opfs_invalidate_negative_cache?.();
}
