import { console_debug } from "./dotnet/log";
import { opfsInvalidate } from "./opfs";
import { client } from "./net";

const DEFAULT_PRISM_META_BASE_URL = "https://meta.prismlauncher.org/v1/";
const DEFAULT_MOJANG_VERSION_MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const DEFAULT_RESOURCE_BASE_URL = "https://resources.download.minecraft.net/";
const DEFAULT_LIBRARY_BASE_URL = "https://libraries.minecraft.net/";
const DEFAULT_OPFS_ROOT_DIRECTORY = "ikvmcraft";
const DEFAULT_MAX_CONCURRENT_ASSET_DOWNLOADS = 8;
const DEFAULT_MAX_CONCURRENT_LIBRARY_DOWNLOADS = 8;
const DEFAULT_MAX_CONCURRENT_ASSET_CHECKS = 64;
const DEFAULT_SHA1_WORKER_COUNT = 8;
const DEFAULT_MINECRAFT_OS_NAME = "linux";
const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_ATTEMPTS = 4;

const VERSION_MANIFEST_FILENAME = "version.json";
const CLIENT_JAR_FILENAME = "client.jar";
const CLIENT_MAPPINGS_FILENAME = "client.txt";

const FABRIC_LOADER_PACKAGE = "net.fabricmc.fabric-loader";
const FABRIC_INTERMEDIARY_PACKAGE = "net.fabricmc.intermediary";

const DEV_PROXY_PREFIX_BY_HOST: Record<string, string> = {
	"meta.prismlauncher.org": "/proxy/meta",
	"piston-meta.mojang.com": "/proxy/piston-meta",
	"piston-data.mojang.com": "/proxy/piston-data",
	"launcher.mojang.com": "/proxy/launcher",
	"resources.download.minecraft.net": "/proxy/resources",
	"libraries.minecraft.net": "/proxy/libraries",
	"repo1.maven.org": "/proxy/maven-central",
	"repo.maven.apache.org": "/proxy/maven-central-alt",
	"maven.fabricmc.net": "/proxy/maven-fabricmc",
};

interface PrismVersionList {
	versions: PrismVersionEntry[];
}

interface PrismVersionEntry {
	version: string;
}

interface DownloadInfo {
	url: string;
	sha1?: string;
	size?: number;
	path?: string;
}

interface MinecraftRule {
	action?: string;
	os?: {
		name?: string;
	};
}

interface PrismMinecraftVersion {
	id?: string;
	version?: string;
	inheritsFrom?: string;
	mainClass?: string;
	type?: string;
	assets?: string;
	downloads?: {
		client?: DownloadInfo;
	};
	mainJar?: {
		downloads?: {
			artifact?: DownloadInfo;
		};
	};
	assetIndex?: DownloadInfo & {
		id?: string;
	};
	libraries?: PrismMinecraftLibrary[];
}

interface PrismFabricManifest {
	uid?: string;
	version?: string;
	mainClass?: string;
	libraries?: PrismMinecraftLibrary[];
}

interface MojangVersionListEntry {
	id: string;
	url: string;
}

interface MojangVersionList {
	versions: MojangVersionListEntry[];
}

interface MojangVersionManifest {
	downloads?: {
		client_mappings?: DownloadInfo;
	};
}

interface PrismMinecraftLibrary {
	name?: string;
	url?: string;
	downloads?: {
		artifact?: DownloadInfo;
	};
	rules?: MinecraftRule[];
}

interface AssetIndexObject {
	hash: string;
	size?: number;
}

interface AssetIndex {
	objects: Record<string, AssetIndexObject>;
}

interface AssetObjectDownload {
	hash: string;
	size?: number;
}

interface LibraryDownload {
	name: string;
	relativePath: string;
	url: string;
	sha1?: string;
	size?: number;
}

interface IntegrityExpectation {
	sha1?: string;
	size?: number;
}

export interface MinecraftDownloadProgress {
	phase: "metadata" | "libraries" | "client" | "mappings" | "assets" | "fabric" | "complete";
	completedFiles: number;
	totalFiles: number;
	downloadedBytes: number;
	totalBytes: number | null;
}

export interface DownloadMinecraftVersionToOpfsOptions {
	prismMetaBaseUrl?: string;
	mojangVersionManifestUrl?: string;
	resourceBaseUrl?: string;
	libraryBaseUrl?: string;
	opfsRootDirectory?: string;
	maxConcurrentAssetDownloads?: number;
	maxConcurrentLibraryDownloads?: number;
	minecraftOsName?: string;
	onProgress?: (progress: MinecraftDownloadProgress) => void;
}

export interface DownloadMinecraftVersionToOpfsResult {
	version: string;
	versionJsonPath: string;
	clientJarPath: string;
	clientMappingsPath: string | null;
	libraryCount: number;
	librariesDirectoryPath: string;
	assetIndexId: string;
	assetIndexPath: string;
	assetObjectCount: number;
	assetObjectsDirectoryPath: string;
}

// How thoroughly isMinecraftVersionDownloaded checks each file on disk:
// "exists" only looks the file up, "size" compares the size from file metadata
// without reading any contents, and "sha1" reads and hashes every file.
export type VerificationMode = "exists" | "size" | "sha1";

export interface IsMinecraftVersionDownloadedOptions {
	opfsRootDirectory?: string;
	verifyAssetObjects?: boolean;
	verification?: VerificationMode;
	verifyClientMappings?: boolean;
	mojangVersionManifestUrl?: string;
	minecraftOsName?: string;
	maxConcurrentAssetChecks?: number;
}

export interface DownloadFabricMinecraftVersionToOpfsOptions extends DownloadMinecraftVersionToOpfsOptions {
	loaderVersion?: string;
	intermediaryVersion?: string;
	fabricVersionId?: string;
	skipVanillaIfDownloaded?: boolean;
}

export interface DownloadFabricMinecraftVersionToOpfsResult extends DownloadMinecraftVersionToOpfsResult {
	loaderVersion: string;
	intermediaryVersion: string;
	inheritsFrom: string;
}

function ensureTrailingSlash(url: string): string {
	return url.endsWith("/") ? url : `${url}/`;
}

function ensurePositiveInteger(value: number, fallback: number): number {
	if (!Number.isFinite(value)) {
		return fallback;
	}

	const normalized = Math.floor(value);
	return normalized > 0 ? normalized : fallback;
}

function ensureSafePathSegment(segment: string, label: string): string {
	const trimmed = segment.trim();
	if (trimmed.length === 0) {
		throw new Error(`Invalid ${label}: segment is empty.`);
	}

	if (trimmed === "." || trimmed === ".." || trimmed.includes("/") || trimmed.includes("\\")) {
		throw new Error(`Invalid ${label}: '${segment}'.`);
	}

	return trimmed;
}

function normalizeMinecraftOsName(osName: string | undefined): string {
	if (osName === undefined) {
		return DEFAULT_MINECRAFT_OS_NAME;
	}

	const normalized = osName.trim().toLowerCase();
	if (normalized === "emscripten") {
		return "linux";
	}

	return normalized.length === 0 ? DEFAULT_MINECRAFT_OS_NAME : normalized;
}

