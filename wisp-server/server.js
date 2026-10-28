// Standalone Wisp server for Amphibian Launcher.
//
// Same package the dev server uses (@mercuryworkshop/wisp-js, see frontend/vite.config.ts) but
// running on its own HTTP server, so the deployed launcher can tunnel game traffic through YOUR
// instance instead of the shared community proxy. Point the site at it either per-visit with
// `?wisp=wss://<host>/` or permanently by editing PROD_WISP_URL in frontend/src/net.ts.
//
// Run:  npm install && npm start   (listens on $PORT or 8080)
// Test: curl http://localhost:8080/health  ->  ok

import http from "node:http";
import { server as wisp, logging as wispLogging } from "@mercuryworkshop/wisp-js/server";

wispLogging.set_level(wispLogging.WARN);

// Defaults already refuse private/loopback destinations; set them explicitly so a config change
// upstream can never silently turn this into an open SSRF relay into the host network.
wisp.options.allow_private_ips = false;
wisp.options.allow_loopback_ips = false;

const httpServer = http.createServer((req, res) => {
        if (req.url === "/health") {
                res.writeHead(200, { "content-type": "text/plain" });
                res.end("ok");
                return;
        }
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("amphibian wisp server\n");
});

// The wisp protocol rides WebSocket upgrades; route every upgrade to it (it validates the
// subprotocol and path itself).
httpServer.on("upgrade", (req, socket, head) => {
        wisp.routeRequest(req, socket, head);
});

const PORT = Number(process.env.PORT) || 8080;
httpServer.listen(PORT, () => {
        console.log(`[wisp] listening on 0.0.0.0:${PORT}`);
});
