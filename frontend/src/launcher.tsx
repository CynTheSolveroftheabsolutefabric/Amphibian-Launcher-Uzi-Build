// Modded-Web launcher — Norshare-style UI.
//
// Single navigation column: a dark left sidebar with the launcher logo and icon
// links (Play / Installations / Documentation / File Manager / Account /
// Console) — the old header tabs are gone, the sidebar is the only navigation.
// A persistent bottom selection bar holds the saved-installation dropdown on
// the left (it starts empty and fills up as installations are saved in the
// Installations view), the big green PLAY button in the middle and the account
// name on the right. A Documentation view holds the readme-style explanations
// that used to be scattered across the other tabs.
//
// Fabric only — the vanilla option and its download path are gone.

import { css, FC, Stateful, type ComponentChild } from "dreamland/core";
import type { MinecraftAuthInfo } from "./dotnet";
import { loglisteners, type Log } from "./dotnet/log";
import { bridgeName, type GameStats, type ToGame, type ToLauncher } from "./bridge";
import {
        downloadFabricMinecraftVersionToOpfs,
        isMinecraftVersionDownloaded,
        type MinecraftDownloadProgress,
} from "./minecraft";
import { OpfsExplorer } from "./fs";
import { Icon } from "./ui/Button";
import { createStore } from "dreamland/util";
import {
        getProfile,
        minecraftAuth,
        refreshToken,
        startDeviceCodeAuth,
        Token,
} from "./auth";

import iconPlayArrow from "@ktibow/iconset-material-symbols/play-arrow";
import iconList from "@ktibow/iconset-material-symbols/list";
import iconDescription from "@ktibow/iconset-material-symbols/description";
import iconFolder from "@ktibow/iconset-material-symbols/folder";
import iconPerson from "@ktibow/iconset-material-symbols/person";
import iconTerminal from "@ktibow/iconset-material-symbols/terminal";
import iconChevronUp from "@ktibow/iconset-material-symbols/keyboard-arrow-up";
import iconDelete from "@ktibow/iconset-material-symbols/delete";
import iconSave from "@ktibow/iconset-material-symbols/save";

// Play-tab wallpapers, crossfaded by pure CSS (see @keyframes wallpaper-cycle) — no timers, no
// framework state, nothing to clean up. Sorted by filename: 1.webp shows first, then the next
// one every 15s. The CSS loop length must stay imageCount * 15s (currently 7 * 15 = 105s).
const WALLPAPER_URLS: string[] = Object.entries(
        import.meta.glob<string>("./assets/wallpapers/*.webp", {
                eager: true,
                query: "?url",
                import: "default",
        })
)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, url]) => url);

// crypto.randomUUID only exists in secure contexts (https / localhost). A launcher served over plain http
// (e.g. a LAN host) crashed with a TypeError the moment PLAY was pressed; fall back to a random hex id.
const randomId = (): string => {
        if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

let authStore: Stateful<{
        token: Token | undefined;
}> = createStore(
        {
                token: undefined,
        },
        // Live/SISU tokens belong to a different client ID than the old Entra flow.
        { ident: "amphibian-auth-1", autosave: "auto", backing: "localstorage" }
);

// Offline ("cracked") account settings. Kept separate from the Microsoft token store so logging out of Microsoft
// never wipes the chosen username.
let offlineStore: Stateful<{
        enabled: boolean;
        name: string;
}> = createStore(
        {
                enabled: false,
                name: "Player",
        },
        { ident: "amphibian-offline-1", autosave: "auto", backing: "localstorage" }
);

// Launch preferences, kept in the browser so they survive a reload. (Fabric is the only loader now.)
let settingsStore: Stateful<{
        fullscreen: boolean;
}> = createStore(
        {
                fullscreen: true,
        },
        { ident: "amphibian-settings-1", autosave: "auto", backing: "localstorage" }
);

// Saved installations. The bottom-bar dropdown is built ONLY from these — it
// starts empty ("No Installations") and PLAY stays disabled until one is saved
// in the Installations view and selected.
export type SavedInstall = {
        version: string;
        fabric: string;
        fullscreen: boolean;
};
let installsStore: Stateful<{
        list: SavedInstall[];
        selected: number | null;
}> = createStore(
        {
                list: [],
                selected: null,
        },
        { ident: "amphibian-installs-1", autosave: "auto", backing: "localstorage" }
);

// Norshare-style toast (top right corner). One shared slot; the newest message wins.
let toastStore: Stateful<{
        text: string;
        red: boolean;
        shown: boolean;
}> = createStore(
        { text: "", red: false, shown: false },
        { ident: "amphibian-toast-1", backing: "localstorage", autosave: "manual" }
);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const toast = (text: string, red = false) => {
        toastStore.text = text;
        toastStore.red = red;
        toastStore.shown = true;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => (toastStore.shown = false), 3200);
};

type ViewId = "play" | "installations" | "docs" | "files" | "account" | "console";

// Minecraft's own username rule: 3-16 characters of A-Z, a-z, 0-9 and underscore.
const OFFLINE_NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

type AuthState =
        | { type: "loading" }
        | { type: "ready" }
        | { type: "authing"; url: string; qr: string }
        | {
                        type: "done";
                        name: string;
                        uuid: string;
                        token: string;
          }
        | { type: "error"; error: any };

type Session = "idle" | "preparing" | "running";

const phaseLabels: Record<MinecraftDownloadProgress["phase"], string> = {
        metadata: "Fetching metadata",
        libraries: "Downloading libraries",
        client: "Downloading client",
        mappings: "Downloading mappings",
        assets: "Downloading assets",
        fabric: "Downloading Fabric",
        complete: "Preparing game",
};

const progressFraction = (
        progress: MinecraftDownloadProgress | null
): number | undefined => {
        if (!progress || progress.totalFiles === 0) return undefined;
        if (progress.completedFiles === progress.totalFiles) return 1;
        return progress.totalBytes !== null && progress.totalBytes > 0
                ? Math.min(0.99, progress.downloadedBytes / progress.totalBytes)
                : progress.completedFiles / progress.totalFiles;
};
const progressText = (progress: MinecraftDownloadProgress | null): string => {
        if (!progress || progress.totalFiles === 0) return "";
        const files = `${progress.completedFiles.toLocaleString()} / ${progress.totalFiles.toLocaleString()} files`;
        const percent = Math.floor((progressFraction(progress) ?? 0) * 100);
        const bytes =
                progress.totalBytes !== null && progress.totalBytes > 0
                        ? ` · ${(progress.downloadedBytes / 1048576).toFixed(1)} / ${(progress.totalBytes / 1048576).toFixed(1)} MiB`
                        : "";
        return `${percent}% · ${files}${bytes}`;
};

// Version suggestions for the Installations form, newest first. Everything from 1.13 up to 26.2
// works. The bottom-bar dropdown is built from saved installations instead of this list.
const VERSIONS: { label: string; id: string }[] = [
        { label: "Latest release", id: "26.2" },
        { label: "1.21.4", id: "1.21.4" },
        { label: "1.21.1", id: "1.21.1" },
        { label: "1.20.4", id: "1.20.4" },
        { label: "1.20.1", id: "1.20.1" },
        { label: "1.19.4", id: "1.19.4" },
        { label: "1.18.2", id: "1.18.2" },
        { label: "1.17.1", id: "1.17.1" },
        { label: "1.16.5", id: "1.16.5" },
        { label: "1.15.2", id: "1.15.2" },
        { label: "1.14.4", id: "1.14.4" },
        { label: "1.13.2", id: "1.13.2" },
];
const VERSION_SUGGESTIONS = VERSIONS.map((v) => v.id);