function splitPath(path: string): string[] {
	const parts = path.split("/").filter((part) => part.length > 0);
	if (parts.length === 0) {
		throw new Error("OPFS path must not be empty.");
	}

	for (const part of parts) {
		ensureSafePathSegment(part, "path segment");
	}

	return parts;
}

class DownloadHttpError extends Error {
	constructor(url: string, readonly status: number, statusText: string) {
		super(`Request failed for '${url}': HTTP ${status} ${statusText}`);
	}

	get retryable(): boolean {
		return this.status === 408 || this.status === 429 || this.status >= 500;
	}
}

async function downloadFetch(url: string, signal: AbortSignal, useWisp: boolean): Promise<Response> {
	const target = new URL(url, location.href);
	const init: RequestInit = { signal, cache: "no-store", redirect: "follow" };
	if (target.origin === location.origin) return await fetch(target, init);
	const prefix = DEV_PROXY_PREFIX_BY_HOST[target.hostname];
	if (import.meta.env.DEV && !useWisp && prefix !== undefined) {
		return await fetch(`${prefix}${target.pathname}${target.search}`, init);
	}
	return await client.fetch(target, init);
}

// Keep the deadline active until the body has finished, resetting it for every
// chunk. Racing it also bounds transports that don't settle promptly on abort.
async function fetchArrayBufferAttempt(
	url: string,
	useWisp: boolean,
	onBytes?: (bytes: number) => void,
): Promise<ArrayBuffer> {
	const controller = new AbortController();
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let timer: ReturnType<typeof setTimeout>;
	let rejectTimeout: (error: Error) => void;
	const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
	const resetTimeout = () => {
		clearTimeout(timer);
		timer = setTimeout(() => {
			const error = new Error(`Download timed out after 30 seconds without data: '${url}'.`);
			controller.abort(error);
			void reader?.cancel(error).catch(() => {});
			rejectTimeout(error);
		}, DOWNLOAD_IDLE_TIMEOUT_MS);
	};
	resetTimeout();
	const operation = (async () => {
		const response = await downloadFetch(url, controller.signal, useWisp);
		if (controller.signal.aborted || !response.ok) {
			void response.body?.cancel().catch(() => {});
			controller.signal.throwIfAborted();
			throw new DownloadHttpError(url, response.status, response.statusText);
		}
		resetTimeout();
		const chunks: Uint8Array[] = [];
		let length = 0;
		reader = response.body?.getReader();
		try {
			while (reader !== undefined) {
				const { done, value } = await reader.read();
				controller.signal.throwIfAborted();
				if (done) break;
				chunks.push(value);
				length += value.byteLength;
				resetTimeout();
				onBytes?.(length);
			}
		} finally {
			reader?.releaseLock();
			reader = undefined;
		}
		// Content-Length describes compressed bytes when Content-Encoding is set.
		const encoding = response.headers.get("content-encoding");
		const contentLength = response.headers.get("content-length");
		if (contentLength !== null && (!encoding || encoding === "identity") && Number(contentLength) !== length) {
			throw new Error(`Incomplete download for '${url}': expected ${contentLength} bytes, got ${length}.`);
		}
		const data = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			data.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return data.buffer;
	})();
	try {
		return await Promise.race([operation, timeout]);
	} catch (error) {
		controller.abort(error);
		void reader?.cancel(error).catch(() => {});
		throw error;
	} finally {
		clearTimeout(timer!);
	}
}

