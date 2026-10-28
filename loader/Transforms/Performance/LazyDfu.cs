using System;
using System.Linq;
using org.objectweb.asm;
using org.objectweb.asm.tree;

// LazyDFU (astei/lazydfu), generalized to every Minecraft version it was ever useful for.
//
// The mod's job is to stop Minecraft from eagerly precompiling all DataFixerUpper
// rewrite rules on startup and instead let them compile lazily on first use. Over the
// mod's life Mojang reshaped the DFU DataFixerBuilder API three times, so lazydfu itself
// shipped two different mechanisms (a Schemas `new DataFixerBuilder` redirect, then a
// SharedConstants.enableDataFixerOptimizations no-op). Both hook Minecraft classes and so
// are mapping- and version-specific.
//
// Instead we patch com.mojang.datafixers.DataFixerBuilder (and its Result inner class)
// directly. DFU ships as an unshaded, unobfuscated library, so no MC mappings are needed
// and the same transform works for whatever version the version dropdown selects. We
// simply detect which era's API is present on the class being loaded and patch that one:
//
//   Era 1  (MC ~1.14 – 1.17.x): `DataFixer build(Executor)` builds the DataFixerUpper and
//           then loops submitting precompile tasks to the executor. -> cut the method short
//           right after the DataFixerUpper is constructed (the old RemoveDfuPreload trick).
//   Era 2  (MC ~1.18 – 1.20.4): `build(Executor)` was split into `buildUnoptimized()` and
//           `buildOptimized(Set, Executor)`; Minecraft chooses between them based on
//           SharedConstants.enableDataFixerOptimizations(). -> rewrite buildOptimized to
//           just delegate to buildUnoptimized(), so no caller (flag or not) can precompile.
//   Era 3  (MC 1.20.5+): `build()` returns a Result; `Result.optimize(Set, Executor)` does
//           the precompilation. -> neuter optimize() to return an already-completed future.
//
// Only the class that actually gets loaded is transformed, and each era's markers are
// mutually exclusive, so exactly one branch fires per version.
internal class LazyDfuTransform(string name, ClassWriter writer) : ClassNode(Opcodes.ASM9)
{
	private const string DataFixerBuilder = "com.mojang.datafixers.DataFixerBuilder";
	private const string DataFixerBuilderResult = "com.mojang.datafixers.DataFixerBuilder$Result";
	private const string OldBuildDesc = "(Ljava/util/concurrent/Executor;)Lcom/mojang/datafixers/DataFixer;";

	private readonly string className = name;

	public static IkvmClassLoaderTransformer Transformer = () => {
		return ([DataFixerBuilder, DataFixerBuilderResult], typeof(LazyDfuTransform));
	};

	public override void visitEnd()
	{
		if (className == DataFixerBuilderResult)
			PatchResult();
		else
			PatchBuilder();

		accept(writer);
	}

	private MethodNode Method(string methodName, string desc = null) =>
		methods.toArray().Cast<MethodNode>()
			.FirstOrDefault(x => x.name == methodName && (desc == null || x.desc == desc));

	private void PatchBuilder()
	{
		var buildUnoptimized = Method("buildUnoptimized");
		var buildOptimized = Method("buildOptimized");

		// Era 2: make `buildOptimized(...)` a straight `return this.buildUnoptimized();`.
		if (buildUnoptimized != null && buildOptimized != null)
		{
			ReplaceBody(buildOptimized, c => c
				.EmitALoad(0)
				.EmitMethod(Opcodes.INVOKEVIRTUAL, className.Replace(".", "/"), "buildUnoptimized", buildUnoptimized.desc)
				.EmitAReturn());
			return;
		}

		// Era 1: truncate `build(Executor)` right after the DataFixerUpper is built and
		// reloaded (`new DataFixerUpper(...)` -> astore fixer -> aload fixer for the loop),
		// turning everything after it — the precompile loop — into dead code.
		var build = Method("build", OldBuildDesc);
		if (build == null)
			return;

		var c = new JavaCursor(build);
		if (c.TryGotoNext(
			JavaMoveType.After,
			JavaMatch.InvokeSpecial(),
			JavaMatch.AStore(out var dfuLocal),
			JavaMatch.ALoad(dfuLocal)))
		{
			c.EmitAReturn();
		}
	}

	// Era 3: `Result.optimize(...)` -> `return CompletableFuture.completedFuture(null);`,
	// so callers that join/chain on it still see a finished future but no work is scheduled.
	private void PatchResult()
	{
		var optimize = Method("optimize");
		if (optimize == null)
			return;

		ReplaceBody(optimize, c => c
			.Emit(Opcodes.ACONST_NULL)
			.EmitMethod(Opcodes.INVOKESTATIC, "java/util/concurrent/CompletableFuture", "completedFuture",
				"(Ljava/lang/Object;)Ljava/util/concurrent/CompletableFuture;")
			.EmitAReturn());
	}

	// Wipe a method body (and the label-referencing metadata that would otherwise dangle)
	// and re-emit it from scratch. COMPUTE_FRAMES/COMPUTE_MAXS recomputes frames and maxs.
	private static void ReplaceBody(MethodNode method, Action<JavaCursor> emit)
	{
		method.instructions.clear();
		method.tryCatchBlocks?.clear();
		method.localVariables?.clear();
		emit(new JavaCursor(method));
	}
}