function LogView(this: FC<{ scrolling: boolean }>) {
        // Long sessions produce a lot of output (the runtime logs GC activity), so only the newest lines are kept.
        const MAX_LINES = 4000;

        const create = (color: string, log: string) => {
                const el = document.createElement("div");
                el.classList.add("log");
                el.textContent = log;
                if (color) el.style.color = color;
                el.style.whiteSpace = "pre-wrap";
                el.style.overflowWrap = "anywhere";
                return el;
        };

        this.cx.mount = () => {
                const logroot = this.root as HTMLElement;
                const frag = document.createDocumentFragment();
                // Follow the newest line unless the person scrolled up to read something.
                let stick = true;
                logroot.addEventListener("scroll", () => {
                        stick = logroot.scrollHeight - logroot.scrollTop - logroot.clientHeight < 40;
                });

                // While the Console tab is hidden, lines are held as plain data (capped, newest kept) instead of
                // being turned into DOM nodes nobody sees. A multiplayer session can emit hundreds of lines per
                // second; building elements for all of them while the tab is hidden burns CPU that the game tab
                // wants for itself.
                let backlog: Log[] = [];
                const visible = () => logroot.offsetParent !== null;

                loglisteners.push((x) => {
                        if (!visible()) {
                                if (backlog.length >= MAX_LINES) backlog.shift();
                                backlog.push(x);
                                return;
                        }
                        frag.append(create(x.color, x.log));
                });

                setInterval(() => {
                        if (!visible()) return;
                        if (backlog.length) {
                                for (const x of backlog) frag.append(create(x.color, x.log));
                                backlog = [];
                        }
                        while (frag.childElementCount > MAX_LINES) frag.firstElementChild!.remove();
                        if (frag.childElementCount === 0) return;
                        logroot.appendChild(frag);
                        while (logroot.childElementCount > MAX_LINES)
                                logroot.firstElementChild!.remove();
                        if (stick) logroot.scrollTop = logroot.scrollHeight;
                }, 50);
        };

        return (
                <div
                        class="component-log"
                        style={this.scrolling ? "overflow: auto" : "overflow: hidden"}
                />
        );
}
LogView.style = css`
        :scope {
                min-height: 0;
                flex: 1;
                font-family: var(--font-mono);
                font-size: 0.76rem;
                line-height: 1.5;
                padding: 0.8rem 1rem;
                background: var(--bg-sub);
                border: 1px solid var(--line-soft);
                border-radius: 6px;
                color: var(--fg-dim);
        }
`;