async function fetchWithRetry<T>(
	url: string,
	decode: (data: ArrayBuffer) => T | Promise<T>,
	onBytes?: (bytes: number) => void,
): Promise<T> {
	for (let attempt = 1; ; attempt += 1) {
		onBytes?.(0);
		try {
			// Dev prefers its HTTP proxy; subsequent attempts fall back to Wisp.
			const data = await fetchArrayBufferAttempt(url, attempt > 1, onBytes);
			return await decode(data);
		} catch (error) {
			onBytes?.(0);
			if (attempt >= MAX_DOWNLOAD_ATTEMPTS || (error instanceof DownloadHttpError && !error.retryable)) {
				throw new Error(`Failed to download '${url}' after ${attempt} attempt(s): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
			}
			console.warn(`[minecraft] Retrying '${url}' (${attempt + 1}/${MAX_DOWNLOAD_ATTEMPTS}).`, error);
			await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
		}
	}
}

async function fetchJson<T>(url: string): Promise<T> {
	return await fetchWithRetry(url, (data) => JSON.parse(new TextDecoder().decode(data)) as T);
}

async function fetchText(url: string): Promise<string> {
	return await fetchWithRetry(url, (data) => {
		const text = new TextDecoder().decode(data);
		JSON.parse(text); // All text fetches here are manifests; retry truncated JSON.
		return text;
	});
}

class DownloadProgressReporter {
	private readonly bytes: number[];
	private downloadedBytes = 0;
	private completedFiles = 0;
	private lastReport = 0;
	private readonly totalBytes: number | null;

	constructor(
		private readonly phase: MinecraftDownloadProgress["phase"],
		private readonly files: readonly IntegrityExpectation[],
		private readonly onProgress?: DownloadMinecraftVersionToOpfsOptions["onProgress"],
	) {
		this.bytes = files.map(() => 0);
		this.totalBytes = files.every((file) => file.size !== undefined)
			? files.reduce((sum, file) => sum + file.size!, 0) : null;
		this.report(true);
	}

	update(index: number, bytes: number): void {
		this.setBytes(index, Math.min(bytes, this.files[index].size ?? bytes));
		this.report();
	}

	complete(index: number, bytes: number): void {
		this.setBytes(index, bytes);
		this.completedFiles += 1;
		this.report(true);
	}

	private setBytes(index: number, bytes: number): void {
		this.downloadedBytes += bytes - this.bytes[index];
		this.bytes[index] = bytes;
	}

	private report(force = false): void {
		if (!this.onProgress || (!force && Date.now() - this.lastReport < 100)) return;
		this.lastReport = Date.now();
		this.onProgress({
			phase: this.phase,
			completedFiles: this.completedFiles,
			totalFiles: this.files.length,
			downloadedBytes: this.downloadedBytes,
			totalBytes: this.totalBytes,
		});
	}
}

type Sha1WorkerRequest = {
	id: number;
	data: ArrayBuffer;
};

type Sha1WorkerResponse = {
	id: number;
	hash?: string;
	error?: string;
};

type Sha1WorkerTask = {
	id: number;
	data: ArrayBuffer;
	resolve: (hash: string) => void;
	reject: (error: Error) => void;
};

class Sha1WorkerPool {
	private readonly workers: Worker[];
	private readonly idleWorkers: Worker[];
	private readonly inflight = new Map<number, { resolve: (hash: string) => void; reject: (error: Error) => void }>();
	private readonly workerToTaskId = new Map<Worker, number>();
	private readonly queue: Sha1WorkerTask[] = [];
	private nextId = 1;

	constructor(workerCount: number) {
		this.workers = Array.from({ length: workerCount }, () => {
			return new Worker(new URL("./sha1.worker.ts", import.meta.url), { type: "module" });
		});
		this.idleWorkers = [...this.workers];
		for (const worker of this.workers) {
			worker.addEventListener("message", (event) => {
				this.handleMessage(worker, event as MessageEvent<Sha1WorkerResponse>);
			});
			worker.addEventListener("error", (event) => {
				this.handleError(worker, event as ErrorEvent);
			});
		}
	}

	hash(data: ArrayBuffer): Promise<string> {
		return new Promise((resolve, reject) => {
			const task: Sha1WorkerTask = {
				id: this.nextId,
				data,
				resolve,
				reject,
			};
			this.nextId += 1;
			this.queue.push(task);
			this.pump();
		});
	}

	private pump(): void {
		while (this.idleWorkers.length > 0 && this.queue.length > 0) {
			const worker = this.idleWorkers.pop();
			const task = this.queue.shift();
			if (worker === undefined || task === undefined) {
				return;
			}
			this.inflight.set(task.id, { resolve: task.resolve, reject: task.reject });
			this.workerToTaskId.set(worker, task.id);
			worker.postMessage({ id: task.id, data: task.data } satisfies Sha1WorkerRequest);
		}
	}

	private handleMessage(worker: Worker, event: MessageEvent<Sha1WorkerResponse>): void {
		const { id, hash, error } = event.data;
		const callbacks = this.inflight.get(id);
		if (callbacks !== undefined) {
			this.inflight.delete(id);
			if (error !== undefined) {
				callbacks.reject(new Error(error));
			} else if (hash !== undefined) {
				callbacks.resolve(hash);
			} else {
				callbacks.reject(new Error("SHA-1 worker returned no result."));
			}
		}
		this.workerToTaskId.delete(worker);
		this.idleWorkers.push(worker);
		this.pump();
	}

	private handleError(worker: Worker, event: ErrorEvent): void {
		const taskId = this.workerToTaskId.get(worker);
		if (taskId !== undefined) {
			const callbacks = this.inflight.get(taskId);
			this.inflight.delete(taskId);
			this.workerToTaskId.delete(worker);
			this.idleWorkers.push(worker);
			this.pump();
			callbacks?.reject(event.error instanceof Error ? event.error : new Error(event.message));
			return;
		}
		console.warn("[minecraft] SHA-1 worker error.", event);
	}

	terminate(): void {
		for (const worker of this.workers) {
			worker.terminate();
		}

		// A terminated worker never answers, so settle anything still pending;
		// getSha1Hex falls back to hashing on the main thread.
		const error = new Error("SHA-1 worker pool was terminated.");
		for (const callbacks of this.inflight.values()) {
			callbacks.reject(error);
		}
		for (const task of this.queue) {
			task.reject(error);
		}
		this.inflight.clear();
		this.queue.length = 0;
		this.workerToTaskId.clear();
		this.idleWorkers.length = 0;
	}
}

function resolveSha1WorkerCount(): number {
	if (typeof navigator === "undefined") {
		return DEFAULT_SHA1_WORKER_COUNT;
	}
	const hardwareCount = navigator.hardwareConcurrency ?? DEFAULT_SHA1_WORKER_COUNT;
	return Math.max(1, Math.min(DEFAULT_SHA1_WORKER_COUNT, hardwareCount));
}

function createSha1WorkerPool(): Sha1WorkerPool | null {
	if (typeof Worker === "undefined") {
		return null;
	}
	try {
		return new Sha1WorkerPool(resolveSha1WorkerCount());
	} catch (error) {
		console.warn("[minecraft] Failed to initialize SHA-1 worker pool.", error);
		return null;
	}
}

// The pool only exists while something that hashes (a download or a sha1
// verification pass) is running, and is torn down when the last one finishes.
// Hashing outside of withSha1WorkerPool happens on the main thread.
let sha1WorkerPool: Sha1WorkerPool | null = null;
let sha1WorkerPoolUsers = 0;

async function withSha1WorkerPool<T>(fn: () => Promise<T>): Promise<T> {
	if (sha1WorkerPoolUsers === 0) {
		sha1WorkerPool = createSha1WorkerPool();
	}
	sha1WorkerPoolUsers += 1;
	try {
		return await fn();
	} finally {
		sha1WorkerPoolUsers -= 1;
		if (sha1WorkerPoolUsers === 0) {
			sha1WorkerPool?.terminate();
			sha1WorkerPool = null;
		}
	}
}

async function getSha1HexInline(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-1", data);
	const bytes = new Uint8Array(digest);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function getSha1Hex(data: ArrayBuffer): Promise<string> {
	if (sha1WorkerPool === null) {
		return await getSha1HexInline(data);
	}
	try {
		return await sha1WorkerPool.hash(data);
	} catch (error) {
		console.warn("[minecraft] SHA-1 worker failed, falling back to main thread.", error);
		return await getSha1HexInline(data);
	}
}

async function assertIntegrity(
	data: ArrayBuffer,
	expectation: IntegrityExpectation,
	context: string,
): Promise<void> {
	const expectedSize = expectation.size;
	if (expectedSize !== undefined && data.byteLength !== expectedSize) {
		throw new Error(`Size mismatch for ${context}: expected ${expectedSize}, got ${data.byteLength}.`);
	}

	const expectedSha1 = expectation.sha1;
	if (expectedSha1 !== undefined) {
		const actualSha1 = await getSha1Hex(data);
		if (actualSha1 !== expectedSha1.toLowerCase()) {
			throw new Error(`SHA-1 mismatch for ${context}: expected ${expectedSha1}, got ${actualSha1}.`);
		}
	}
}

// Some Fabric libraries have no hash or size in their metadata. Check both
// the ZIP header and end record so a truncated jar cannot pass on magic alone.
function assertLooksLikeArchive(data: ArrayBuffer, context: string): void {
	const header = new Uint8Array(data, 0, Math.min(4, data.byteLength));
	if (header.length < 4 || header[0] !== 0x50 || header[1] !== 0x4b
		|| !((header[2] === 3 && header[3] === 4) || (header[2] === 5 && header[3] === 6))) {
		throw new Error(`${context} is not a valid zip/jar (bad magic bytes; likely an error page or truncated download).`);
	}
	const view = new DataView(data);
	for (let offset = data.byteLength - 22; offset >= Math.max(0, data.byteLength - 22 - 65535); offset -= 1) {
		if (view.getUint32(offset, true) !== 0x06054b50 || offset + 22 + view.getUint16(offset + 20, true) !== data.byteLength) continue;
		const directorySize = view.getUint32(offset + 12, true);
		const directoryOffset = view.getUint32(offset + 16, true);
		if (directorySize === 0xffffffff || directoryOffset === 0xffffffff || directoryOffset + directorySize <= offset) return;
	}
	throw new Error(`${context} is not a complete zip/jar (missing or invalid end record).`);
}

async function downloadBinary(
	url: string,
	expectation: IntegrityExpectation,
	context: string,
	onBytes?: (bytes: number) => void,
	validate?: (data: ArrayBuffer) => void,
): Promise<ArrayBuffer> {
	return await fetchWithRetry(url, async (data) => {
		await assertIntegrity(data, expectation, context);
		validate?.(data);
		return data;
	}, onBytes);
}

async function getOrCreateDirectory(
	root: FileSystemDirectoryHandle,
	pathSegments: string[],
): Promise<FileSystemDirectoryHandle> {
	let current = root;
	for (const segment of pathSegments) {
		current = await current.getDirectoryHandle(segment, { create: true });
	}
	opfsInvalidate();
	return current;
}

function isNotFoundError(error: unknown): boolean {
	return error instanceof DOMException && error.name === "NotFoundError";
}

async function getDirectoryIfExists(
	root: FileSystemDirectoryHandle,
	pathSegments: string[],
): Promise<FileSystemDirectoryHandle | null> {
	let current = root;
	for (const segment of pathSegments) {
		try {
			current = await current.getDirectoryHandle(segment);
		} catch (error) {
			if (isNotFoundError(error)) {
				return null;
			}

			throw error;
		}
	}

	return current;
}

async function getFileHandleIfExists(
	root: FileSystemDirectoryHandle,
	path: string,
): Promise<FileSystemFileHandle | null> {
	const segments = splitPath(path);
	const fileName = segments[segments.length - 1];
	if (fileName === undefined) {
		throw new Error(`Cannot resolve file name for path '${path}'.`);
	}

	const parentDirectory = await getDirectoryIfExists(root, segments.slice(0, -1));
	if (parentDirectory === null) {
		return null;
	}

	try {
		return await parentDirectory.getFileHandle(fileName);
	} catch (error) {
		if (isNotFoundError(error)) {
			return null;
		}

		throw error;
	}
}

async function fileExists(root: FileSystemDirectoryHandle, path: string): Promise<boolean> {
	return (await getFileHandleIfExists(root, path)) !== null;
}

async function readFileText(root: FileSystemDirectoryHandle, path: string): Promise<string> {
	const fileHandle = await getFileHandleIfExists(root, path);
	if (fileHandle === null) {
		throw new Error(`Missing file '${path}'.`);
	}

	const file = await fileHandle.getFile();
	return await file.text();
}

async function readFileArrayBuffer(root: FileSystemDirectoryHandle, path: string): Promise<ArrayBuffer> {
	const fileHandle = await getFileHandleIfExists(root, path);
	if (fileHandle === null) {
		throw new Error(`Missing file '${path}'.`);
	}

	const file = await fileHandle.getFile();
	return await file.arrayBuffer();
}

async function verifyOpfsFile(
	root: FileSystemDirectoryHandle,
	path: string,
	expectation: IntegrityExpectation,
	context: string,
	verification: VerificationMode,
): Promise<void> {
	if (verification === "sha1") {
		const data = await readFileArrayBuffer(root, path);
		await assertIntegrity(data, expectation, context);
		if (path.endsWith(".jar")) {
			assertLooksLikeArchive(data, context);
		}
		return;
	}

	const fileHandle = await getFileHandleIfExists(root, path);
	if (fileHandle === null) {
		throw new Error(`Missing ${context} at '${path}'.`);
	}

	// getFile() hands back a lazy snapshot, so reading its size doesn't touch the
	// contents. Entries with no size in their metadata only get the existence check.
	const expectedSize = expectation.size;
	if (verification === "size" && expectedSize !== undefined) {
		const { size } = await fileHandle.getFile();
		if (size !== expectedSize) {
			throw new Error(`Size mismatch for ${context}: expected ${expectedSize}, got ${size}.`);
		}
	}
	if (verification === "size" && expectedSize === undefined && path.endsWith(".jar")) {
		const data = await (await fileHandle.getFile()).arrayBuffer();
		await assertIntegrity(data, expectation, context);
		assertLooksLikeArchive(data, context);
	}
}

async function writeFileToOpfs(
	root: FileSystemDirectoryHandle,
	path: string,
	content: FileSystemWriteChunkType,
): Promise<void> {
	const segments = splitPath(path);
	const fileName = segments[segments.length - 1];
	if (fileName === undefined) {
		throw new Error(`Cannot resolve file name for path '${path}'.`);
	}

	const directory = await getOrCreateDirectory(root, segments.slice(0, -1));
	const fileHandle = await directory.getFileHandle(fileName, { create: true });
	opfsInvalidate();
	const writable = await fileHandle.createWritable();
	try {
		await writable.write(content);
		await writable.close();
	} catch (error) {
		await writable.abort().catch(() => {});
		throw error;
	}
}

// A failed launch can be retried without fetching every previously completed
// file again. Only reuse files that pass integrity checks, including ZIP checks
// for libraries whose manifests don't provide a hash.
async function ensureDownloadedFile(
	root: FileSystemDirectoryHandle,
	path: string,
	url: string,
	expectation: IntegrityExpectation,
	context: string,
	onBytes?: (bytes: number) => void,
): Promise<number> {
	const validate = (data: ArrayBuffer) => {
		if (path.endsWith(".jar")) assertLooksLikeArchive(data, context);
		if (path.endsWith(".json")) JSON.parse(new TextDecoder().decode(data));
	};
	const cached = await getFileHandleIfExists(root, path);
	if (cached !== null) {
		const file = await cached.getFile();
		try {
			if (expectation.size !== undefined && file.size !== expectation.size) {
				throw new Error(`Size mismatch for cached ${context}.`);
			}
			const data = await file.arrayBuffer();
			await assertIntegrity(data, expectation, context);
			validate(data);
			onBytes?.(data.byteLength);
			return data.byteLength;
		} catch (error) {
			console.debug(`[minecraft] Replacing invalid cached ${context}.`, error);
		}
	}
	const data = await downloadBinary(url, expectation, context, onBytes, validate);
	await writeFileToOpfs(root, path, data);
	return data.byteLength;
}

function warnDownloadCheckFailure(context: string, error?: unknown): void {
	if (error === undefined) {
		console.warn(`[minecraft] ${context}`);
		return;
	}
	console.warn(`[minecraft] ${context}`, error);
}

function collectAssetObjects(assetIndex: AssetIndex): AssetObjectDownload[] {
	if (assetIndex.objects === undefined) {
		throw new Error("Asset index is missing 'objects'.");
	}

	const byHash = new Map<string, number | undefined>();
	for (const object of Object.values(assetIndex.objects)) {
		const hash = object.hash.toLowerCase();
		if (!/^[0-9a-f]{40}$/.test(hash)) {
			throw new Error(`Invalid asset hash '${object.hash}'.`);
		}

		if (!byHash.has(hash)) {
			byHash.set(hash, object.size);
		}
	}

	return Array.from(byHash, ([hash, size]) => ({ hash, size }));
}

function resolveClientDownload(versionManifest: PrismMinecraftVersion): DownloadInfo | undefined {
	return versionManifest.downloads?.client ?? versionManifest.mainJar?.downloads?.artifact;
}

async function resolveMojangClientMappingsDownload(
	version: string,
	mojangVersionManifestUrl: string,
): Promise<DownloadInfo | null> {
	const list = await fetchJson<MojangVersionList>(mojangVersionManifestUrl);
	const entry = list.versions?.find((candidate) => candidate.id === version);
	if (entry === undefined) {
		return null;
	}

	const manifest = await fetchJson<MojangVersionManifest>(entry.url);
	return manifest.downloads?.client_mappings ?? null;
}

function shouldIncludeLibrary(rules: MinecraftRule[] | undefined, minecraftOsName: string): boolean {
	if (rules === undefined || rules.length === 0) {
		return true;
	}

	let allowed = false;
	for (const rule of rules) {
		let matchesOs = true;
		if (rule.os?.name !== undefined) {
			matchesOs = normalizeMinecraftOsName(rule.os.name) === minecraftOsName;
		}

		if (!matchesOs) {
			continue;
		}

		allowed = (rule.action ?? "allow").toLowerCase() === "allow";
	}

	return allowed;
}

function parseMavenLibraryPath(libraryName: string): string {
	const segments = libraryName.split(":");
	if (segments.length < 3) {
		throw new Error(`Cannot parse Maven coordinates '${libraryName}'.`);
	}

	const group = segments[0];
	const artifact = segments[1];
	const version = segments[2];
	const classifier = segments.length > 3 && segments[3].trim().length > 0 ? `-${segments[3].trim()}` : "";

	const groupPath = group.split(".").join("/");
	return `${groupPath}/${artifact}/${version}/${artifact}-${version}${classifier}.jar`;
}

function resolveLibraryRelativePath(library: PrismMinecraftLibrary): string {
	const downloadPath = library.downloads?.artifact?.path;
	if (downloadPath !== undefined) {
		return downloadPath;
	}

	if (library.name === undefined) {
		throw new Error("Library entry is missing both 'downloads.artifact.path' and 'name'.");
	}

	return parseMavenLibraryPath(library.name);
}

function resolveLibraryUrl(library: PrismMinecraftLibrary, relativePath: string, libraryBaseUrl: string): string {
	const artifactUrl = library.downloads?.artifact?.url;
	if (artifactUrl !== undefined) {
		return artifactUrl;
	}

	const baseUrl = library.url !== undefined ? ensureTrailingSlash(library.url) : libraryBaseUrl;
	return new URL(relativePath, baseUrl).toString();
}

function collectLibraryDownloads(
	libraries: PrismMinecraftLibrary[] | undefined,
	libraryBaseUrl: string,
	minecraftOsName: string,
): LibraryDownload[] {
	if (libraries === undefined) {
		return [];
	}

	const byRelativePath = new Map<string, LibraryDownload>();
	for (const library of libraries) {
		if (!shouldIncludeLibrary(library.rules, minecraftOsName)) {
			continue;
		}

		const relativePath = resolveLibraryRelativePath(library);
		const url = resolveLibraryUrl(library, relativePath, libraryBaseUrl);
		const resolved = {
			name: library.name ?? relativePath,
			relativePath,
			url,
			sha1: library.downloads?.artifact?.sha1,
			size: library.downloads?.artifact?.size,
		} satisfies LibraryDownload;

		if (!byRelativePath.has(relativePath)) {
			byRelativePath.set(relativePath, resolved);
		}
	}

	return Array.from(byRelativePath.values());
}

async function runConcurrently<T>(
	items: readonly T[],
	concurrency: number,
	worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
	if (items.length === 0) {
		return;
	}

	let cursor = 0;
	let stopped = false;
	const workerCount = Math.min(concurrency, items.length);
	const runners = Array.from({ length: workerCount }, async () => {
		while (!stopped) {
			const index = cursor;
			cursor += 1;
			if (index >= items.length) {
				return;
			}

			try {
				await worker(items[index], index);
			} catch (error) {
				stopped = true;
				throw error;
			}
		}
	});

	// Drain active workers before returning an error so retries don't overlap
	// writes from the failed run or terminate hash workers still in use.
	const results = await Promise.allSettled(runners);
	const failure = results.find((result) => result.status === "rejected");
	if (failure?.status === "rejected") throw failure.reason;
}

export async function downloadMinecraftVersionToOpfs(
	version: string,
	options: DownloadMinecraftVersionToOpfsOptions = {},
): Promise<DownloadMinecraftVersionToOpfsResult> {
	const result = await withSha1WorkerPool(() => downloadMinecraftVersionToOpfsImpl(version, options));
	new DownloadProgressReporter("complete", [], options.onProgress);
	return result;
}

async function downloadMinecraftVersionToOpfsImpl(
	version: string,
	options: DownloadMinecraftVersionToOpfsOptions,
): Promise<DownloadMinecraftVersionToOpfsResult> {
	new DownloadProgressReporter("metadata", [], options.onProgress);
	const prismMetaBaseUrl = ensureTrailingSlash(options.prismMetaBaseUrl ?? DEFAULT_PRISM_META_BASE_URL);
	const mojangVersionManifestUrl = options.mojangVersionManifestUrl ?? DEFAULT_MOJANG_VERSION_MANIFEST_URL;
	const resourceBaseUrl = ensureTrailingSlash(options.resourceBaseUrl ?? DEFAULT_RESOURCE_BASE_URL);
	const libraryBaseUrl = ensureTrailingSlash(options.libraryBaseUrl ?? DEFAULT_LIBRARY_BASE_URL);
	const opfsRootDirectory = ensureSafePathSegment(
		options.opfsRootDirectory ?? DEFAULT_OPFS_ROOT_DIRECTORY,
		"OPFS root directory",
	);
	const minecraftOsName = normalizeMinecraftOsName(options.minecraftOsName);
	const maxConcurrentAssetDownloads = ensurePositiveInteger(
		options.maxConcurrentAssetDownloads ?? DEFAULT_MAX_CONCURRENT_ASSET_DOWNLOADS,
		DEFAULT_MAX_CONCURRENT_ASSET_DOWNLOADS,
	);
	const maxConcurrentLibraryDownloads = ensurePositiveInteger(
		options.maxConcurrentLibraryDownloads ?? DEFAULT_MAX_CONCURRENT_LIBRARY_DOWNLOADS,
		DEFAULT_MAX_CONCURRENT_LIBRARY_DOWNLOADS,
	);

	const requestedVersion = ensureSafePathSegment(version, "version");
	const versionListUrl = new URL("net.minecraft/index.json", prismMetaBaseUrl).toString();
	const versionList = await fetchJson<PrismVersionList>(versionListUrl);
	const selectedVersion = versionList.versions.find((entry) => entry.version === requestedVersion);
	if (selectedVersion === undefined) {
		throw new Error(`Minecraft version '${requestedVersion}' was not found in Prism metadata.`);
	}

	const versionManifestUrl = new URL(
		`net.minecraft/${encodeURIComponent(selectedVersion.version)}.json`,
		prismMetaBaseUrl,
	).toString();
	const versionManifestText = await fetchText(versionManifestUrl);
	const versionManifest = JSON.parse(versionManifestText) as PrismMinecraftVersion;

	const clientDownload = resolveClientDownload(versionManifest);
	if (clientDownload === undefined) {
		throw new Error(`Version '${selectedVersion.version}' does not define a client download (checked 'downloads.client' and 'mainJar.downloads.artifact').`);
	}

	const assetIndexDownload = versionManifest.assetIndex;
	if (assetIndexDownload === undefined) {
		throw new Error(
			`Version '${selectedVersion.version}' does not define 'assetIndex' (legacy assets pipeline is not supported).`,
		);
	}

	const resolvedVersion = ensureSafePathSegment(
		versionManifest.id ?? versionManifest.version ?? selectedVersion.version,
		"resolved version",
	);
	const assetIndexId = ensureSafePathSegment(
		assetIndexDownload.id ?? versionManifest.assets ?? resolvedVersion,
		"asset index id",
	);

	const root = await navigator.storage.getDirectory();
	const versionDirectory = `${opfsRootDirectory}/versions/${resolvedVersion}`;
	const versionJsonPath = `${versionDirectory}/${VERSION_MANIFEST_FILENAME}`;
	await writeFileToOpfs(root, versionJsonPath, versionManifestText);

	const libraries = collectLibraryDownloads(versionManifest.libraries, libraryBaseUrl, minecraftOsName);
	const libraryProgress = new DownloadProgressReporter("libraries", libraries, options.onProgress);
	await runConcurrently(libraries, maxConcurrentLibraryDownloads, async (library, index) => {
		const libraryPath = `${opfsRootDirectory}/libraries/${library.relativePath}`;
		const size = await ensureDownloadedFile(
			root,
			libraryPath,
			library.url,
			{ sha1: library.sha1, size: library.size },
			`library '${library.name}'`,
			(bytes) => libraryProgress.update(index, bytes),
		);
		libraryProgress.complete(index, size);
	});

	const clientJarPath = `${versionDirectory}/${CLIENT_JAR_FILENAME}`;
	const clientProgress = new DownloadProgressReporter("client", [clientDownload], options.onProgress);
	const clientSize = await ensureDownloadedFile(root, clientJarPath, clientDownload.url, clientDownload,
		`client jar '${resolvedVersion}'`, (bytes) => clientProgress.update(0, bytes));
	clientProgress.complete(0, clientSize);

	const clientMappingsDownload = await resolveMojangClientMappingsDownload(resolvedVersion, mojangVersionManifestUrl);
	let clientMappingsPath: string | null = null;
	if (clientMappingsDownload !== null) {
		const mappingsProgress = new DownloadProgressReporter("mappings", [clientMappingsDownload], options.onProgress);
		clientMappingsPath = `${versionDirectory}/${CLIENT_MAPPINGS_FILENAME}`;
		const size = await ensureDownloadedFile(
			root,
			clientMappingsPath,
			clientMappingsDownload.url,
			clientMappingsDownload,
			`client mappings '${resolvedVersion}'`,
			(bytes) => mappingsProgress.update(0, bytes),
		);
		mappingsProgress.complete(0, size);
	}

	new DownloadProgressReporter("metadata", [], options.onProgress);
	const assetIndexPath = `${opfsRootDirectory}/assets/indexes/${assetIndexId}.json`;
	await ensureDownloadedFile(
		root,
		assetIndexPath,
		assetIndexDownload.url,
		assetIndexDownload,
		`asset index '${assetIndexId}'`,
	);
	const assetIndexText = await readFileText(root, assetIndexPath);
	const parsedAssetIndex = JSON.parse(assetIndexText) as AssetIndex;

	const assetObjects = collectAssetObjects(parsedAssetIndex);
	const assetProgress = new DownloadProgressReporter("assets", assetObjects, options.onProgress);
	await runConcurrently(assetObjects, maxConcurrentAssetDownloads, async (assetObject, index) => {
		const prefix = assetObject.hash.slice(0, 2);
		const objectUrl = new URL(`${prefix}/${assetObject.hash}`, resourceBaseUrl).toString();
		const objectPath = `${opfsRootDirectory}/assets/objects/${prefix}/${assetObject.hash}`;
		const size = await ensureDownloadedFile(
			root,
			objectPath,
			objectUrl,
			{ sha1: assetObject.hash, size: assetObject.size },
			`asset object '${assetObject.hash}'`,
			(bytes) => assetProgress.update(index, bytes),
		);
		assetProgress.complete(index, size);
	});

	return {
		version: resolvedVersion,
		versionJsonPath,
		clientJarPath,
		clientMappingsPath,
		libraryCount: libraries.length,
		librariesDirectoryPath: `${opfsRootDirectory}/libraries`,
		assetIndexId,
		assetIndexPath,
		assetObjectCount: assetObjects.length,
		assetObjectsDirectoryPath: `${opfsRootDirectory}/assets/objects`,
	};
}

export async function isMinecraftVersionDownloaded(
	version: string,
	options: IsMinecraftVersionDownloadedOptions = {},
): Promise<boolean> {
	if (options.verification === "sha1") {
		return await withSha1WorkerPool(() => isMinecraftVersionDownloadedImpl(version, options));
	}
	return await isMinecraftVersionDownloadedImpl(version, options);
}

async function isMinecraftVersionDownloadedImpl(
	version: string,
	options: IsMinecraftVersionDownloadedOptions,
): Promise<boolean> {
	const resolvedVersion = ensureSafePathSegment(version, "version");
	const opfsRootDirectory = ensureSafePathSegment(
		options.opfsRootDirectory ?? DEFAULT_OPFS_ROOT_DIRECTORY,
		"OPFS root directory",
	);
	const minecraftOsName = normalizeMinecraftOsName(options.minecraftOsName);
	const verifyAssetObjects = options.verifyAssetObjects ?? true;
	const verification = options.verification ?? "exists";
	const verifyClientMappings = options.verifyClientMappings ?? true;
	const mojangVersionManifestUrl = options.mojangVersionManifestUrl ?? DEFAULT_MOJANG_VERSION_MANIFEST_URL;
	const maxConcurrentAssetChecks = ensurePositiveInteger(
		options.maxConcurrentAssetChecks ?? DEFAULT_MAX_CONCURRENT_ASSET_CHECKS,
		DEFAULT_MAX_CONCURRENT_ASSET_CHECKS,
	);

	const root = await navigator.storage.getDirectory();
	const versionDirectory = `${opfsRootDirectory}/versions/${resolvedVersion}`;
	const versionJsonPath = `${versionDirectory}/${VERSION_MANIFEST_FILENAME}`;
	const clientJarPath = `${versionDirectory}/${CLIENT_JAR_FILENAME}`;
	const versionJsonExists = await fileExists(root, versionJsonPath);
	const clientJarExists = await fileExists(root, clientJarPath);
	if (!versionJsonExists) {
		warnDownloadCheckFailure(`Missing version manifest at '${versionJsonPath}'.`);
	}
	if (!clientJarExists) {
		warnDownloadCheckFailure(`Missing client jar at '${clientJarPath}'.`);
	}
	if (!versionJsonExists || !clientJarExists) {
		return false;
	}

	let versionManifest: PrismMinecraftVersion;
	try {
		const manifestText = await readFileText(root, versionJsonPath);
		versionManifest = JSON.parse(manifestText) as PrismMinecraftVersion;
	} catch (error) {
		warnDownloadCheckFailure(`Failed to read version manifest at '${versionJsonPath}'.`, error);
		return false;
	}

	const assetIndexDownload = versionManifest.assetIndex;
	if (assetIndexDownload === undefined) {
		warnDownloadCheckFailure(`Version manifest for '${resolvedVersion}' is missing asset index metadata.`);
		return false;
	}

	const clientDownload = resolveClientDownload(versionManifest);
	if (clientDownload === undefined) {
		warnDownloadCheckFailure(`Version manifest for '${resolvedVersion}' is missing client download metadata.`);
		return false;
	}

	const libraries = collectLibraryDownloads(versionManifest.libraries, DEFAULT_LIBRARY_BASE_URL, minecraftOsName);
	for (const library of libraries) {
		const libraryPath = `${opfsRootDirectory}/libraries/${library.relativePath}`;
		try {
			await verifyOpfsFile(
				root,
				libraryPath,
				{ sha1: library.sha1, size: library.size },
				`library '${library.name}'`,
				verification,
			);
		} catch (error) {
			warnDownloadCheckFailure(`Library check failed for '${library.name}'.`, error);
			return false;
		}
	}

	try {
		if (verification !== "exists") {
			await verifyOpfsFile(
				root,
				clientJarPath,
				{ sha1: clientDownload.sha1, size: clientDownload.size },
				`client jar '${resolvedVersion}'`,
				verification,
			);
		}
	} catch (error) {
		warnDownloadCheckFailure(`Client jar check failed for '${resolvedVersion}'.`, error);
		return false;
	}

	if (verifyClientMappings) {
		const mappingsLookupVersion = versionManifest.inheritsFrom ?? resolvedVersion;
		let clientMappingsDownload: DownloadInfo | null = null;
		let clientMappingsLookupFailed = false;
		try {
			clientMappingsDownload = await resolveMojangClientMappingsDownload(mappingsLookupVersion, mojangVersionManifestUrl);
		} catch (error) {
			clientMappingsLookupFailed = true;
			warnDownloadCheckFailure(
				`Could not consult Mojang manifest to verify client mappings for '${mappingsLookupVersion}' — skipping mappings check.`,
				error,
			);
		}

		const clientMappingsPath = `${versionDirectory}/${CLIENT_MAPPINGS_FILENAME}`;
		if (clientMappingsDownload !== null) {
			try {
				await verifyOpfsFile(
					root,
					clientMappingsPath,
					{ sha1: clientMappingsDownload.sha1, size: clientMappingsDownload.size },
					`client mappings '${mappingsLookupVersion}'`,
					verification,
				);
			} catch (error) {
				warnDownloadCheckFailure(`Client mappings check failed for '${mappingsLookupVersion}'.`, error);
				return false;
			}
		} else if (!clientMappingsLookupFailed) {
			if (await fileExists(root, clientMappingsPath)) {
				warnDownloadCheckFailure(
					`Stale ${CLIENT_MAPPINGS_FILENAME} at '${clientMappingsPath}': Mojang manifest does not declare client mappings for '${mappingsLookupVersion}'.`,
				);
			}
		}
	}

	let assetIndexId: string;
	try {
		assetIndexId = ensureSafePathSegment(
			assetIndexDownload.id ?? versionManifest.assets ?? resolvedVersion,
			"asset index id",
		);
	} catch (error) {
		warnDownloadCheckFailure(`Invalid asset index id for '${resolvedVersion}'.`, error);
		return false;
	}

	const assetIndexPath = `${opfsRootDirectory}/assets/indexes/${assetIndexId}.json`;
	try {
		await verifyOpfsFile(
			root,
			assetIndexPath,
			{ sha1: assetIndexDownload.sha1, size: assetIndexDownload.size },
			`asset index '${assetIndexId}'`,
			verification,
		);
	} catch (error) {
		warnDownloadCheckFailure(`Asset index check failed for '${assetIndexId}'.`, error);
		return false;
	}

	if (!verifyAssetObjects) {
		return true;
	}

	let assetObjects: AssetObjectDownload[];
	try {
		const assetIndexText = await readFileText(root, assetIndexPath);
		const assetIndex = JSON.parse(assetIndexText) as AssetIndex;
		assetObjects = collectAssetObjects(assetIndex);
	} catch (error) {
		warnDownloadCheckFailure(`Failed to read asset index at '${assetIndexPath}'.`, error);
		return false;
	}

	let assetCheckError: Error | null = null;
	await runConcurrently(assetObjects, maxConcurrentAssetChecks, async (assetObject) => {
		if (assetCheckError !== null) {
			return;
		}

		const hashPrefix = assetObject.hash.slice(0, 2);
		const objectPath = `${opfsRootDirectory}/assets/objects/${hashPrefix}/${assetObject.hash}`;
		console_debug("[verify] path", objectPath);
		try {
			await verifyOpfsFile(
				root,
				objectPath,
				{ sha1: assetObject.hash, size: assetObject.size },
				`asset object '${assetObject.hash}'`,
				verification,
			);
		} catch (error) {
			assetCheckError = error instanceof Error ? error : new Error(String(error));
		}
	});

	if (assetCheckError !== null) {
		warnDownloadCheckFailure("Asset object check failed.", assetCheckError);
		return false;
	}

	return true;
}

async function copyFileInOpfs(
	root: FileSystemDirectoryHandle,
	sourcePath: string,
	destinationPath: string,
): Promise<void> {
	const sourceData = await readFileArrayBuffer(root, sourcePath);
	await writeFileToOpfs(root, destinationPath, sourceData);
}

async function fetchPrismPackageManifest<T>(
	prismMetaBaseUrl: string,
	packageId: string,
	version: string,
): Promise<T> {
	const url = new URL(
		`${encodeURIComponent(packageId)}/${encodeURIComponent(version)}.json`,
		prismMetaBaseUrl,
	).toString();
	return await fetchJson<T>(url);
}

async function resolveLatestPrismPackageVersion(prismMetaBaseUrl: string, packageId: string): Promise<string> {
	const indexUrl = new URL(`${encodeURIComponent(packageId)}/index.json`, prismMetaBaseUrl).toString();
	const index = await fetchJson<PrismVersionList>(indexUrl);
	const entry = index.versions[0];
	if (entry === undefined || entry.version === undefined) {
		throw new Error(`Prism meta package '${packageId}' has no versions.`);
	}
	return entry.version;
}

export async function downloadFabricMinecraftVersionToOpfs(
	mcVersion: string,
	options: DownloadFabricMinecraftVersionToOpfsOptions = {},
): Promise<DownloadFabricMinecraftVersionToOpfsResult> {
	const result = await withSha1WorkerPool(() => downloadFabricMinecraftVersionToOpfsImpl(mcVersion, options));
	new DownloadProgressReporter("complete", [], options.onProgress);
	return result;
}

async function downloadFabricMinecraftVersionToOpfsImpl(
	mcVersion: string,
	options: DownloadFabricMinecraftVersionToOpfsOptions,
): Promise<DownloadFabricMinecraftVersionToOpfsResult> {
	new DownloadProgressReporter("metadata", [], options.onProgress);
	const prismMetaBaseUrl = ensureTrailingSlash(options.prismMetaBaseUrl ?? DEFAULT_PRISM_META_BASE_URL);
	const libraryBaseUrl = ensureTrailingSlash(options.libraryBaseUrl ?? DEFAULT_LIBRARY_BASE_URL);
	const opfsRootDirectory = ensureSafePathSegment(
		options.opfsRootDirectory ?? DEFAULT_OPFS_ROOT_DIRECTORY,
		"OPFS root directory",
	);
	const minecraftOsName = normalizeMinecraftOsName(options.minecraftOsName);
	const maxConcurrentLibraryDownloads = ensurePositiveInteger(
		options.maxConcurrentLibraryDownloads ?? DEFAULT_MAX_CONCURRENT_LIBRARY_DOWNLOADS,
		DEFAULT_MAX_CONCURRENT_LIBRARY_DOWNLOADS,
	);
	const requestedMcVersion = ensureSafePathSegment(mcVersion, "minecraft version");
	const skipVanillaIfDownloaded = options.skipVanillaIfDownloaded ?? true;

	const shouldDownloadVanilla = !skipVanillaIfDownloaded
		|| !(await isMinecraftVersionDownloaded(requestedMcVersion, {
			opfsRootDirectory: options.opfsRootDirectory,
			minecraftOsName: options.minecraftOsName,
			mojangVersionManifestUrl: options.mojangVersionManifestUrl,
			verification: "size",
		}));
	const vanillaResult = shouldDownloadVanilla
		? await downloadMinecraftVersionToOpfsImpl(requestedMcVersion, options)
		: null;

	const root = await navigator.storage.getDirectory();
	const vanillaVersionDirectory = `${opfsRootDirectory}/versions/${requestedMcVersion}`;
	const vanillaVersionJsonPath = `${vanillaVersionDirectory}/${VERSION_MANIFEST_FILENAME}`;
	const vanillaClientJarPath = `${vanillaVersionDirectory}/${CLIENT_JAR_FILENAME}`;
	const vanillaClientMappingsPath = `${vanillaVersionDirectory}/${CLIENT_MAPPINGS_FILENAME}`;

	const vanillaManifestText = await readFileText(root, vanillaVersionJsonPath);
	const vanillaManifest = JSON.parse(vanillaManifestText) as PrismMinecraftVersion;

	const loaderVersion = ensureSafePathSegment(
		options.loaderVersion ?? await resolveLatestPrismPackageVersion(prismMetaBaseUrl, FABRIC_LOADER_PACKAGE),
		"fabric loader version",
	);
	const intermediaryVersion = ensureSafePathSegment(
		options.intermediaryVersion ?? requestedMcVersion,
		"fabric intermediary version",
	);

	new DownloadProgressReporter("metadata", [], options.onProgress);
	const [loaderManifest, intermediaryManifest] = await Promise.all([
		fetchPrismPackageManifest<PrismFabricManifest>(prismMetaBaseUrl, FABRIC_LOADER_PACKAGE, loaderVersion),
		fetchPrismPackageManifest<PrismFabricManifest>(prismMetaBaseUrl, FABRIC_INTERMEDIARY_PACKAGE, intermediaryVersion),
	]);

	if (loaderManifest.mainClass === undefined || loaderManifest.mainClass.trim().length === 0) {
		throw new Error(`Fabric loader '${loaderVersion}' manifest is missing 'mainClass'.`);
	}

	const fabricLibraryEntries: PrismMinecraftLibrary[] = [
		...(intermediaryManifest.libraries ?? []),
		...(loaderManifest.libraries ?? []),
	];
	const fabricLibraries = collectLibraryDownloads(fabricLibraryEntries, libraryBaseUrl, minecraftOsName);
	const fabricProgress = new DownloadProgressReporter("fabric", fabricLibraries, options.onProgress);
	await runConcurrently(fabricLibraries, maxConcurrentLibraryDownloads, async (library, index) => {
		const libraryPath = `${opfsRootDirectory}/libraries/${library.relativePath}`;
		const size = await ensureDownloadedFile(
			root,
			libraryPath,
			library.url,
			{ sha1: library.sha1, size: library.size },
			`fabric library '${library.name}'`,
			(bytes) => fabricProgress.update(index, bytes),
		);
		fabricProgress.complete(index, size);
	});

	const fabricVersionId = ensureSafePathSegment(
		options.fabricVersionId ?? `${requestedMcVersion}-fabric-${loaderVersion}`,
		"fabric version id",
	);
	const fabricVersionDirectory = `${opfsRootDirectory}/versions/${fabricVersionId}`;
	const fabricVersionJsonPath = `${fabricVersionDirectory}/${VERSION_MANIFEST_FILENAME}`;
	const fabricClientJarPath = `${fabricVersionDirectory}/${CLIENT_JAR_FILENAME}`;

	const mergedLibraries: PrismMinecraftLibrary[] = [
		...(vanillaManifest.libraries ?? []),
		...fabricLibraryEntries,
	];
	const mergedManifest: PrismMinecraftVersion = {
		...vanillaManifest,
		id: fabricVersionId,
		version: fabricVersionId,
		inheritsFrom: requestedMcVersion,
		mainClass: loaderManifest.mainClass,
		type: vanillaManifest.type ?? "release",
		libraries: mergedLibraries,
	};
	const mergedManifestText = JSON.stringify(mergedManifest, null, 2);
	await writeFileToOpfs(root, fabricVersionJsonPath, mergedManifestText);

	await copyFileInOpfs(root, vanillaClientJarPath, fabricClientJarPath);

	let fabricClientMappingsPath: string | null = null;
	if (await fileExists(root, vanillaClientMappingsPath)) {
		fabricClientMappingsPath = `${fabricVersionDirectory}/${CLIENT_MAPPINGS_FILENAME}`;
		await copyFileInOpfs(root, vanillaClientMappingsPath, fabricClientMappingsPath);
	}

	const assetIndexId = ensureSafePathSegment(
		vanillaManifest.assetIndex?.id ?? vanillaManifest.assets ?? requestedMcVersion,
		"asset index id",
	);
	const assetIndexPath = `${opfsRootDirectory}/assets/indexes/${assetIndexId}.json`;
	const assetIndexText = await readFileText(root, assetIndexPath);
	const parsedAssetIndex = JSON.parse(assetIndexText) as AssetIndex;
	const assetObjects = collectAssetObjects(parsedAssetIndex);

	const totalLibraryCount = (vanillaResult?.libraryCount ?? collectLibraryDownloads(vanillaManifest.libraries, libraryBaseUrl, minecraftOsName).length)
		+ fabricLibraries.length;

	return {
		version: fabricVersionId,
		inheritsFrom: requestedMcVersion,
		loaderVersion,
		intermediaryVersion,
		versionJsonPath: fabricVersionJsonPath,
		clientJarPath: fabricClientJarPath,
		clientMappingsPath: fabricClientMappingsPath,
		libraryCount: totalLibraryCount,
		librariesDirectoryPath: `${opfsRootDirectory}/libraries`,
		assetIndexId,
		assetIndexPath,
		assetObjectCount: assetObjects.length,
		assetObjectsDirectoryPath: `${opfsRootDirectory}/assets/objects`,
	};
}
