import "./theme.css";

// One bundle, two pages. The launcher is the normal page. The game runs on a second page of the same app, opened by the
// launcher with ?game=<id>, which holds nothing but the Minecraft canvas (see game.ts). Keeping them in separate chunks
// means the launcher never loads the game runtime and the game page never loads the launcher UI.
if (new URLSearchParams(location.search).has("game")) await import("./game");
else {
        // Boot failures used to die silently in the console: a module-level throw (e.g. an unsupported browser,
        // OPFS or SharedArrayBuffer missing) left nothing but a blank page. Paint what happened instead.
        const showFatal = (message: string) => {
                if (document.querySelector(".boot-fatal")) return;
                const el = document.createElement("div");
                el.className = "boot-fatal";
                el.textContent = message;
                document.body.append(el);
        };
        addEventListener("error", (e) => showFatal(`The launcher failed to load: ${e.message ?? "unknown error"}`));
        addEventListener("unhandledrejection", (e) =>
                showFatal(`The launcher failed to load: ${String((e as PromiseRejectionEvent).reason)}`)
        );
        const style = document.createElement("style");
        style.textContent = `.boot-fatal { position: fixed; inset: auto 1rem 1rem; z-index: 9999;
                background: #3a1512; color: #ffd7d5; border: 1px solid #ff5555; border-radius: 8px;
                font: 500 .85rem/1.5 system-ui, sans-serif; padding: .9rem 1.1rem; overflow-wrap: anywhere; }`;
        document.head.append(style);
        await import("./launcher");
}
