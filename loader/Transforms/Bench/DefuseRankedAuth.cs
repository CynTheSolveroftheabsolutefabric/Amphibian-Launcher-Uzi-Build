using System;
using System.Linq;
using org.objectweb.asm;
using org.objectweb.asm.tree;

// BENCHMARK ONLY: stop MCSR Ranked's account validation from blocking startup.
//
// SocketInstance.connect() sets status AUTHENTICATING and opens a socket.io connection to the ranked
// backend. Under this wasm net bridge that connection closes abnormally -- the log ends on
//
//     Update Status: AUTHENTICATING
//     tcpws [object URL]
//     WebSocket is already in CLOSING or CLOSED state.   /  net.ts: closing -> closed -> "really closed undefined"
//
// and the status never reaches a terminal value, so the modded main screen never finishes building and the
// harness's titleReady watchdog kills the run. Every measurement arm on 2026-09-01 died this way.
//
// This rewrites connect() to `{ this.setStatus(DISCONNECTED); return; }`. DISCONNECTED is one of the mod's
// own terminal states (SocketStatus: NONE, AUTHENTICATING, CONNECTING, FAILED_AUTH, DISCONNECTED, ERROR,
// OUTDATED, BANNED, MAX_CONNECTIONS), so the UI already knows how to render it and boot proceeds offline.
// Nothing else in the mod is touched -- no anticheat, no gameplay, no packet handling.
//
// GATED, and off unless asked for: IKVM_DEFUSE_RANKED_AUTH=1. It changes what the game does, so it must
// never be on for a run whose results are meant to describe the product.
internal class DefuseRankedAuthTransform(string name, ClassWriter writer) : ClassNode(Opcodes.ASM9)
{
	private const string SocketInstance = "com.mcsrranked.client.socket.SocketInstance";
	private const string SocketInstanceInternal = "com/mcsrranked/client/socket/SocketInstance";
	private const string SocketStatusDesc = "Lcom/mcsrranked/client/socket/SocketStatus;";
	private const string ClientAuth = "com.mcsrranked.client.auth.ClientAuth";

	private readonly string className = name;

	public static bool Enabled =>
		Environment.GetEnvironmentVariable("IKVM_DEFUSE_RANKED_AUTH") == "1";

	public static IkvmClassLoaderTransformer Transformer = () => {
		return ([ClientAuth], typeof(DefuseRankedAuthTransform));
	};

	public override void visitEnd()
	{
		PatchClientAuth();
		accept(writer);
	}

	// THE ACTUAL BLOCKER. ClientAuth's constructor performs an HTTP request to the ranked auth API and
	// reads the response (readInputStream). On a healthy run that request returns 401 and the constructor
	// throws IOException, which the caller catches and logs as "Failed to create Authentication" -- boot
	// then continues offline. When the request instead HANGS, boot hangs with it, and the last thing in
	// the log is the preceding "[IKVM lazybody] recompiled=850" line.
	//
	// So the fix is not to skip authentication but to take the path the game already handles: throw
	// IOException immediately, exactly as the 401 does. The constructor must still run super() first.
	private void PatchClientAuth()
	{
		var ctor = methods.toArray().Cast<MethodNode>()
			.FirstOrDefault(x => x.name == "<init>" && x.desc == "()V");
		if (ctor == null)
		{
			Console.WriteLine("[IKVM] DefuseRankedAuth: ClientAuth.<init>()V NOT FOUND -- auth may still block");
			return;
		}
		ctor.instructions.clear();
		ctor.tryCatchBlocks?.clear();
		ctor.localVariables?.clear();
		new JavaCursor(ctor)
			.EmitALoad(0)
			.EmitMethod(Opcodes.INVOKESPECIAL, "java/lang/Object", "<init>", "()V")
			.EmitType(Opcodes.NEW, "java/io/IOException")
			.Emit(Opcodes.DUP)
			.EmitLdc("defused for benchmarking (IKVM_DEFUSE_RANKED_AUTH=1)")
			.EmitMethod(Opcodes.INVOKESPECIAL, "java/io/IOException", "<init>", "(Ljava/lang/String;)V")
			.Emit(Opcodes.ATHROW);
		Console.WriteLine("[IKVM] DefuseRankedAuth: ClientAuth.<init>() -> throw IOException (the 401 path)");
	}

	// WHY THERE IS NO LONGER A SocketInstance PATCH.
	//
	// The first version also rewrote SocketInstance.connect() to setStatus(DISCONNECTED), on the theory
	// that the socket.io connection was the thing hanging. It was not, and the patch was actively harmful:
	// connect() is on the path that CREATES ClientAuth, so short-circuiting it meant ClientAuth.<init>
	// was never called at all -- measured, the rewritten constructor's own log line never appeared -- and
	// clientAuthCompletableFuture was left to be waited on forever. The run stalled in a NEW way and
	// produced a WASM_JIT_ADMIT_FAIL that nine earlier runs had never shown.
	//
	// Letting connect() run normally and failing inside ClientAuth reproduces the exact sequence a healthy
	// run takes: connect -> createClientAuth -> <init> throws IOException -> "Failed to create
	// Authentication" -> boot continues offline.
}
