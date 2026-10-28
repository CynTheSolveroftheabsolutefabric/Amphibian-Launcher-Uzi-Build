export type Log = { color: string; log: string };
export let loglisteners: ((log: Log) => void)[] = [];

let logs: string[] = [];
(globalThis as any).logs = logs;

function proxyConsole(name: string, color: string) {
        // @ts-expect-error ts sucks
        const old = console[name].bind(console);
        // The runtime can emit the identical line many times per frame -- e.g. the engine's
        // "glfwSetCursorPos is not available" GL error fired 4+ lines EVERY rendered frame. Each one
        // used to hit the real console AND every listener (in-page log, bridge batches to the launcher),
        // which is real overhead during gameplay. Identical repeats within a 2s window now collapse
        // into one "[repeated xN]" line. Lines with non-string args are never deduped: two different
        // objects can stringify identically but mean different things.
        let last = "";
        let repeats = 0;
        let firstAt = 0;
        let flushTimer: ReturnType<typeof setTimeout> | null = null;
        const flush = () => {
                flushTimer = null;
                if (repeats > 1) {
                        const line = `${last}  [repeated x${repeats}]`;
                        old(line);
                        for (const logger of loglisteners) {
                                logger({ color, log: line });
                        }
                }
                repeats = 0;
        };
        // @ts-expect-error ts sucks
        console[name] = (...args) => {
                let str;
                try {
                        str = args.join(" ");
                } catch {
                        str = "<failed to render>";
                }
                const dedupeable = str !== "<failed to render>" && args.every((arg) => typeof arg === "string");
                const now = Date.now();
                if (dedupeable && str === last && now - firstAt < 2000) {
                        repeats += 1;
                        if (flushTimer === null) flushTimer = setTimeout(flush, 3000);
                        return;
                }
                if (flushTimer !== null) {
                        clearTimeout(flushTimer);
                        flushTimer = null;
                }
                if (repeats > 1) flush(); // keep ordering: emit the collapsed group before the new line
                last = dedupeable ? str : "";
                firstAt = now;
                repeats = 1;
                old(...args);
                for (const logger of loglisteners) {
                        logger({ color, log: str });
                }
        };
        return old;
}
export const console_error = proxyConsole("error", "var(--error)");
export const console_warn = proxyConsole("warn", "var(--warning)");
export const console_log = proxyConsole("log", "var(--fg)");
export const console_info = proxyConsole("info", "var(--info)");
export const console_debug = proxyConsole("debug", "var(--fg4)");
