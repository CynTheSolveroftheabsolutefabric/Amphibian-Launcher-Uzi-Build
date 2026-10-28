import type { MinecraftAuthInfo } from "./dotnet";
import type { Log } from "./dotnet/log";

// The launcher page and the game page talk over a BroadcastChannel. Both are the same origin (the game page is either
// this app opened in a normal tab, or this app inside an about:blank tab that the launcher opened), so a channel named
// after a random per-launch id reaches exactly the right pair and nothing else.
export const bridgeName = (id: string) => `amphibian-bridge-1:${id}`;

export interface GameStats {
	fps: number;
	fpsAvg: number;
	gcMemory: number;
	gcHeapMemory: number;
	nativeMemory: number;
	heapMemory: number;
	wasmMemory: number;
}

// launcher -> game
export type ToGame =
	| { type: "config"; versionId: string; auth: MinecraftAuthInfo; fullscreen: boolean }
	| { type: "status"; text: string }
	| { type: "command"; command: "threadDump" | "jitDump" };

// game -> launcher
export type ToLauncher =
	| { type: "hello" }
	| { type: "logs"; lines: Log[] }
	| { type: "stats"; stats: GameStats }
	| { type: "running" }
	| { type: "exit"; code: number | undefined }
	| { type: "failed"; message: string };
