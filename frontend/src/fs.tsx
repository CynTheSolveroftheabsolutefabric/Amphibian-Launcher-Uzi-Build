import { css, FC } from "dreamland/core";
import { Icon } from "./ui/Button";
import iconFolder from "@ktibow/iconset-material-symbols/folder";
import iconDraft from "@ktibow/iconset-material-symbols/draft";
import iconDownload from "@ktibow/iconset-material-symbols/download";
import iconDelete from "@ktibow/iconset-material-symbols/delete";
import iconClose from "@ktibow/iconset-material-symbols/close";
import iconSave from "@ktibow/iconset-material-symbols/save";
import iconUploadFile from "@ktibow/iconset-material-symbols/upload-file";
import iconUploadFolder from "@ktibow/iconset-material-symbols/drive-folder-upload";
import iconArchive from "@ktibow/iconset-material-symbols/archive";
import iconUnarchive from "@ktibow/iconset-material-symbols/unarchive";
import iconArrowBack from "@ktibow/iconset-material-symbols/arrow-back";

import tar, { Headers as TarHeaders, Pack } from "tar-stream";
import { opfsInvalidate } from "./opfs";
import {
        fromWeb as streamFromWeb,
        toWeb as streamToWeb,
        /* @ts-expect-error streamx-webstream ships no type declarations */
} from "streamx-webstream";

// The File System Access API pickers are non-standard and missing from lib.dom.
declare global {
        function showOpenFilePicker(options?: { multiple?: boolean }): Promise<FileSystemFileHandle[]>;
        function showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
        function showSaveFilePicker(options?: {
                excludeAcceptAllOption?: boolean;
                suggestedName?: string;
                types?: FilePickerAcceptType[];
        }): Promise<FileSystemFileHandle>;
        type FilePickerAcceptType = {
                description?: string;
                accept: Record<string, string | string[]>;
        };
        interface Window {
                showOpenFilePicker?: unknown;
                showDirectoryPicker?: unknown;
                showSaveFilePicker?: unknown;
        }
}

export const PICKERS_UNAVAILABLE =
        !window.showDirectoryPicker || !window.showOpenFilePicker;

export const TAR_TYPES: FilePickerAcceptType[] = [
        {
                description: "TAR archive (.tar)",
                accept: { "application/x-tar": ".tar" },
        },
        {
                description: "GZip compressed TAR archive (.tar.gz)",
                accept: { "application/x-gzip": ".tar.gz", "application/gzip": ".tar.gz" },
        },
];

const rootFolder = await navigator.storage.getDirectory();

async function recursiveGetDirectory(
        dir: FileSystemDirectoryHandle,
        path: string[]
): Promise<FileSystemDirectoryHandle> {
        if (path.length === 0) return dir;
        return recursiveGetDirectory(await dir.getDirectoryHandle(path[0]), path.slice(1));
}

async function copyFile(file: FileSystemFileHandle, to: FileSystemDirectoryHandle) {
        const data = await file.getFile().then((r) => r.stream());
        const handle = await to.getFileHandle(file.name, { create: true });
        opfsInvalidate();
        const writable = await handle.createWritable();
        await data.pipeTo(writable);
}

async function copyFolder(folder: FileSystemDirectoryHandle, to: FileSystemDirectoryHandle) {
        async function upload(from: FileSystemDirectoryHandle, into: FileSystemDirectoryHandle) {
                // FileSystemDirectoryHandle async iteration lives in lib.dom.asynciterable, not enabled here.
                for await (const [name, entry] of from as any) {
                        if (entry.kind === "file") {
                                await copyFile(entry as FileSystemFileHandle, into);
                        } else {
                                const newTo = await into.getDirectoryHandle(name, { create: true });
                                opfsInvalidate();
                                await upload(entry as FileSystemDirectoryHandle, newTo);
                        }
                }
        }
        const newFolder = await to.getDirectoryHandle(folder.name, { create: true });
        opfsInvalidate();
        await upload(folder, newFolder);
}

