import { defineConfig, type Plugin } from "vite";
import basicSsl from "@vitejs/plugin-basic-ssl";
import { server as wisp, logging as wispLogging } from "@mercuryworkshop/wisp-js/server";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

wisp.options.allow_private_ips = true;
wisp.options.allow_loopback_ips = true;

// A Wisp server on the dev server itself, at wss://<this origin>/wisp/, so the game's TCP/TLS traffic (epoxy, see
// src/net.ts) no longer depends on an external proxy. It rides the HTTP server's `upgrade` event; vite's own HMR
// socket only claims upgrades carrying its protocol header, so the two coexist. This works because `server.proxy`
// below keeps vite on HTTP/1.1 over TLS -- HTTP/2, which vite uses for HTTPS without a proxy, has no `upgrade`.
// wisp-js defaults refuse private and loopback destinations, which matters because `host: true` exposes this
// server on every interface.
wispLogging.set_level(wispLogging.WARN);
function localWisp(): Plugin {
	const attach = (httpServer: { on(ev: "upgrade", fn: (req: IncomingMessage, socket: Duplex, head: Buffer) => void): unknown } | null) => {
		httpServer?.on("upgrade", (req, socket, head) => {
			if (req.url?.startsWith("/wisp/")) wisp.routeRequest(req, socket, head);
		});
	};
	return {
		name: "local-wisp",
		configureServer(server) {
			attach(server.httpServer);
		},
		configurePreviewServer(server) {
			attach(server.httpServer);
		},
	};
}

// host proxy prefix -> upstream origin. followRedirects is enabled on every
// route so 3xx responses are resolved against the upstream (e.g. fabricmc's
// intermediary stub 302s to .../0.0.0/...) instead of being handed to the
// browser, which would resolve the relative Location against the dev origin
// and fetch the SPA index.html back.
const PROXY_TARGETS: Record<string, string> = {
	"/proxy/meta": "https://meta.prismlauncher.org",
	"/proxy/piston-meta": "https://piston-meta.mojang.com",
	"/proxy/piston-data": "https://piston-data.mojang.com",
	"/proxy/launcher": "https://launcher.mojang.com",
	"/proxy/resources": "https://resources.download.minecraft.net",
	"/proxy/libraries": "https://libraries.minecraft.net",
	"/proxy/maven-central": "https://repo1.maven.org",
	"/proxy/maven-central-alt": "https://repo.maven.apache.org",
	"/proxy/maven-fabricmc": "https://maven.fabricmc.net",
};

const proxy = Object.fromEntries(
	Object.entries(PROXY_TARGETS).map(([prefix, target]) => [
		prefix,
		{
			target,
			changeOrigin: true,
			followRedirects: true,
			rewrite: (path: string) => path.slice(prefix.length),
		},
	]),
);

export default defineConfig({
	// Relative base so the build works from any path (user.github.io/<repo>/, a custom domain, or a subfolder).
	base: "./",
	plugins: [basicSsl(), localWisp()],
	build: {
		target: "es2022",
	},
	resolve: {
		alias: {
			// tar-stream pulls in node's "fs" (e.g. fs.constants); stub it for the browser.
			fs: "rollup-plugin-node-polyfills/polyfills/empty",
		},
	},
	server: {
		headers: {
			"Cross-Origin-Opener-Policy": "same-origin",
			"Cross-Origin-Embedder-Policy": "require-corp",
		},
		proxy,
		port: 5021,
		strictPort: true,
		host: true,
		allowedHosts: ["nyatop.internal.hgci.org", "100.64.0.10"]
	},
	preview: {
		port: 5021,
		strictPort: true,
	}
});
