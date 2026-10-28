// Shared by the frontend and the runtime's filesystem workers. The build copies
// this module into _framework so workers can import it without the app bundle.
const nativeFetch = globalThis.fetch.bind(globalThis);
const manifests = new Map();

async function getManifest(uri) {
	const url = new URL("split-resources.json", uri).href;
	if (!manifests.has(url)) {
		manifests.set(url, nativeFetch(url).then(async (response) => {
			if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.status}`);
			return response.json();
		}));
	}
	return manifests.get(url);
}

export async function fetchResource(uri, init = {}) {
	const url = new URL(uri, globalThis.location.href);
	// WasmFS joins its base directory and filename with an extra slash.
	url.pathname = url.pathname.replace(/\/{2,}/g, "/");
	const manifest = await getManifest(url);
	const entry = manifest[url.pathname.slice(url.pathname.lastIndexOf("/") + 1)];
	if (!entry) return nativeFetch(uri, init);

	const headers = {
		"Content-Type": url.pathname.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
		"Content-Length": String(entry.size),
	};
	// WasmFS stats DLLs before reading them. Report the reconstructed size without
	// downloading and retaining an entire assembly just to answer stat().
	if (init.method === "HEAD") return new Response(null, { headers });

	let index = 0;
	let reader;
	let received = 0;
	const stream = new ReadableStream({
		async pull(controller) {
			while (true) {
				if (!reader) {
					if (index === entry.parts) {
						if (received !== entry.size) throw new Error(`Incomplete split resource: ${url}`);
						controller.close();
						return;
					}
					const part = new URL(url);
					part.pathname += index++;
					const response = await nativeFetch(part, init);
					if (!response.ok || !response.body || response.headers.get("Content-Type")?.includes("text/html")) {
						await response.body?.cancel();
						throw new Error(`Failed to fetch split resource ${part}: ${response.status}`);
					}
					reader = response.body.getReader();
				}
				const { value, done } = await reader.read();
				if (done) {
					reader.releaseLock();
					reader = undefined;
					continue;
				}
				received += value.byteLength;
				controller.enqueue(value);
				return;
			}
		},
		cancel(reason) {
			return reader?.cancel(reason);
		},
	});
	return new Response(stream, { headers });
}

export function installWorkerResourceLoader() {
	if (typeof document !== "undefined") return;
	const framework = new URL(".", import.meta.url).href;
	// WasmFS fetches DLLs on its own worker, outside withResourceLoader. Only
	// intercept framework DLL/Wasm GET and HEAD requests in that worker.
	globalThis.fetch = (input, init = {}) => {
		if (typeof input === "string" && (!init.method || init.method === "GET" || init.method === "HEAD")) {
			const url = new URL(input, globalThis.location.href);
			if (url.href.startsWith(framework) && /\.(dll|wasm)$/.test(url.pathname)) {
				return fetchResource(url.href, init);
			}
		}
		return nativeFetch(input, init);
	};
}