async function createEntry(
        pack: Pack,
        header: TarHeaders,
        file?: ReadableStream<Uint8Array>
) {
        let resolve: () => void = null!;
        let reject: (err: any) => void = null!;
        const promise = new Promise<void>((res, rej) => {
                resolve = res;
                reject = rej;
        });

        const entry = pack.entry(header, (err) => {
                if (err) reject(err);
                else resolve();
        });

        if (file) {
                const reader = file.getReader();
                while (true) {
                        const { value, done } = await reader.read();
                        if (done || !value) break;

                        entry.write(value);
                }

                entry.end();
        } else {
                entry.end();
        }

        await promise;
}

export function createTar(
        folder: FileSystemDirectoryHandle,
        callback?: (type: "directory" | "file", name: string) => void
): ReadableStream {
        const archive = tar.pack();

        async function pack(pathPrefix: string, folder: FileSystemDirectoryHandle) {
                // FileSystemDirectoryHandle async iteration lives in lib.dom.asynciterable, not enabled here.
                for await (const [name, entry] of folder as any) {
                        if (callback) callback(entry.kind, name);

                        if (entry.kind == "file") {
                                const file = await (entry as FileSystemFileHandle).getFile();
                                const stream = file.stream();

                                await createEntry(
                                        archive,
                                        {
                                                name: pathPrefix + name,
                                                type: entry.kind,
                                                size: file.size,
                                        },
                                        stream
                                );
                        } else {
                                await createEntry(archive, {
                                        name: pathPrefix + name,
                                        type: entry.kind,
                                });

                                await pack(pathPrefix + name + "/", entry as FileSystemDirectoryHandle);
                        }
                }
        }
        pack("", folder).then(() => archive.finalize());

        return streamToWeb(archive);
}

export async function extractTar(
        stream: ReadableStream<Uint8Array>,
        folder: FileSystemDirectoryHandle,
        callback?: (type: "directory" | "file", name: string) => void
) {
        const tarInput = streamFromWeb(stream);
        const archive = tar.extract();

        archive.on("entry", async (header, stream, next) => {
                const body: ReadableStream<Uint8Array> = streamToWeb(stream);

                async function consume() {
                        const reader = body.getReader();

                        while (true) {
                                const { done, value } = await reader.read();
                                if (done || !value) break;
                        }
                }

                const path = header.name.split("/");
                if (path[path.length - 1] === "") path.pop();
                if (path[0] === folder.name) path.shift();
                if (path.length === 0) {
                        await consume();
                        next();
                        return;
                }

                let handle = folder;
                for (const name of path.splice(0, path.length - 1)) {
                        handle = await handle.getDirectoryHandle(name, { create: true });
                }
                opfsInvalidate();

                if (header.type === "directory") {
                        await handle.getDirectoryHandle(path[0], { create: true });
                        opfsInvalidate();
                        await consume();

                        if (callback) callback("directory", path[0]);
                } else if (header.type === "file") {
                        const file = await handle.getFileHandle(path[0], { create: true });
                        opfsInvalidate();
                        const writable = await file.createWritable();
                        await body.pipeTo(writable);

                        if (callback) callback("file", path[0]);
                } else {
                        await consume();
                }

                next();
        });

        const promise = new Promise<void>((res, rej) => {
                archive.on("finish", () => res());
                archive.on("error", (err) => rej(err));
        });

        tarInput.pipe(archive);
        await promise;
}

type Entry = { name: string; entry: FileSystemHandle; size: number | null };

const fmtSize = (n: number | null): string =>
        n == null
                ? ""
                : n >= 1048576
                  ? (n / 1048576).toFixed(1) + " MB"
                  : n >= 1024
                    ? (n / 1024).toFixed(1) + " KB"
                    : n + " B";

