import { init, EpoxyClient, WebSocketJsProvider, WispSocketProvider } from "@mercuryworkshop/epoxy-tls/full";
import wasm from "@mercuryworkshop/epoxy-tls/full/wasm?url";

export let client: EpoxyClient;

await init({ module_or_path: wasm });

// Per-packet tracing ("rx"/"tx" dumps of every TCP chunk) is expensive: on a multiplayer server the
// game exchanges hundreds of packets per second, and each of these used to be formatted, printed to
// the console, mirrored into the in-page log, and shipped over the bridge to the launcher tab --
// enough on its own to drag FPS into single digits. It is now opt-in: start the game (or the
// launcher) with ?netlog=1 to get it back for debugging.
const NETLOG = new URLSearchParams(location.search).has("netlog");
const netlog = (...args: any[]) => {
        if (NETLOG) console.log(...args);
};

// The Wisp server(s) epoxy tunnels TCP/TLS through. Under the vite dev server that is the server
// itself (the `local-wisp` plugin in vite.config.ts); a static production build has none and uses the
// public candidates below. Measured reality (2026-10): BOTH public servers have bad hours -- anura.pro
// saturates at peak time (first-launch asset downloads stalled 30s+ for real users), while
// mercurywork.shop throttles some networks hard. So production probes all candidates on startup and
// keeps the fastest responder for the whole session; if the default is down, the other one takes over
// automatically. Hosting your own (see wisp-server/README.md) beats both: list it as the first
// candidate / or force it per-visit with `?wisp=<url>`, which skips probing entirely.
const PROD_WISP_CANDIDATES = ["wss://wisp.mercurywork.shop/", "wss://anura.pro/"];
// A tiny, stable, CORS-enabled file (7 KB asset object) used to time each candidate.
const WISP_PROBE_URL = "https://resources.download.minecraft.net/79/7938494a1174a99d39cdcb0da28aaa06c562df0d";
const WISP_PROBE_TIMEOUT_MS = 8_000;
function wispUrl(): string {
        const override = new URLSearchParams(location.search).get("wisp");
        if (override) return override;
        if (import.meta.env.DEV) return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/wisp/`;
        return PROD_WISP_CANDIDATES[0];
}

// Downloads (assets/libraries/jars) are spread across several wisp connections. All streams on one
// WebSocket share a single TCP connection: one dropped WiFi packet there stalls EVERY in-flight
// download on it for up to the idle timeout (TCP head-of-line blocking) -- the classic "launcher sits
// silent for a minute" symptom. Three connections cut the blast radius of a stall to a third of the
// queue and triple the per-connection flow-control ceiling. Game TCP/TLS sockets (EpxTcpWs, auth)
// ride the primary `client`; on auto-selection the primary itself is rebuilt before any game traffic
// exists, so gameplay always ends up on the probed winner too.
const DOWNLOAD_CLIENT_COUNT = 3;
export let downloadClients: EpoxyClient[] = [];
let downloadClientIndex = 0;

export function nextDownloadClient(): EpoxyClient {
        const pool = downloadClients.length > 0 ? downloadClients : [client];
        downloadClientIndex = (downloadClientIndex + 1) % pool.length;
        return pool[downloadClientIndex];
}

function makeWispClient(url: string): EpoxyClient {
        return new EpoxyClient(new WispSocketProvider(new WebSocketJsProvider(), url));
}

function buildPool(url: string): EpoxyClient[] {
        return Array.from({ length: DOWNLOAD_CLIENT_COUNT }, () => makeWispClient(url));
}

// Times one candidate with a throwaway client. Returns null on any failure/timeout.
async function probeWisp(url: string): Promise<number | null> {
        try {
                const probe = makeWispClient(url);
                const result = await Promise.race([
                        probe.fetch(WISP_PROBE_URL).then(async (res) => {
                                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                                await res.arrayBuffer();
                                return true;
                        }),
                        new Promise<never>((_, reject) =>
                                setTimeout(() => reject(new Error("probe timeout")), WISP_PROBE_TIMEOUT_MS)),
                ]);
                void result;
                return performance.now();
        } catch {
                return null;
        }
}

async function selectWispServer(): Promise<void> {
        const started = performance.now();
        const times = await Promise.all(PROD_WISP_CANDIDATES.map(probeWisp));
        const winner = times.reduce<number>(
                (best, time, index) => (time !== null && (best === -1 || time < times[best]!) ? index : best),
                -1,
        );
        if (winner === -1) return; // every candidate failed; stay on the initial pool
        const chosen = PROD_WISP_CANDIDATES[winner];
        netlog("wisp probe", PROD_WISP_CANDIDATES.map(
                (url, index) => `${new URL(url).hostname}=${times[index] === null ? "fail" : `${(times[index]! - started).toFixed(0)}ms`}`,
        ));
        if (chosen === wispUrl()) return; // default already fastest; pool is already spread on it
        downloadClients = buildPool(chosen);
        client = downloadClients[0]!;
        (globalThis as any).client = client;
        console.info(`[net] wisp: auto-selected ${new URL(chosen).hostname} (probe: ${PROD_WISP_CANDIDATES.map((u, i) => `${new URL(u).hostname} ${times[i] === null ? "failed" : `${(times[i]! - started).toFixed(0)}ms`}`).join(", ")})`);
}

export function createClient() {
        const url = wispUrl();
        netlog("wisp server", url);
        client = makeWispClient(url);
        downloadClients = [client, ...buildPool(url).slice(1)];
        (globalThis as any).client = client;
        // Auto-select only for the production defaults (no explicit override, not the dev server).
        const overridden = new URLSearchParams(location.search).has("wisp");
        if (!import.meta.env.DEV && !overridden) void selectWispServer();
}

createClient();
(globalThis as any).createEpoxyClient = createClient;

interface Stream {
    read: ReadableStream<Uint8Array<ArrayBuffer>>;
    write: WritableStream<Uint8Array<ArrayBuffer>>;
}

// A wisp-tls stream starts with the certificate chain epoxy verified, for the Java side's SSLSession (EpoxySslSocket in
// loader/IkvmNetwork.cs): a big-endian u32 length, then the certificates' DER back to back, leaf first.
function certificateChainHeader(certs: Uint8Array[]): Uint8Array<ArrayBuffer> {
        const len = certs.reduce((n, cert) => n + cert.byteLength, 0);
        const out = new Uint8Array(4 + len);
        new DataView(out.buffer).setUint32(0, len);
        let at = 4;
        for (const cert of certs) {
                out.set(cert, at);
                at += cert.byteLength;
        }
        return out;
}

const WebSocketFields = {
        prototype: {
                send: WebSocket.prototype.send,
        },
        CLOSED: WebSocket.CLOSED,
        CLOSING: WebSocket.CLOSING,
        CONNECTING: WebSocket.CONNECTING,
        OPEN: WebSocket.OPEN,
};

// from celeste wasm
export class EpxTcpWs extends EventTarget {
        url: string;
        readyState: number = WebSocketFields.CONNECTING;

        ws?: WritableStreamDefaultWriter;
        reader?: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>>;

        binaryType: "blob" | "arraybuffer" = "blob";

        bufferedAmount: number = 0;

        onopen?: (evt: Event) => void;
        onclose?: (evt: Event) => void;
        onmessage?: (evt: Event) => void;
        onerror?: (evt: Event) => void;

        realOnClose: (code: number, reason: string) => void;
        realOnError: () => void;

        // close is raised from two places -- the read loop finishing, and close()/a failed write --
        // but .NET's ClientWebSocket must only ever see one CloseEvent.
        closeFired: boolean = false;
        closeRequested: boolean = false;

        constructor(remote: URL) {
                super();

                netlog("tcpws", remote);

                this.url = remote.toString();

                const onopen = () => {
                        this.readyState = WebSocketFields.OPEN;

                        const event = new Event("open");
                        this.dispatchEvent(event);

                        if (this.onopen) this.onopen(event);
                };

                const onmessage = async (payload: Uint8Array<ArrayBuffer>) => {
                        let data;
                        if (this.binaryType === "blob") data = new Blob([payload]);
                        else if (this.binaryType === "arraybuffer") data = payload.buffer;

                        const event = new MessageEvent("message", { data });
                        this.dispatchEvent(event);
                        if (this.onmessage) this.onmessage(event);
                };

                const onclose = (code: number, reason: string) => {
                        if (this.closeFired) return;
                        this.closeFired = true;

                        this.readyState = WebSocketFields.CLOSED;
                        const event = new CloseEvent("close", { code, reason });
                        this.dispatchEvent(event);
                        if (this.onclose) this.onclose(event);
                };
                this.realOnClose = onclose;

                const onerror = () => {
                        this.readyState = WebSocketFields.CLOSED;
                        const event = new Event("error");
                        this.dispatchEvent(event);
                        if (this.onerror) this.onerror(event);
                };
                this.realOnError = onerror;

                let type = remote.hostname.replace("wisp-", "");
                let [host, _port] = remote.pathname.slice(1).split(":");
                let port = +_port;

                (async () => {
                        let ws: Stream = null!;
                        let header: Uint8Array<ArrayBuffer> | null = null;
                        try {
                                if (type === "tcp") {
                                        ws = await client.connect(host, port) as Stream;
                                } else if (type === "tls") {
                                        const tls = await client.connectTls(host, port);
                                        header = certificateChainHeader(tls.peerCertificates);
                                        ws = tls as Stream;
                                } else {
                                        throw new Error("invalid ty " + type);
                                }
                        } catch (err) {
                                console.error(err);
                                onerror();
                                return;
                        }

                        const writer = ws.write.getWriter();
                        const reader = ws.read.getReader();
                        this.ws = writer;
                        this.reader = reader;

                        if (this.closeRequested) {
                                // close() ran while the connect was still in flight. It has already fired the close
                                // event, so just drop the stream now that there is one to drop.
                                reader.cancel().then(undefined, (err) => console.log("cancel failed", err));
                                writer.close().then(undefined, (err) => console.log("close failed", err));
                                return;
                        }

                        this.readyState = WebSocketFields.OPEN;
                        onopen();
                        if (header) onmessage(header);
                        let errored = false;
                        while (true) {
                                try {
                                        const { value, done } = await reader.read();
                                        if (done || !value) break;

                                        netlog("rx", value);
                                        onmessage(value);
                                } catch (err) {
                                        onerror();
                                        console.error(err);
                                        errored = true;
                                        break;
                                }
                        }
                        this.readyState = WebSocketFields.CLOSED;
                        onclose(errored ? 1011 : 1000, errored ? "epoxy.ts errored" : "normal");
                })();
        }

        send(...args: any[]) {
                if (this.readyState === WebSocketFields.CONNECTING || !this.ws) {
                        throw new DOMException(
                                "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state."
                        );
                }

                let data = args[0];
                if (data.buffer)
                        data = data.buffer.slice(
                                data.byteOffset,
                                data.byteOffset + data.byteLength
                        );

                if (!(data instanceof Uint8Array))
                        data = new Uint8Array(data);

                this.bufferedAmount++;
                netlog("tx", data);
                this.ws.write(data).then(
                        () => {
                                this.bufferedAmount--;
                        },
                        (err) => {
                                this.bufferedAmount--;
                                console.error("tcpws write failed", err);
                                this.realOnError();
                                this.realOnClose(1011, "epoxy.ts write errored");
                        }
                );
        }

        close(_: number, __: string) {
                if (
                        this.readyState === WebSocketFields.CLOSING ||
                        this.readyState === WebSocketFields.CLOSED
                )
                        return;

                this.readyState = WebSocketFields.CLOSING;
                this.closeRequested = true;

                this.reader?.cancel().then(undefined, (err) => console.log("cancel failed", err));
                this.ws?.close().then(
                        (x) => console.log("really closed", x),
                        (err) => console.log("close failed", err)
                );

                this.readyState = WebSocketFields.CLOSED;
                this.realOnClose(1000, "normal");
        }
}