function Launcher(
        this: FC<
                {},
                {
                        authState: AuthState;
                        offline: boolean;
                        offlineName: string;
                        view: ViewId;
                        fullscreen: boolean;
                        version: string;
                        fabric: string;
                        session: Session;
                        sessionText: string;
                        sessionError: string;
                        progress: MinecraftDownloadProgress | null;
                        stats: GameStats | null;
                        dropOpen: boolean;
                }
        >
) {
        // The Installations form starts from the selected saved installation, if there is one.
        const saved =
                installsStore.selected != null ? installsStore.list[installsStore.selected] : undefined;

        let fab = saved?.fabric ?? "0.19.5";

        this.dropOpen = false;
        this.view = "play" as ViewId;
        this.authState = { type: "loading" } as AuthState;
        this.offline = offlineStore.enabled;
        this.offlineName = offlineStore.name;
        this.fullscreen = saved ? saved.fullscreen : settingsStore.fullscreen;
        this.version = saved?.version ?? "";
        this.fabric = fab;
        this.session = "idle" as Session;
        this.sessionText = "";
        this.sessionError = "";
        this.progress = null;
        this.stats = null as GameStats | null;

        let setFullscreen = (fullscreen: boolean) => {
                this.fullscreen = fullscreen;
                settingsStore.fullscreen = fullscreen;
        };

        let setOffline = (enabled: boolean) => {
                this.offline = enabled;
                offlineStore.enabled = enabled;
        };

        // Select a saved installation: it becomes the dropdown/PLAY target and the
        // Installations form shows its values.
        let selectInstall = (index: number) => {
                installsStore.selected = index;
                const it = installsStore.list[index];
                if (it) {
                        this.version = it.version;
                        this.fabric = it.fabric;
                        setFullscreen(it.fullscreen);
                }
        };

        // SAVE INSTALLATION: upsert by Minecraft version, then select it so it shows up
        // in the bottom-bar dropdown immediately.
        let saveInstall = () => {
                const version = this.version.trim();
                if (!version) {
                        toast("Pick a Minecraft version first!", true);
                        return;
                }
                const entry: SavedInstall = {
                        version,
                        fabric: this.fabric.trim() || "0.19.5",
                        fullscreen: this.fullscreen,
                };
                const existing = installsStore.list.findIndex((x) => x.version === version);
                if (existing >= 0) {
                        installsStore.list = installsStore.list.map((x, i) => (i === existing ? entry : x));
                        selectInstall(existing);
                } else {
                        installsStore.list = [...installsStore.list, entry];
                        selectInstall(installsStore.list.length - 1);
                }
                toast("Saved installation " + version);
        };

        let deleteInstall = (index: number) => {
                const list = installsStore.list.filter((_, i) => i !== index);
                let selected = installsStore.selected;
                if (selected === index) selected = null;
                else if (selected != null && selected > index) selected -= 1;
                if (selected != null && selected >= list.length) selected = list.length - 1;
                if (selected != null && selected < 0) selected = null;
                installsStore.list = list;
                installsStore.selected = selected;
                toast("Installation removed");
        };

        // The Play button stays off until there is a saved installation, an account, and no game already running.
        let playDisabled = use(
                this.authState,
                this.offline,
                this.offlineName,
                this.session,
                installsStore.selected
        ).map(
                ([x, offline, name, session, selected]) =>
                        session !== "idle" ||
                        selected == null ||
                        !(
                                import.meta.env.DEV ||
                                (offline ? OFFLINE_NAME_RE.test(name.trim()) : x.type === "done")
                        )
        );

        // What the bottom bar and the account view show.
        let accountName = use(this.authState, this.offline, this.offlineName).map(
                ([x, offline, name]) =>
                        offline ? name.trim() || "Player" : x.type === "done" ? x.name : "Not signed in"
        );
        let playHint = use(
                this.authState,
                this.offline,
                this.offlineName,
                this.session,
                installsStore.selected
        ).map(
                ([x, offline, name, session, selected]) => {
                        if (session === "preparing") return "Getting the game ready...";
                        if (session === "running") return "Running in its own tab";
                        if (selected == null) return "Create an installation first";
                        if (offline)
                                return OFFLINE_NAME_RE.test(name.trim())
                                        ? ""
                                        : "Username must be 3-16 letters, numbers or _";
                        if (x.type === "loading") return "Checking your account...";
                        if (x.type === "authing") return "Finish signing in first";
                        if (x.type === "error") return "Sign-in failed, open the Account tab";
                        return x.type === "done" ? "" : "Sign in, or use an offline account";
                }
        );

        let populateToken = async (token: Token) => {
                try {
                        let mc = await minecraftAuth(token.access);
                        let info = await getProfile(mc);

                        this.authState = {
                                type: "done",
                                name: info.name,
                                uuid: info.id,
                                token: mc,
                        };
                } catch (err) {
                        this.authState = { type: "error", error: err };
                }
        };

        this.cx.mount = async () => {
                // Clicking anywhere outside the dropdown closes it.
                document.addEventListener("click", (e) => {
                        const target = e.target as Element | null;
                        if (!target?.closest?.(".dropdown-zone")) this.dropOpen = false;
                });

                let token: Token | undefined;
                if (!(token = authStore.token)) {
                        this.authState = { type: "ready" };
                        return;
                }

                if (token.expires < Date.now()) {
                        try {
                                authStore.token = token = await refreshToken(token.refresh);
                        } catch (e) {
                                this.authState = { type: "error", error: e };
                                return;
                        }
                }

                await populateToken(token);
        };

        let auth = async () => {
                try {
                        let deviceCodeAuth = await startDeviceCodeAuth();
                        this.authState = {
                                type: "authing",
                                url: deviceCodeAuth.link_url,
                                qr: deviceCodeAuth.qr_svg_uri,
                        };

                        let token = await deviceCodeAuth.token;
                        authStore.token = token;
                        await populateToken(token);
                } catch (err) {
                        this.authState = { type: "error", error: err };
                }
        };
        let deauth = async () => {
                authStore.token = undefined;
                this.authState = { type: "ready" };
        };

        let authInfo = (): MinecraftAuthInfo => {
                if (this.offline) {
                        const name = this.offlineName.trim();
                        if (!OFFLINE_NAME_RE.test(name))
                                throw new Error("offline username must be 3-16 letters, numbers or _");
                        offlineStore.name = name;
                        // Empty uuid makes the loader derive the standard offline UUID (md5 of "OfflinePlayer:<name>"),
                        // the same one vanilla offline-mode servers assign.
                        return {
                                playerName: name,
                                uuid: "",
                                accessToken: "0",
                                userType: "legacy",
                        };
                }
                if (this.authState.type === "done") {
                        return {
                                playerName: this.authState.name,
                                uuid: this.authState.uuid,
                                accessToken: this.authState.token,
                                userType: "msa",
                        };
                }
                if (import.meta.env.DEV) {
                        return {
                                playerName: "Player",
                                uuid: "",
                                accessToken: "0",
                                userType: "legacy",
                        };
                }
                throw new Error("no auth");
        };

        // ---- game session ----------------------------------------------------------------------------------------------
        // The game runs in a new tab of its own (this same site, with ?game=<id>), because the wasm runtime can only start
        // once per page. That tab reports to this page over a BroadcastChannel: logs and stats come back here, and the
        // launch config and commands go there.
        let popup: Window | null = null;
        let channel: BroadcastChannel | null = null;
        let watchdog: ReturnType<typeof setInterval> | undefined;
        const sess = { cancelled: false, prepDone: false };
        let lastStatusSent = 0;

        const tellGame = (message: ToGame) => channel?.postMessage(message);
        const setStatus = (text: string, force = false) => {
                this.sessionText = text;
                const now = Date.now();
                if (force || now - lastStatusSent > 300) {
                        lastStatusSent = now;
                        tellGame({ type: "status", text });
                }
        };
        const closePopup = () => {
                try {
                        popup?.close();
                } catch {
                        /* already gone */
                }
        };
        const endSession = () => {
                clearInterval(watchdog);
                channel?.close();
                channel = null;
                popup = null;
                this.session = "idle";
                this.sessionText = "";
                this.progress = null;
                this.stats = null;
        };
        // The game tab went away (closed by the person, by Stop game, or by the game itself).
        const onTabClosed = () => {
                if (this.session === "preparing" && !sess.prepDone) {
                        // A download cannot be aborted; let it finish (the files are kept for next time) and then go idle.
                        sess.cancelled = true;
                        clearInterval(watchdog);
                        this.sessionText = "Game tab closed. Finishing the download in the background...";
                        return;
                }
                console.info("[launcher] game tab closed");
                endSession();
        };
        const handleGameMessage = (message: ToLauncher, config: ToGame | null) => {
                switch (message.type) {
                        case "hello":
                                if (config) channel?.postMessage(config);
                                else tellGame({ type: "status", text: this.sessionText });
                                break;
                        case "logs":
                                // Show the game's output in the launcher console exactly like the launcher's own.
                                for (const line of message.lines)
                                        for (const listener of loglisteners) listener(line);
                                break;
                        case "stats":
                                this.stats = message.stats;
                                break;
                        case "running":
                                this.session = "running";
                                this.sessionText = "Game running";
                                break;
                        case "exit":
                                console.info("[launcher] game exited", message.code);
                                if (message.code)
                                        this.sessionError = `The game stopped with exit code ${message.code}. The console shows the reason.`;
                                closePopup();
                                endSession();
                                break;
                        case "failed":
                                // The game tab closes itself right after this.
                                this.sessionError = message.message;
                                break;
                }
        };

        const launch = async () => {
                if (this.session !== "idle") return;
                this.sessionError = "";
                this.view = "console";

                let info: MinecraftAuthInfo;
                try {
                        info = authInfo();
                } catch (e) {
                        this.sessionError = e instanceof Error ? e.message : String(e);
                        return;
                }
                const inst =
                        installsStore.selected != null
                                ? installsStore.list[installsStore.selected]
                                : undefined;
                if (!inst) {
                        this.sessionError =
                                "No installation selected. Pick a version in Installations and save it first.";
                        return;
                }
                const version = inst.version;
                const fabric = inst.fabric;
                const versionId = `${version}-fabric-${fabric}`;

                // This has to happen right here in the click, before any await, or the browser blocks the new tab.
                const id = randomId();
                const gameUrl = new URL(location.href);
                gameUrl.hash = "";
                gameUrl.searchParams.set("game", id);
                const win = window.open(gameUrl.href, "_blank");
                if (!win) {
                        this.sessionError =
                                "Your browser blocked the game tab. Allow pop-ups for this site, then press PLAY again.";
                        return;
                }

                popup = win;
                sess.cancelled = false;
                sess.prepDone = false;
                this.session = "preparing";
                this.progress = null;
                this.stats = null;
                let config: ToGame | null = null;
                const ch = new BroadcastChannel(bridgeName(id));
                channel = ch;
                ch.onmessage = (event: MessageEvent<ToLauncher>) =>
                        handleGameMessage(event.data, config);
                clearInterval(watchdog);
                watchdog = setInterval(() => {
                        if (popup && popup.closed) onTabClosed();
                }, 1000);
                setStatus("Verifying assets", true);

                // Download the game here, so the progress shows in the launcher and the game tab stays clean.
                try {
                        if (new URLSearchParams(location.search).has("bench"))
                                console.debug("?bench: skipping the Minecraft download check");
                        else if (!(await isMinecraftVersionDownloaded(versionId, { verification: "size" }))) {
                                const onProgress = (progress: MinecraftDownloadProgress) => {
                                        this.progress = progress;
                                        setStatus(
                                                `${phaseLabels[progress.phase]} ${Math.floor((progressFraction(progress) ?? 0) * 100)}%`
                                        );
                                };
                                await downloadFabricMinecraftVersionToOpfs(version, {
                                        loaderVersion: fabric,
                                        onProgress,
                                });
                        }
                } catch (error) {
                        console.error("Minecraft launch failed", error);
                        this.sessionError = error instanceof Error ? error.message : String(error);
                        closePopup();
                        endSession();
                        return;
                }

                sess.prepDone = true;
                this.progress = null;
                if (sess.cancelled) {
                        endSession();
                        return;
                }
                config = { type: "config", versionId, auth: info, fullscreen: inst.fullscreen };
                setStatus("Starting Minecraft", true);
                ch.postMessage(config);
        };

        const stopGame = () => {
                if (this.session === "idle") return;
                if (
                        !confirm(
                                "Stop the game? Unsaved progress will be lost. Use Save and Quit in game to keep it."
                        )
                )
                        return;
                closePopup();
                onTabClosed();
        };

        const sendCommand = (command: "threadDump" | "jitDump") =>
                tellGame({ type: "command", command });

        const navItem = (id: ViewId, label: ComponentChild, icon: typeof iconPlayArrow) => (
                <button
                        class="sidebar-option"
                        class:selected={use(this.view).map((v) => v === id)}
                        on:click={() => {
                                this.view = id;
                                this.dropOpen = false;
                        }}
                >
                        <span class="nav-icon">
                                <Icon icon={icon} />
                        </span>
                        <span class="nav-label">{label}</span>
                </button>
        );

        // The installation the bottom-bar dropdown and PLAY target.
        const selectedInstall = use(installsStore.list, installsStore.selected).map(
                ([list, sel]) => (sel != null ? (list[sel] ?? null) : null)
        );

        return (
                <div class="shell">
                        <aside class="sidebar">
                                <div class="brand">
                                        <img class="brand-logo" src="./logo.png" alt="Amphibian Launcher" />
                                </div>
                                <nav class="side-nav">
                                        {navItem("play", <span>MINECRAFT :<br />Play</span>, iconPlayArrow)}
                                        {navItem("installations", <span>MINECRAFT :<br />Installations</span>, iconList)}
                                        {navItem("docs", <span>DOCUMENTATION</span>, iconDescription)}
                                        {navItem("files", <span>MINECRAFT :<br />File Manager</span>, iconFolder)}
                                        {navItem("account", <span>ACCOUNT :<br />Sign in</span>, iconPerson)}
                                        {navItem("console", <span>MINECRAFT :<br />Console</span>, iconTerminal)}
                                </nav>
                                <div class="spacer" />
                                <div class="launcher-version">V1.0.0</div>
                        </aside>

                        <div class="main">
                                <div class="views">
                                        {/* ===== PLAY ===== */}
                                        <section class="view play-view" class:hidden={use(this.view).map((v) => v !== "play")}>
                                                <div class="game-bg">
                                                        {WALLPAPER_URLS.map((url, i) => (
                                                                <img class="hero-img" style={`--wp-i: ${i}`} src={url} alt="" />
                                                        ))}
                                                        <div class="game-title">
                                                                <img class="hero-logo" src="./logo.png" alt="Amphibian Launcher" />
                                                        </div>
                                                </div>
                                        </section>

                                        {/* ===== INSTALLATIONS ===== */}
                                        <section class="view panel-view" class:hidden={use(this.view).map((v) => v !== "installations")}>
                                                <h2 class="view-title">Installations</h2>
                                                <div class="panel">
                                                        <div class="irow">
                                                                <span class="irow-label">MINECRAFT VERSION</span>
                                                                <div class="irow-body">
                                                                        <input
                                                                                class="input"
                                                                                list="mc-versions"
                                                                                value={use(this.version)}
                                                                                placeholder="26.2"
                                                                        />
                                                                        <datalist id="mc-versions">
                                                                                {VERSION_SUGGESTIONS.map((v) => (
                                                                                        <option value={v} />
                                                                                ))}
                                                                        </datalist>
                                                                </div>
                                                        </div>
                                                        <div class="irow">
                                                                <span class="irow-label">FABRIC LOADER</span>
                                                                <div class="irow-body">
                                                                        <input class="input" value={use(this.fabric)} placeholder={fab} />
                                                                </div>
                                                        </div>
                                                        <div class="irow">
                                                                <span class="irow-label">FULLSCREEN</span>
                                                                <div class="irow-body">
                                                                        <div class="segmented">
                                                                                <button
                                                                                        class="seg"
                                                                                        class:active={use(this.fullscreen)}
                                                                                        on:click={() => setFullscreen(true)}
                                                                                >
                                                                                        ON
                                                                                </button>
                                                                                <button
                                                                                        class="seg"
                                                                                        class:active={use(this.fullscreen).map((f) => !f)}
                                                                                        on:click={() => setFullscreen(false)}
                                                                                >
                                                                                        OFF
                                                                                </button>
                                                                        </div>
                                                                </div>
                                                        </div>
                                                        <div class="irow">
                                                                <span class="irow-label">SAVE</span>
                                                                <div class="irow-body">
                                                                        <button class="btn green" on:click={saveInstall}>
                                                                                <Icon icon={iconSave} /> SAVE INSTALLATION
                                                                        </button>
                                                                </div>
                                                        </div>
                                                        <div class="irow">
                                                                <span class="irow-label">SAVED</span>
                                                                <div class="irow-body">
                                                                        <div class="inst-list">
                                                                                {use(installsStore.list, installsStore.selected).map(
                                                                                        ([list, sel]) =>
                                                                                                list.length === 0 ? (
                                                                                                        <div class="inst-empty">Nothing saved yet.</div>
                                                                                                ) : (
                                                                                                        list.map((it, i) => (
                                                                                                                <div
                                                                                                                        class="inst-row"
                                                                                                                        class:selected={sel === i}
                                                                                                                        on:click={() => selectInstall(i)}
                                                                                                                >
                                                                                                                        <div class="block-icon">
                                                                                                                                <div class="dirt" />
                                                                                                                                <div class="grass" />
                                                                                                                        </div>
                                                                                                                        <div class="inst-info">
                                                                                                                                <div class="inst-name">{it.version}</div>
                                                                                                                                <div class="inst-meta">
                                                                                                                                        Fabric {it.fabric}
                                                                                                                                        {it.fullscreen ? " · fullscreen" : ""}
                                                                                                                                </div>
                                                                                                                        </div>
                                                                                                                        <button
                                                                                                                                class="inst-del"
                                                                                                                                title="Delete installation"
                                                                                                                                on:click={(e: Event) => {
                                                                                                                                        e.stopPropagation();
                                                                                                                                        deleteInstall(i);
                                                                                                                                }}
                                                                                                                        >
                                                                                                                                <Icon icon={iconDelete} />
                                                                                                                        </button>
                                                                                                                </div>
                                                                                                        ))
                                                                                                )
                                                                                )}
                                                                        </div>
                                                                </div>
                                                        </div>
                                                </div>
                                        </section>

                                        {/* ===== DOCUMENTATION ===== */}
                                        <section class="view panel-view" class:hidden={use(this.view).map((v) => v !== "docs")}>
                                                <h2 class="view-title">Documentation</h2>
                                                <div class="docs">
                                                        <div class="doc-card">
                                                                <h3>ABOUT</h3>
                                                                <p>
                                                                        Amphibian Launcher runs Minecraft: Java Edition with Fabric entirely in
                                                                        your browser. There is nothing to install — the game is downloaded into
                                                                        private browser storage (OPFS) and runs in its own tab on the .NET
                                                                        WebAssembly runtime.
                                                                </p>
                                                        </div>
                                                        <div class="doc-card">
                                                                <h3>GETTING STARTED</h3>
                                                                <div class="doc-steps">
                                                                        <div class="doc-step">
                                                                                <span class="n">1.</span>
                                                                                <p>
                                                                                        <b>Account</b> — sign in with a Microsoft account in the Account tab,
                                                                                        or switch to an offline username there.
                                                                                </p>
                                                                        </div>
                                                                        <div class="doc-step">
                                                                                <span class="n">2.</span>
                                                                                <p>
                                                                                        <b>Installation</b> — pick a Minecraft version (1.13 – 26.2) and a Fabric
                                                                                        loader version in Installations, then press SAVE INSTALLATION. It
                                                                                        appears in the selector next to PLAY.
                                                                                </p>
                                                                        </div>
                                                                        <div class="doc-step">
                                                                                <span class="n">3.</span>
                                                                                <p>
                                                                                        <b>Play</b> — press PLAY. The first launch of a version downloads the
                                                                                        game; progress, logs and FPS all show in the Console.
                                                                                </p>
                                                                        </div>
                                                                </div>
                                                        </div>
                                                        <div class="doc-card">
                                                                <h3>MODS</h3>
                                                                <p>
                                                                        Fabric mods are <code>.jar</code> files placed in <code>minecraft/mods</code> —
                                                                        create or upload the folder in the File Manager if it does not exist yet.
                                                                        Install Fabric API first, then the mods you want. Mods are read when the
                                                                        game starts, so restart the game after adding or removing any.
                                                                </p>
                                                        </div>
                                                        <div class="doc-card">
                                                                <h3>WORLDS &amp; BACKUPS</h3>
                                                                <p>
                                                                        Singleplayer worlds live in <code>minecraft/saves</code>. To back one up, open
                                                                        it in the File Manager and use <b>Download folder as .tar.gz</b>; restore
                                                                        later with <b>Extract archive here</b>. Unsaved progress is lost if you close
                                                                        the game without Save &amp; Quit.
                                                                </p>
                                                        </div>
                                                        <div class="doc-card">
                                                                <h3>FILE MANAGER</h3>
                                                                <p>
                                                                        The File Manager browses the launcher's private storage shared with the
                                                                        game. You can upload files or whole folders (or drag &amp; drop them in),
                                                                        download files back to your computer, delete entries, and edit text files
                                                                        such as <code>options.txt</code> or configs directly.
                                                                </p>
                                                        </div>
                                                        <div class="doc-card">
                                                                <h3>GAME TAB</h3>
                                                                <p>
                                                                        PLAY opens the game in a new tab of this site — the WebAssembly runtime can
                                                                        only start once per page, so the tab holds only Minecraft. Allow pop-ups
                                                                        for this site. Keep this launcher tab open: logs, FPS, memory and the Stop
                                                                        Game button live in the Console here.
                                                                </p>
                                                        </div>
                                                        <div class="doc-card">
                                                                <h3>WHICH BROWSER</h3>
                                                                <p>
                                                                        Best performance: <b>Chrome or Edge</b>{" "}
                                                                        (113+) on Windows or macOS — same engine,
                                                                        equal speed, Edge is fully fine. Keep
                                                                        hardware acceleration on{" "}
                                                                        (<code>edge://settings/system</code>), turn
                                                                        off Edge "Efficiency mode" while gaming, and
                                                                        check <code>edge://gpu</code> /{" "}
                                                                        <code>chrome://gpu</code>: the WebGPU row
                                                                        should say <b>Hardware accelerated</b>.{" "}
                                                                        <b>Firefox 141+</b> on Windows works too.
                                                                        Mobile browsers, Safari and most
                                                                        Chromebooks are not supported or only get a
                                                                        software GPU. The Console's{" "}
                                                                        <code>[gpu:game]</code> line always tells you
                                                                        which kind of adapter you got.
                                                                </p>
                                                        </div>
                                                        <div class="doc-card">
                                                                <h3>PERFORMANCE &amp; FPS</h3>
                                                                <p>
                                                                        The first launch of a version starts with
                                                                        settings tuned for the browser renderer
                                                                        (render distance, simulation distance, fast
                                                                        graphics, fewer particles, no entity shadows)
                                                                        — stricter when the browser only offers a
                                                                        software GPU. This is one-shot: change
                                                                        anything later in-game under{" "}
                                                                        <b>Options &gt; Video Settings</b> and it
                                                                        sticks. Still slow? Make sure hardware
                                                                        acceleration is on (chrome://settings/system),
                                                                        check <code>chrome://gpu</code>, update your
                                                                        GPU drivers, close other tabs, and add{" "}
                                                                        <code>?perf=0</code> to the URL to keep the
                                                                        launcher from ever touching settings. Power
                                                                        users: <code>?wj.IKVM_GAME_OPTIONS=key:value,...</code>{" "}
                                                                        overrides any option.
                                                                </p>
                                                        </div>
                                                        <div class="doc-card">
                                                                <h3>ACCOUNTS</h3>
                                                                <p>
                                                                        A Microsoft account that owns Minecraft: Java Edition is needed for online
                                                                        servers and skins. An offline username (3–16 letters, numbers or underscore)
                                                                        needs no account and works in singleplayer and on servers with{" "}
                                                                        <code>online-mode=false</code>.
                                                                </p>
                                                        </div>
                                                </div>
                                        </section>

                                        {/* ===== FILE MANAGER ===== */}
                                        <section class="view panel-view" class:hidden={use(this.view).map((v) => v !== "files")}>
                                                <h2 class="view-title">File Manager</h2>
                                                <OpfsExplorer />
                                        </section>

                                        {/* ===== ACCOUNT ===== */}
                                        <section class="view panel-view" class:hidden={use(this.view).map((v) => v !== "account")}>
                                                <h2 class="view-title">Account</h2>
                                                <div class="panel">
                                                        <div class="irow">
                                                                <span class="irow-label">ACCOUNT TYPE</span>
                                                                <div class="irow-body">
                                                                        <div class="segmented">
                                                                                <button
                                                                                        class="seg"
                                                                                        class:active={use(this.offline).map((o) => !o)}
                                                                                        on:click={() => setOffline(false)}
                                                                                >
                                                                                        MICROSOFT
                                                                                </button>
                                                                                <button
                                                                                        class="seg"
                                                                                        class:active={use(this.offline)}
                                                                                        on:click={() => setOffline(true)}
                                                                                >
                                                                                        OFFLINE
                                                                                </button>
                                                                        </div>
                                                                </div>
                                                        </div>

                                                        <div class="irow" class:hidden={use(this.offline)}>
                                                                <span class="irow-label">MICROSOFT</span>
                                                                <div class="irow-body">
                                                                        <div class="auth-row">
                                                                                {use(this.authState).map((x) => {
                                                                                        if (x.type === "loading") return <span>Checking account...</span>;
                                                                                        else if (x.type === "ready")
                                                                                                return (
                                                                                                        <button class="btn green" on:click={auth}>
                                                                                                                SIGN IN WITH MICROSOFT
                                                                                                        </button>
                                                                                                );
                                                                                        else if (x.type === "done")
                                                                                                return (
                                                                                                        <div class="auth-done">
                                                                                                                <span>
                                                                                                                        Signed in as <b>{x.name}</b>
                                                                                                                </span>
                                                                                                                <button class="btn" on:click={deauth}>
                                                                                                                        SIGN OUT
                                                                                                                </button>
                                                                                                        </div>
                                                                                                );
                                                                                        else if (x.type === "authing")
                                                                                                return (
                                                                                                        <div class="authing">
                                                                                                                <img class="qr" src={x.qr} alt="Sign-in QR code" />
                                                                                                                <div class="authing-text">
                                                                                                                        Open{" "}
                                                                                                                        <a href={x.url} target="_blank" rel="noopener noreferrer">
                                                                                                                                {x.url}
                                                                                                                        </a>{" "}
                                                                                                                        and sign in.
                                                                                                                </div>
                                                                                                        </div>
                                                                                                );
                                                                                        else if (x.type === "error")
                                                                                                return (
                                                                                                        <div class="auth-error">
                                                                                                                <div>Error: {String(x.error)}</div>
                                                                                                                <button class="btn" on:click={deauth}>
                                                                                                                        TRY AGAIN
                                                                                                                </button>
                                                                                                        </div>
                                                                                                );
                                                                                })}
                                                                        </div>
                                                                </div>
                                                        </div>

                                                        <div class="irow" class:hidden={use(this.offline).map((o) => !o)}>
                                                                <span class="irow-label">USERNAME</span>
                                                                <div class="irow-body">
                                                                        <input
                                                                                class="input"
                                                                                value={use(this.offlineName)}
                                                                                placeholder="Player"
                                                                                maxlength="16"
                                                                        />
                                                                </div>
                                                        </div>
                                                </div>
                                        </section>

                                        {/* ===== CONSOLE ===== */}
                                        <section class="view console-view" class:hidden={use(this.view).map((v) => v !== "console")}>
                                                <div class="console-head">
                                                        <div class="status-state">
                                                                {use(this.session, this.sessionText).map(([s, t]) =>
                                                                        s === "idle"
                                                                                ? "No game running"
                                                                                : t || (s === "running" ? "Game running" : "Starting"),
                                                                )}
                                                        </div>
                                                        <div class="status-progress">
                                                                {use(this.progress).map((p) => progressText(p))}
                                                        </div>
                                                        <div class="status-stats">
                                                                {use(this.stats).map((s) =>
                                                                        s
                                                                                ? `FPS ${s.fps} (avg ${s.fpsAvg}) · memory ${(
                                                                                                (s.wasmMemory + s.heapMemory) /
                                                                                                1048576
                                                                                  ).toFixed(0)} MiB`
                                                                                : "",
                                                                )}
                                                        </div>
                                                        <div class="console-actions">
                                                                <button
                                                                        class="btn"
                                                                        disabled={use(this.session).map((s) => s !== "running")}
                                                                        on:click={() => sendCommand("threadDump")}
                                                                >
                                                                        THREAD DUMP
                                                                </button>
                                                                <button
                                                                        class="btn"
                                                                        disabled={use(this.session).map((s) => s !== "running")}
                                                                        on:click={() => sendCommand("jitDump")}
                                                                >
                                                                        JIT DUMP
                                                                </button>
                                                                <button
                                                                        class="btn danger"
                                                                        disabled={use(this.session).map((s) => s === "idle")}
                                                                        on:click={stopGame}
                                                                >
                                                                        STOP GAME
                                                                </button>
                                                        </div>
                                                </div>
                                                <LogView scrolling={true} />
                                        </section>
                                </div>

                                {/* ===== BOTTOM SELECTION BAR ===== */}
                                <div class="selection-bar">
                                        <div class="dropdown-zone">
                                                <button
                                                        class="dropdown-selector"
                                                        on:click={() => (this.dropOpen = !this.dropOpen)}
                                                >
                                                        <div class="block-icon">
                                                                <div class="dirt" />
                                                                <div class="grass" />
                                                        </div>
                                                        <div class="version-text">
                                                                {selectedInstall.map((it) =>
                                                                        it ? (
                                                                                <div>
                                                                                        <p class="sel-name bolded">{it.version}</p>
                                                                                        <p class="sel-id">Fabric {it.fabric}</p>
                                                                                </div>
                                                                        ) : (
                                                                                <p class="sel-name bolded">No Installations</p>
                                                                        ),
                                                                )}
                                                        </div>
                                                        <span class="chevron" class:open={use(this.dropOpen)}>
                                                                <Icon icon={iconChevronUp} />
                                                        </span>
                                                </button>
                                                {use(this.dropOpen).map((open) =>
                                                        open ? (
                                                                <div class="dropdown-menu">
                                                                        {use(installsStore.list, installsStore.selected).map(
                                                                                ([list, sel]) =>
                                                                                        list.length === 0 ? (
                                                                                                <div class="dd-empty">No Installations</div>
                                                                                        ) : (
                                                                                                list.map((it, i) => (
                                                                                                        <button
                                                                                                                class="dropdown-item"
                                                                                                                class:active={sel === i}
                                                                                                                on:click={() => {
                                                                                                                        selectInstall(i);
                                                                                                                        this.dropOpen = false;
                                                                                                                }}
                                                                                                        >
                                                                                                                <div class="block-icon">
                                                                                                                        <div class="dirt" />
                                                                                                                        <div class="grass" />
                                                                                                                </div>
                                                                                                                <div class="dd-text">
                                                                                                                        <span class="dd-name">{it.version}</span>
                                                                                                                        <span class="dd-id">Fabric {it.fabric}</span>
                                                                                                                </div>
                                                                                                                <svg class="dd-check" viewBox="0 0 24 24">
                                                                                                                        <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                                                                                                                </svg>
                                                                                                        </button>
                                                                                                ))
                                                                                        ),
                                                                        )}
                                                                </div>
                                                        ) : null,
                                                )}
                                        </div>

                                        <div class="play-zone">
                                                <button class="play-btn" disabled={playDisabled} on:click={launch}>
                                                        PLAY
                                                </button>
                                                <div class="play-hint">{playHint}</div>
                                        </div>

                                        <div class="account-zone">
                                                <span class="playing-label">PLAYING AS</span>
                                                <span class="playing-name bolded">{accountName}</span>
                                                {use(this.sessionError).map((e) =>
                                                        e ? <div class="bar-error">{e}</div> : null,
                                                )}
                                        </div>
                                </div>
                        </div>

                        {/* ===== toast ===== */}
                        {use(toastStore.shown, toastStore.text, toastStore.red).map(([shown, text, red]) =>
                                shown ? (
                                        <div class="toast" class:red={red}>
                                                <div>
                                                        <p class="bolded">AMPHIBIAN</p>
                                                        <p>{text}</p>
                                                </div>
                                        </div>
                                ) : null,
                        )}
                </div>
        );
}

function App(this: FC<{}, {}>) {
        return <Launcher />;
}
App.style = css`
        :scope {
                display: block;
                height: 100%;
                width: 100%;
                background: var(--bg);
        }
`;
Launcher.style = css`
        :scope {
                display: flex;
                height: 100%;
                width: 100%;
                overflow: hidden;
                position: relative;
                background: var(--bg);
                color: var(--fg);
                font-family: var(--font-body);
        }
        .bolded {
                font-weight: 800;
        }
        .hidden {
                display: none !important;
        }
        .spacer {
                flex: 1;
        }

        /* ---- sidebar ------------------------------------------------------------------------------------------------ */
        .sidebar {
                display: flex;
                flex-direction: column;
                width: 16rem;
                min-width: 13rem;
                flex-shrink: 0;
                background: var(--bg-bar);
                color: var(--fg);
                position: relative;
                z-index: 30;
        }
        .brand {
                display: flex;
                justify-content: center;
                padding: 1.1rem 0.75rem 1.2rem;
        }
        .brand-logo {
                width: 12.5rem;
                mix-blend-mode: screen;
        }
        .side-nav {
                display: flex;
                flex-direction: column;
        }
        .sidebar-option {
                display: flex;
                height: 3.4rem;
                align-items: center;
                gap: 0.9rem;
                padding-left: 1.1rem;
                font-size: 0.85rem;
                line-height: 1.35;
                background: transparent;
                border: none;
                border-left: 0.3rem solid transparent;
                color: var(--fg-dim);
                width: 100%;
                text-align: left;
                cursor: pointer;
                transition: background 0.3s, padding 0.3s, color 0.3s;
                font-family: var(--font-body);
        }
        .sidebar-option:hover {
                cursor: pointer;
                background: var(--surface3);
                color: var(--fg);
        }
        .sidebar-option.selected {
                font-weight: 700;
                color: var(--fg);
                border-left-color: var(--accent);
                padding-left: 0.8rem;
        }
        .nav-icon {
                display: flex;
                flex: none;
        }
        .nav-icon :global(svg) {
                width: 1.3rem;
                height: 1.3rem;
                fill: currentColor;
                opacity: 0.92;
        }
        .launcher-version {
                position: absolute;
                bottom: 0.8rem;
                left: 1.1rem;
                font-size: 0.72rem;
                color: var(--fg5);
                z-index: 1;
        }

        /* ---- CSS grass block icon ----------------------------------------------------------------------------------- */
        .block-icon {
                position: relative;
                flex: none;
                border: 1px solid rgba(0, 0, 0, 0.55);
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.4);
                image-rendering: pixelated;
                background: #8a5c36;
                overflow: hidden;
        }
        .block-icon .dirt {
                position: absolute;
                left: 0;
                right: 0;
                top: 38%;
                bottom: 0;
                background: #8a5c36;
        }
        .block-icon .grass {
                position: absolute;
                left: 0;
                right: 0;
                top: 0;
                height: 38%;
                background: #5ea83f;
                border-bottom: 2px solid #4a8a30;
        }
        .block-icon::after {
                content: "";
                position: absolute;
                left: 12%;
                top: 44%;
                width: 18%;
                height: 14%;
                background: rgba(0, 0, 0, 0.18);
        }
        .dropdown-selector .block-icon {
                width: 1.5rem;
                height: 1.5rem;
        }
        .dropdown-item .block-icon {
                width: 1.4rem;
                height: 1.4rem;
        }
        .inst-row .block-icon {
                width: 1.6rem;
                height: 1.6rem;
        }

        /* ---- main column -------------------------------------------------------------------------------------------- */
        .main {
                display: flex;
                flex-direction: column;
                flex: 1;
                min-width: 0;
                background: var(--bg);
        }
        .views {
                position: relative;
                flex: 1;
                min-height: 0;
        }
        .view {
                position: absolute;
                inset: 0;
                overflow-y: auto;
        }
        .view.panel-view {
                background: var(--bg-sub);
                display: flex;
                flex-direction: column;
                align-items: center;
                padding: 1.6rem 0 2.2rem;
        }
        .view-title {
                margin: 0 0 1.2rem;
                font-size: 1.25rem;
                font-family: var(--font-pixel);
                font-weight: 400;
                letter-spacing: 0.04em;
        }

        /* ---- install / account rows --------------------------------------------------------------------------------- */
        .panel {
                display: flex;
                flex-direction: column;
                gap: 0.7rem;
                width: min(46rem, 92%);
        }
        .irow {
                display: flex;
                align-items: center;
                gap: 1.5rem;
                width: 100%;
                min-height: 3.2rem;
                padding: 0.5rem 1.1rem;
                border-radius: 0.55rem;
                transition: background 0.3s;
        }
        .irow:hover {
                background: var(--surface3);
        }
        .irow-label {
                width: 11rem;
                flex: none;
                font-size: 0.85rem;
                font-weight: 700;
                color: var(--fg-dim);
                letter-spacing: 0.05em;
        }
        .irow-body {
                flex: 1;
                display: flex;
                flex-direction: column;
                gap: 0.25rem;
                min-width: 0;
        }

        .input {
                background: var(--bg-sub);
                border: 1px solid #0c6e3d;
                color: var(--fg);
                font-size: 0.85rem;
                padding: 0.45rem 0.65rem;
                border-radius: 0.35rem;
                outline: none;
                width: 100%;
                max-width: 22rem;
                transition: border-color 0.2s, background 0.2s;
                font-family: var(--font-body);
        }
        .input:focus {
                border-color: var(--mc-green-bright);
                background: #0a0a0a;
        }
        .input::placeholder {
                color: var(--fg5);
        }

        .segmented {
                display: inline-flex;
                border: 1px solid #0c6e3d;
                border-radius: 0.4rem;
                overflow: hidden;
                width: max-content;
        }
        .seg {
                background: var(--bg-sub);
                color: var(--fg-dim);
                border: none;
                font-size: 0.75rem;
                font-weight: 700;
                padding: 0.45rem 1.1rem;
                cursor: pointer;
                letter-spacing: 0.06em;
                transition: background 0.2s, color 0.2s;
                font-family: var(--font-body);
        }
        .seg:hover {
                color: var(--fg);
                background: var(--surface3);
        }
        .seg.active {
                background: var(--accent);
                color: #fff;
        }

        .btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 0.45rem;
                width: max-content;
                border: none;
                cursor: pointer;
                border-radius: 0.45rem;
                font-weight: 700;
                letter-spacing: 0.05em;
                font-size: 0.8rem;
                padding: 0.6rem 1.2rem;
                transition: transform 0.12s, filter 0.2s;
                color: #fff;
                background: var(--surface4);
                font-family: var(--font-body);
        }
        .btn:hover:not(:disabled) {
                filter: brightness(1.15);
        }
        .btn:active:not(:disabled) {
                transform: translateY(1px);
        }
        .btn:disabled {
                background: var(--surface2);
                color: var(--fg5);
                cursor: not-allowed;
                filter: none;
                transform: none;
        }
        .btn.green {
                background: linear-gradient(180deg, var(--mc-green-bright), var(--accent));
                box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.28);
        }
        .btn.green:hover:not(:disabled) {
                background: linear-gradient(180deg, #00c463, var(--mc-green-hover));
        }
        .btn.danger {
                background: #7a2c2c;
        }
        .btn.danger:hover:not(:disabled) {
                background: #963636;
        }
        .btn :global(svg) {
                width: 1rem;
                height: 1rem;
                fill: currentColor;
        }

        /* ---- saved installations list -------------------------------------------------------------------------------- */
        .inst-list {
                display: flex;
                flex-direction: column;
                gap: 0.35rem;
        }
        .inst-empty {
                color: var(--fg5);
                font-size: 0.8rem;
                padding: 0.3rem 0;
        }
        .inst-row {
                display: flex;
                align-items: center;
                gap: 0.75rem;
                min-height: 2.9rem;
                padding: 0.4rem 0.75rem;
                border-radius: 0.45rem;
                background: var(--bg-bar);
                border: 1px solid var(--line-soft);
                cursor: pointer;
                transition: border-color 0.2s, background 0.2s;
        }
        .inst-row:hover {
                background: var(--surface3);
        }
        .inst-row.selected {
                border-color: var(--mc-green-bright);
        }
        .inst-info {
                min-width: 0;
        }
        .inst-name {
                font-weight: 700;
                font-size: 0.85rem;
        }
        .inst-meta {
                color: var(--fg4);
                font-size: 0.72rem;
        }
        .inst-del {
                margin-left: auto;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 1.7rem;
                height: 1.7rem;
                border: none;
                border-radius: 0.35rem;
                background: transparent;
                color: var(--fg4);
                cursor: pointer;
                flex: none;
        }
        .inst-del :global(svg) {
                width: 0.95rem;
                height: 0.95rem;
                fill: currentColor;
        }
        .inst-del:hover {
                background: #7a2c2c;
                color: #fff;
        }

        /* ---- documentation ------------------------------------------------------------------------------------------ */
        .docs {
                width: min(48rem, 94%);
                display: flex;
                flex-direction: column;
                gap: 0.6rem;
        }
        .doc-card {
                background: var(--bg-bar);
                border: 1px solid var(--line-soft);
                border-radius: 0.7rem;
                padding: 0.9rem 1.1rem;
        }
        .doc-card h3 {
                margin: 0 0 0.35rem;
                font-family: var(--font-mono);
                font-size: 0.9rem;
                font-weight: 700;
                color: var(--mc-green-bright);
                letter-spacing: 0.04em;
        }
        .doc-card p {
                margin: 0;
                font-size: 0.82rem;
                color: var(--fg-dim);
                line-height: 1.65;
        }
        .doc-card code {
                font-family: var(--font-mono);
                color: var(--mc-green-bright);
                background: rgba(0, 132, 66, 0.12);
                padding: 0 0.25rem;
                border-radius: 0.2rem;
        }
        .doc-steps {
                display: flex;
                flex-direction: column;
                gap: 0.4rem;
                padding-top: 0.2rem;
        }
        .doc-step {
                display: flex;
                gap: 0.7rem;
                align-items: baseline;
        }
        .doc-step .n {
                font-family: var(--font-pixel);
                color: var(--mc-green-bright);
                font-size: 0.8rem;
                flex: none;
        }
        .doc-step p {
                flex: 1;
        }

        /* ---- play hero ---------------------------------------------------------------------------------------------- */
        .play-view {
                overflow: hidden;
        }
        .game-bg {
                position: absolute;
                inset: 0;
                display: flex;
                justify-content: center;
        }
        .game-bg::before {
                content: "";
                position: absolute;
                inset: 0;
                z-index: 1;
                background: linear-gradient(
                        180deg,
                        rgba(0, 0, 0, 0.42) 0%,
                        rgba(0, 0, 0, 0) 32%,
                        rgba(0, 0, 0, 0) 55%,
                        rgba(30, 30, 30, 0.94) 100%
                );
        }
        .hero-img {
                position: absolute;
                inset: 0;
                width: 100%;
                height: 100%;
                object-fit: cover;
                opacity: 0;
                /* Wallpaper crossfade: each image fades in, holds ~13.5s, fades out, and the next one
                   takes over. Loop = image count * 15s (7 * 15 = 105s); adjust if you add/remove
                   files. Opacity-only animation = compositor work, zero layout cost. */
                animation: wallpaper-cycle 105s infinite;
                animation-delay: calc(var(--wp-i, 0) * 15s);
        }
        @keyframes wallpaper-cycle {
                0% {
                        opacity: 0;
                }
                1.43% {
                        opacity: 1;
                }
                12.86% {
                        opacity: 1;
                }
                14.29% {
                        opacity: 0;
                }
                100% {
                        opacity: 0;
                }
        }
        @media (prefers-reduced-motion: reduce) {
                .hero-img {
                        animation: none;
                }
                .hero-img:first-child {
                        opacity: 1;
                }
        }        .game-title {
                position: relative;
                z-index: 2;
                margin-top: 9vh;
                text-align: center;
                animation: hero-drop 0.5s linear forwards;
        }
        .hero-logo {
                width: min(34rem, 60vw);
                mix-blend-mode: screen;
        }
        @keyframes hero-drop {
                from {
                        transform: translateY(-40px);
                        opacity: 0;
                }
                to {
                        transform: translateY(0);
                        opacity: 1;
                }
        }

        /* ---- account ------------------------------------------------------------------------------------------------ */
        .auth-row {
                display: flex;
                align-items: center;
                gap: 0.75rem;
                flex-wrap: wrap;
        }
        .auth-done {
                display: flex;
                align-items: center;
                gap: 0.9rem;
                flex-wrap: wrap;
        }
        .authing {
                display: flex;
                align-items: center;
                gap: 1.2rem;
                flex-wrap: wrap;
                font-size: 0.85rem;
        }
        .authing-text {
                line-height: 1.6;
        }
        .authing a {
                color: var(--mc-green-bright);
        }
        .qr {
                width: 9rem;
                height: 9rem;
                background: #fff;
                border-radius: 0.4rem;
                padding: 0.4rem;
        }
        .auth-error {
                color: var(--mc-red);
                font-size: 0.85rem;
                display: flex;
                align-items: center;
                gap: 1rem;
                flex-wrap: wrap;
        }

        /* ---- console ------------------------------------------------------------------------------------------------ */
        .console-view {
                display: flex;
                flex-direction: column;
                padding: 1rem 1.5rem 1.2rem;
                gap: 0.8rem;
                background: #0d0d0d;
                overflow: hidden;
        }
        .console-head {
                display: flex;
                align-items: center;
                gap: 1.2rem;
                flex-wrap: wrap;
        }
        .status-state {
                font-weight: 700;
                font-size: 0.9rem;
                min-width: 10rem;
        }
        .status-progress {
                font-family: var(--font-mono);
                font-size: 0.78rem;
                color: var(--fg-dim);
                flex: 1;
                min-width: 8rem;
        }
        .status-stats {
                font-family: var(--font-mono);
                font-size: 0.78rem;
                color: var(--mc-green-bright);
        }
        .console-actions {
                display: flex;
                gap: 0.5rem;
                margin-left: auto;
        }

        /* ---- bottom selection bar ----------------------------------------------------------------------------------- */
        .selection-bar {
                position: relative;
                height: 4.6rem;
                flex: none;
                display: flex;
                align-items: center;
                background: var(--bg);
                z-index: 20;
                box-shadow: 0 -1px 0 var(--line-soft);
        }
        .dropdown-zone {
                position: relative;
                height: 100%;
                width: 20rem;
                flex: none;
        }
        .dropdown-selector {
                display: flex;
                height: 2.9rem;
                width: calc(100% - 1rem);
                margin: 0.85rem 0 0.85rem 1rem;
                align-items: center;
                gap: 0.7rem;
                padding: 0 0.9rem;
                color: #fff;
                background: var(--surface2);
                border: none;
                border-radius: 0.45rem;
                box-shadow: 0 2px 6px rgba(0, 0, 0, 0.28);
                cursor: pointer;
                transition: background 0.3s;
                font-family: var(--font-body);
                text-align: left;
        }
        .dropdown-selector:hover {
                background: var(--surface3);
        }
        .version-text {
                min-width: 0;
                flex: 1;
        }
        .version-text p {
                margin: 0;
        }
        .sel-name {
                font-size: 0.86rem;
                line-height: 1.3;
                white-space: nowrap;
        }
        .sel-id {
                font-size: 0.7rem;
                color: var(--fg4);
                white-space: nowrap;
        }
        .chevron {
                display: flex;
                color: #fff;
                transition: transform 0.25s;
        }
        .chevron :global(svg) {
                width: 1.1rem;
                height: 1.1rem;
                fill: currentColor;
        }
        .chevron.open {
                transform: rotate(180deg);
        }
        .dropdown-menu {
                position: absolute;
                left: 1rem;
                bottom: calc(100% + 0.15rem);
                width: calc(100% - 1rem);
                z-index: 999;
                max-height: 60vh;
                overflow-y: auto;
                padding: 0.2rem;
                border-radius: 0.6rem;
                background: rgba(19, 19, 19, 0.98);
                box-shadow: 0 10px 26px rgba(0, 0, 0, 0.55);
                animation: dd-pop 0.18s ease-out;
        }
        @keyframes dd-pop {
                from {
                        opacity: 0;
                        transform: translateY(8px);
                }
                to {
                        opacity: 1;
                        transform: translateY(0);
                }
        }
        .dropdown-item {
                display: flex;
                height: 2.8rem;
                width: 100%;
                align-items: center;
                gap: 0.7rem;
                padding: 0 0.7rem;
                color: #fff;
                background: var(--surface2);
                border: none;
                border-radius: 0.4rem;
                margin-bottom: 0.25rem;
                font-size: 0.85rem;
                cursor: pointer;
                transition: background 0.15s;
                text-align: left;
                font-family: var(--font-body);
        }
        .dropdown-item:hover {
                background: var(--accent);
        }
        .dd-text {
                display: flex;
                flex-direction: column;
                align-items: flex-start;
                min-width: 0;
                flex: 1;
        }
        .dd-name {
                font-weight: 700;
                line-height: 1.3;
        }
        .dd-id {
                font-size: 0.72rem;
                color: var(--fg4);
        }
        .dropdown-item:hover .dd-id {
                color: rgba(255, 255, 255, 0.75);
        }
        .dropdown-item.active {
                outline: 2px solid var(--mc-green-bright);
        }
        .dd-check {
                width: 0.95rem;
                height: 0.95rem;
                fill: none;
                stroke: var(--mc-green-bright);
                stroke-width: 2.6;
                flex: none;
                visibility: hidden;
        }
        .dropdown-item.active .dd-check {
                visibility: visible;
        }
        .dropdown-item:hover .dd-check {
                stroke: #fff;
        }
        .dd-empty {
                padding: 0.8rem;
                color: var(--fg4);
                font-size: 0.8rem;
                text-align: center;
        }

        .play-zone {
                flex: 1;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 0.15rem;
                min-width: 0;
        }
        .play-btn {
                width: 19rem;
                max-width: 90%;
                height: 3.4rem;
                border: none;
                border-radius: 0.5rem;
                cursor: pointer;
                font-family: var(--font-body);
                font-weight: 800;
                font-size: 1.35rem;
                letter-spacing: 0.35em;
                text-indent: 0.35em;
                color: #fff;
                background: linear-gradient(180deg, var(--mc-green-bright) 0%, var(--accent) 78%);
                box-shadow: inset 0 2px 0 rgba(255, 255, 255, 0.22), inset 0 -3px 0 rgba(0, 0, 0, 0.3),
                        0 4px 12px rgba(0, 0, 0, 0.45);
                text-shadow: 0 1px 0 rgba(0, 0, 0, 0.4);
                transition: transform 0.1s, filter 0.1s;
        }
        .play-btn:hover:not(:disabled) {
                transform: scale(1.045);
                filter: brightness(1.08);
        }
        .play-btn:active:not(:disabled) {
                transform: scale(1);
        }
        .play-btn:disabled {
                background: var(--surface4);
                color: var(--fg5);
                cursor: not-allowed;
                box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.3);
                text-shadow: none;
        }
        .play-hint {
                font-size: 0.7rem;
                color: #ffd166;
                min-height: 1rem;
                line-height: 1rem;
        }

        .account-zone {
                width: 20rem;
                flex: none;
                padding-right: 1.5rem;
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                justify-content: center;
                gap: 0.05rem;
                position: relative;
        }
        .playing-label {
                font-size: 0.6rem;
                letter-spacing: 0.18em;
                color: var(--fg5);
        }
        .playing-name {
                font-size: 1.15rem;
                max-width: 100%;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
        }
        .bar-error {
                position: absolute;
                right: 1.5rem;
                bottom: 0.3rem;
                font-size: 0.68rem;
                color: var(--mc-red);
                max-width: 22rem;
                text-align: right;
        }

        /* ---- toast -------------------------------------------------------------------------------------------------- */
        .toast {
                position: fixed;
                right: 1rem;
                top: 1rem;
                z-index: 1000;
                padding: 0.4rem 0.9rem;
                margin: 0.6rem;
                background: rgba(50, 50, 50, 0.9);
                border-radius: 1.4rem;
                border: 2px solid #ffd166;
                color: #ffd166;
                font-style: italic;
                font-size: 0.95rem;
                max-width: 26rem;
                animation: hero-drop 0.4s linear forwards;
        }
        .toast.red {
                border-color: var(--mc-red);
                color: var(--mc-red);
        }
        .toast .bolded {
                font-style: normal;
        }
        .toast p {
                margin: 0;
        }

        @media (max-width: 64rem) {
                .sidebar {
                        display: none;
                }
                .dropdown-zone,
                .account-zone {
                        width: auto;
                        flex: 1;
                }
                .play-btn {
                        width: auto;
                        padding: 0 2.5rem;
                }
                .account-zone {
                        padding-right: 1rem;
                }
        }
`;

document.querySelector("#app")!.replaceWith(<App />);