export function OpfsExplorer(
        this: FC<
                {},
                {
                        path: FileSystemDirectoryHandle;
                        components: string[];
                        entries: Entry[];
                        editing: FileSystemFileHandle | null;
                        uploading: boolean;
                        downloading: boolean;
                        message: string;
                        dragging: boolean;
                }
        >
) {
        this.message = "";
        this.dragging = false;
        this.path = rootFolder;
        this.components = [];
        this.entries = [];
        this.editing = null as FileSystemFileHandle | null;
        this.uploading = false;
        this.downloading = false;

        const refresh = async () => {
                this.components = (await rootFolder.resolve(this.path)) || [];

                const entries: Entry[] = [];
                for await (const [name, entry] of this.path as any) {
                        entries.push({ name, entry: entry as FileSystemHandle, size: null });
                }
                entries.sort((a, b) => {
                        const kind = a.entry.kind.localeCompare(b.entry.kind);
                        return kind === 0 ? a.name.localeCompare(b.name) : kind;
                });
                this.entries = entries;

                // File sizes need one stat call each; fill them in after the listing has painted.
                const withSizes = await Promise.all(
                        entries.map(async (e) => {
                                if (e.entry.kind !== "file") return e;
                                try {
                                        const file = await (e.entry as FileSystemFileHandle).getFile();
                                        return { ...e, size: file.size };
                                } catch {
                                        return e;
                                }
                        })
                );
                this.entries = withSizes;
        };

        this.cx.mount = () => {
                // reassigning this.path re-runs refresh, so navigation/upload just set this.path = this.path
                use(this.path).listen(refresh);
                refresh();
        };

        const goUp = async () => {
                this.editing = null;
                this.path = await recursiveGetDirectory(rootFolder, this.components.slice(0, -1));
        };

        // Write plain File objects (from <input type=file> or drag-and-drop) into a directory, then check each one landed
        // at the right size. Works in every browser, unlike showOpenFilePicker, and reports failures instead of swallowing them.
        const writeFiles = async (files: File[], into: FileSystemDirectoryHandle) => {
                for (const file of files) {
                        const handle = await into.getFileHandle(file.name, { create: true });
                        opfsInvalidate();
                        const writable = await handle.createWritable();
                        await file.stream().pipeTo(writable);
                        const written = (await handle.getFile()).size;
                        if (written !== file.size)
                                throw new Error(`${file.name}: wrote ${written} of ${file.size} bytes`);
                }
        };

        const uploadFiles = async (files: File[], into?: FileSystemDirectoryHandle) => {
                if (files.length === 0) return;
                this.message = "";
                this.uploading = true;
                try {
                        const target = into ?? this.path;
                        await writeFiles(files, target);
                        if (into) this.path = into;
                        await refresh();
                        this.message = `Uploaded ${files.length} file${files.length === 1 ? "" : "s"}: ${files.map((f) => f.name).join(", ")}`;
                } catch (error) {
                        console.error("upload failed", error);
                        this.message = "Upload failed: " + (error instanceof Error ? error.message : String(error));
                } finally {
                        this.uploading = false;
                }
        };

        const makeInput = (accept: string, onFiles: (files: File[]) => void): HTMLInputElement =>
                (
                        <input
                                type="file"
                                accept={accept}
                                multiple
                                hidden
                                on:change={() => {
                                        const files = Array.from(fileInputs.get(accept)!.files || []);
                                        fileInputs.get(accept)!.value = "";
                                        onFiles(files);
                                }}
                        />
                ) as HTMLInputElement;
        const fileInputs = new Map<string, HTMLInputElement>();
        const anyFileInput = makeInput("", (files) => uploadFiles(files));
        fileInputs.set("", anyFileInput);
        // Attached (but hidden) so file inputs behave the same in every browser, not only where detached clicks work.
        document.body.append(anyFileInput);

        const uploadFile = () => anyFileInput.click();

        const onDrop = (event: DragEvent) => {
                event.preventDefault();
                this.dragging = false;
                const files = Array.from(event.dataTransfer?.files || []);
                uploadFiles(files);
        };

        const uploadFolder = async () => {
                let folder: FileSystemDirectoryHandle;
                try {
                        folder = await showDirectoryPicker();
                } catch (error) {
                        if (error instanceof DOMException && error.name === "AbortError") return;
                        this.message = "Upload failed: " + (error instanceof Error ? error.message : String(error));
                        return;
                }
                this.message = "";
                this.uploading = true;
                try {
                        await copyFolder(folder, this.path);
                        await refresh();
                } catch (error) {
                        console.error("folder upload failed", error);
                        this.message = "Upload failed: " + (error instanceof Error ? error.message : String(error));
                } finally {
                        this.uploading = false;
                }
        };

        const downloadArchive = async () => {
                const dirName = this.components.at(-1) || "launcher-files";
                const file = await showSaveFilePicker({
                        excludeAcceptAllOption: true,
                        suggestedName: dirName + ".tar",
                        types: TAR_TYPES,
                });

                this.downloading = true;

                let stream = createTar(this.path, (type, name) => console.log(`tarring ${type} ${name}`));
                if (file.name.endsWith(".gz")) stream = stream.pipeThrough(new CompressionStream("gzip"));

                const fileStream = await file.createWritable();
                await stream.pipeTo(fileStream);

                this.downloading = false;
        };

        const uploadArchiveFiles = async (files: File[]) => {
                if (files.length === 0) return;
                this.uploading = true;
                try {
                        for (const file of files) {
                                let stream = file.stream();
                                if (file.name.endsWith(".gz")) stream = stream.pipeThrough(new DecompressionStream("gzip"));
                                await extractTar(stream, this.path, (type, name) => console.log(`untarring ${type} ${name}`));
                        }
                } finally {
                        this.path = this.path;
                        this.uploading = false;
                }
        };

        const archiveInput: HTMLInputElement = (
                <input
                        type="file"
                        accept=".tar,.tar.gz"
                        multiple
                        hidden
                        on:change={() => {
                                const files = Array.from(archiveInput.files || []);
                                archiveInput.value = "";
                                return uploadArchiveFiles(files);
                        }}
                />
        ) as HTMLInputElement;

        const uploadArchive = async () => {
                if (!window.showOpenFilePicker) {
                        archiveInput.click();
                        return;
                }
                let handles: FileSystemFileHandle[];
                try {
                        handles = await showOpenFilePicker({ multiple: true });
                } catch (error) {
                        if (error instanceof DOMException && error.name === "AbortError") return;
                        throw error;
                }
                await uploadArchiveFiles(await Promise.all(handles.map((file) => file.getFile())));
        };

        const goTo = async (depth: number) => {
                this.editing = null;
                this.message = "";
                this.path = await recursiveGetDirectory(rootFolder, this.components.slice(0, depth + 1));
        };

        const uploadDisabled = use(this.uploading).map((x) => x);
        const folderUploadDisabled = use(this.uploading).map(
                (x) => x || !window.showDirectoryPicker,
        );
        const downloadDisabled = use(this.downloading).map(
                (x) => x || !window.showSaveFilePicker,
        );

        return (
                <div class="fs-explorer">
                        <div class="fm-toolbar">
                                <button
                                        class="icon-btn"
                                        disabled={use(this.components).map((c) => c.length === 0)}
                                        title="Up a level"
                                        on:click={goUp}
                                >
                                        <Icon icon={iconArrowBack} />
                                </button>
                                <div class="crumb">
                                        {use(this.components).map((c) =>
                                                c.length === 0 ? (
                                                        <button class="crumb-seg last">Root</button>
                                                ) : (
                                                        [<button class="crumb-seg" on:click={() => goTo(-1)}>Root</button>].concat(
                                                                ...c.map((name, i) => [
                                                                        <span class="crumb-sep">/</span>,
                                                                        <button
                                                                                class="crumb-seg"
                                                                                class:last={i === c.length - 1}
                                                                                on:click={() => goTo(i)}
                                                                        >
                                                                                {name}
                                                                        </button>,
                                                                ])
                                                        )
                                                )
                                        )}
                                </div>
                                <span class="crumb-spacer" />
                                <button
                                        class="btn green"
                                        disabled={uploadDisabled}
                                        title="Upload files of any type"
                                        on:click={uploadFile}
                                >
                                        <Icon icon={iconUploadFile} /> Upload files
                                </button>
                                <button
                                        class="btn"
                                        disabled={folderUploadDisabled}
                                        title="Upload a whole folder"
                                        on:click={uploadFolder}
                                >
                                        <Icon icon={iconUploadFolder} /> Upload folder
                                </button>
                        </div>

                        {use(this.message, this.uploading, this.downloading, this.entries).map(
                                ([m, u, d, entries]) => {
                                        const err = m.toLowerCase().includes("fail");
                                        const text = u
                                                ? "Uploading files..."
                                                : d
                                                  ? "Packing archive..."
                                                  : m ||
                                                    `${entries.length} item${entries.length === 1 ? "" : "s"} in ${
                                                            this.components.length
                                                                    ? "/" + this.components.join("/")
                                                                    : "root storage"
                                                    }`;
                                        return <div class="fm-status" class:error={err}>{text}</div>;
                                },
                        )}

                        <div class="fm-panel">
                                <div class="fm-head">
                                        <span class="h-name">NAME</span>
                                        <span class="h-size">SIZE</span>
                                        <span class="h-actions">ACTIONS</span>
                                </div>
                                <div
                                        class="fm-entries"
                                        on:dragover={(e: DragEvent) => {
                                                e.preventDefault();
                                                this.dragging = true;
                                        }}
                                        on:dragleave={() => (this.dragging = false)}
                                        on:drop={onDrop}
                                >
                                        <div class="fm-drop-overlay" class:hidden={use(this.dragging).map((d) => !d)}>
                                                Drop files or folders to add them here
                                        </div>
                                        {use(this.entries).map((entries) =>
                                                entries.length === 0 ? (
                                                        <div class="fm-empty">
                                                                This folder is empty. Drop files here or use the upload buttons.
                                                        </div>
                                                ) : (
                                                        entries.map((x) => {
                                                                const isDir = x.entry.kind === "directory";

                                                                const open = () => {
                                                                        if (isDir) {
                                                                                this.editing = null;
                                                                                this.message = "";
                                                                                this.path = x.entry as FileSystemDirectoryHandle;
                                                                        } else {
                                                                                this.editing = x.entry as FileSystemFileHandle;
                                                                        }
                                                                };
                                                                const download = async () => {
                                                                        const blob = await (
                                                                                x.entry as FileSystemFileHandle
                                                                        ).getFile();
                                                                        const url = URL.createObjectURL(blob);
                                                                        const a = document.createElement("a");
                                                                        a.href = url;
                                                                        a.download = x.name;
                                                                        a.click();
                                                                        await new Promise((r) => setTimeout(r, 100));
                                                                        URL.revokeObjectURL(url);
                                                                };
                                                                const remove = async () => {
                                                                        if (this.editing?.name === x.name) this.editing = null;
                                                                        await this.path.removeEntry(x.name, { recursive: true });
                                                                        this.message = "Deleted " + x.name;
                                                                        this.path = this.path;
                                                                };

                                                                return (
                                                                        <div class="entry" class:dir={isDir} title={x.name} on:click={open}>
                                                                                <span class="e-icon">
                                                                                        <Icon icon={isDir ? iconFolder : iconDraft} />
                                                                                </span>
                                                                                <span class="e-name">{x.name}</span>
                                                                                <span class="e-size">{isDir ? "" : fmtSize(x.size)}</span>
                                                                                <span
                                                                                        class="e-actions"
                                                                                        on:click={(e: Event) => e.stopPropagation()}
                                                                                >
                                                                                        {!isDir ? (
                                                                                                <button class="e-act" title="Download file" on:click={download}>
                                                                                                        <Icon icon={iconDownload} />
                                                                                                </button>
                                                                                        ) : null}
                                                                                        <button class="e-act del" title="Delete" on:click={remove}>
                                                                                                <Icon icon={iconDelete} />
                                                                                        </button>
                                                                                </span>
                                                                        </div>
                                                                );
                                                        })
                                                )
                                        )}
                                </div>

                                {use(this.editing).map((file) => {
                                        if (!file) return null;

                                        const area = (
                                                <textarea aria-label={`Edit ${file.name}`} />
                                        ) as HTMLTextAreaElement;
                                        area.value = "Loading file...";
                                        file
                                                .getFile()
                                                .then((r) => r.text())
                                                .then((r) => (area.value = r));

                                        const save = async () => {
                                                const writable = await file.createWritable();
                                                await writable.write(area.value);
                                                await writable.close();
                                                this.message = "Saved " + file.name;
                                                this.editing = null;
                                        };

                                        return (
                                                <div class="fm-editor">
                                                        <div class="fm-editor-head">
                                                                <span class="fname">{file.name}</span>
                                                                <span class="crumb-spacer" />
                                                                <button class="btn green" on:click={save}>
                                                                        <Icon icon={iconSave} /> Save
                                                                </button>
                                                                <button class="icon-btn" title="Close editor" on:click={() => (this.editing = null)}>
                                                                        <Icon icon={iconClose} />
                                                                </button>
                                                        </div>
                                                        {area}
                                                </div>
                                        );
                                })}
                        </div>

                        <div class="fm-archive">
                                {archiveInput}
                                <button
                                        class="btn"
                                        disabled={use(this.uploading)}
                                        title="Extract a .tar/.tar.gz into this folder"
                                        on:click={uploadArchive}
                                >
                                        <Icon icon={iconUnarchive} /> Extract archive here
                                </button>
                                <button
                                        class="btn"
                                        disabled={downloadDisabled}
                                        title="Download this folder as a .tar/.tar.gz"
                                        on:click={downloadArchive}
                                >
                                        <Icon icon={iconArchive} /> Download folder as .tar.gz
                                </button>
                        </div>
                </div>
        );
}
OpfsExplorer.style = css`
        :scope {
                display: block;
                width: min(64rem, 94%);
        }
        .hidden {
                display: none !important;
        }

        .fm-toolbar {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                flex-wrap: wrap;
        }
        .crumb {
                display: flex;
                align-items: center;
                gap: 0.15rem;
                min-width: 0;
                flex: 1;
                flex-wrap: wrap;
                background: var(--bg-bar);
                border: 1px solid var(--line-soft);
                border-radius: 0.45rem;
                padding: 0.2rem 0.45rem;
                margin-right: 0.45rem;
        }
        .crumb-spacer {
                flex: 1;
        }
        .crumb-seg {
                background: transparent;
                border: none;
                color: var(--fg-dim);
                font-size: 0.8rem;
                font-family: var(--font-body);
                cursor: pointer;
                padding: 0.2rem 0.4rem;
                border-radius: 0.3rem;
                white-space: nowrap;
        }
        .crumb-seg:hover {
                background: var(--surface3);
                color: var(--fg);
        }
        .crumb-seg.last {
                color: var(--fg);
                font-weight: 700;
                cursor: default;
                background: var(--surface2);
        }
        .crumb-seg.last:hover {
                background: var(--surface2);
        }
        .crumb-sep {
                color: var(--fg5);
                font-size: 0.8rem;
        }

        .btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 0.4rem;
                border: none;
                cursor: pointer;
                border-radius: 0.45rem;
                font-weight: 700;
                letter-spacing: 0.04em;
                font-size: 0.8rem;
                padding: 0.55rem 1.1rem;
                transition: filter 0.2s;
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
                opacity: 0.5;
                cursor: not-allowed;
                filter: none;
        }
        .btn.green {
                background: linear-gradient(180deg, var(--mc-green-bright), var(--mc-green));
                box-shadow: inset 0 -2px 0 rgba(0, 0, 0, 0.28);
        }
        .btn :global(svg) {
                width: 1rem;
                height: 1rem;
                fill: currentColor;
        }

        .icon-btn {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 2.1rem;
                height: 2.1rem;
                border-radius: 0.45rem;
                border: none;
                background: var(--surface2);
                color: var(--fg-dim);
                cursor: pointer;
                flex: none;
                transition: background 0.2s, color 0.2s;
        }
        .icon-btn:hover:not(:disabled) {
                background: var(--surface3);
                color: var(--fg);
        }
        .icon-btn:disabled {
                opacity: 0.4;
                cursor: not-allowed;
        }
        .icon-btn :global(svg) {
                width: 1.1rem;
                height: 1.1rem;
                fill: currentColor;
        }

        .fm-status {
                display: flex;
                align-items: center;
                gap: 0.4rem;
                font-size: 0.75rem;
                color: var(--mc-green-bright);
                min-height: 1rem;
        }
        .fm-status::before {
                content: "";
                width: 0.35rem;
                height: 0.35rem;
                border-radius: 50%;
                background: var(--mc-green-bright);
                flex: none;
        }
        .fm-status.error {
                color: var(--mc-red);
        }
        .fm-status.error::before {
                background: var(--mc-red);
        }

        .fm-panel {
                background: var(--bg-sub);
                border: 1px solid var(--line-soft);
                border-radius: 0.7rem;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                min-height: 12rem;
        }
        .fm-head {
                display: flex;
                align-items: center;
                gap: 0.6rem;
                padding: 0.3rem 0.7rem 0.35rem;
                color: var(--fg5);
                font-size: 0.65rem;
                letter-spacing: 0.12em;
                border-bottom: 1px solid var(--line-soft);
        }
        .fm-head .h-name {
                flex: 1;
        }
        .fm-head .h-size {
                width: 5rem;
                text-align: right;
        }
        .fm-head .h-actions {
                width: 4.2rem;
        }
        .fm-entries {
                min-height: 7rem;
                max-height: 24rem;
                overflow-y: auto;
                position: relative;
                padding: 0.3rem;
        }
        .fm-empty {
                padding: 2rem 0;
                text-align: center;
                color: var(--fg5);
                font-size: 0.85rem;
        }
        .fm-drop-overlay {
                position: absolute;
                inset: 0.2rem;
                border: 2px dashed var(--mc-green-bright);
                border-radius: 0.5rem;
                background: rgba(0, 132, 66, 0.12);
                display: flex;
                align-items: center;
                justify-content: center;
                font-weight: 700;
                color: var(--mc-green-bright);
                font-size: 0.95rem;
                z-index: 5;
                pointer-events: none;
        }

        .entry {
                display: flex;
                align-items: center;
                gap: 0.6rem;
                height: 2.6rem;
                padding: 0 0.7rem;
                border-radius: 0.4rem;
                transition: background 0.15s;
                cursor: pointer;
        }
        .entry:hover {
                background: var(--surface3);
        }
        .e-icon {
                display: flex;
                flex: none;
                width: 1.3rem;
                height: 1.3rem;
        }
        .e-icon :global(svg) {
                width: 100%;
                height: 100%;
                fill: var(--fg-dim);
        }
        .entry.dir .e-icon :global(svg) {
                fill: var(--mc-green-bright);
        }
        .e-name {
                flex: 1;
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                font-size: 0.85rem;
        }
        .e-size {
                color: var(--fg5);
                font-size: 0.72rem;
                flex: none;
                font-family: var(--font-mono);
                width: 5rem;
                text-align: right;
        }
        .e-actions {
                display: flex;
                gap: 0.25rem;
                opacity: 0;
                transition: opacity 0.15s;
                flex: none;
                width: 4.2rem;
                justify-content: flex-end;
        }
        .entry:hover .e-actions {
                opacity: 1;
        }
        .e-act {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                width: 1.7rem;
                height: 1.7rem;
                border: none;
                border-radius: 0.35rem;
                background: transparent;
                color: var(--fg-dim);
                cursor: pointer;
        }
        .e-act :global(svg) {
                width: 0.95rem;
                height: 0.95rem;
                fill: currentColor;
        }
        .e-act:hover {
                background: var(--surface4);
                color: #fff;
        }
        .e-act.del:hover {
                background: #7a2c2c;
                color: #fff;
        }

        .fm-editor {
                border-top: 1px solid var(--line);
                background: #0a0a0a;
                display: flex;
                flex-direction: column;
        }
        .fm-editor-head {
                display: flex;
                align-items: center;
                gap: 0.6rem;
                padding: 0.45rem 0.7rem;
        }
        .fm-editor-head .fname {
                font-family: var(--font-mono);
                font-size: 0.8rem;
                color: var(--mc-green-bright);
        }
        .fm-editor textarea {
                min-height: 9rem;
                max-height: 22rem;
                resize: vertical;
                background: #111;
                color: var(--fg3);
                border: none;
                outline: none;
                font-family: var(--font-mono);
                font-size: 0.75rem;
                line-height: 1.5;
                padding: 0.7rem 0.9rem;
        }

        .fm-archive {
                display: flex;
                align-items: center;
                gap: 0.55rem;
                flex-wrap: wrap;
        }
`;
