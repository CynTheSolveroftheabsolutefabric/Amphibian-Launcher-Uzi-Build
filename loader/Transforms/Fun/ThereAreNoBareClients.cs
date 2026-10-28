using System.Linq;
using org.objectweb.asm;
using org.objectweb.asm.tree;

internal class ThereAreNoBareClientsTransform(string name, ClassWriter writer) : ClassNode(Opcodes.ASM9)
{
	private static IClassMapping TargetClass()
		=> Mappings.CurrentMappings.GetClass("net.minecraft.ReportType")
		?? Mappings.CurrentMappings.GetClass("net.minecraft.CrashReport");

	public static IkvmClassLoaderTransformer Transformer = () =>
	{
		var klass = TargetClass();
		return (klass is not null ? new[] { klass.Name } : System.Array.Empty<string>(), typeof(ThereAreNoBareClientsTransform));
	};

	public override void visitEnd()
	{
		var target = TargetClass();
		var errorComment = target?.GetMethod("getErrorComment", "()Ljava/lang/String;");

		var build = methods.toArray().Cast<MethodNode>()
			.FirstOrDefault(x => x.name == errorComment && x.desc == "()Ljava/lang/String;");

		var c = new JavaCursor(build);
		c.EmitLdc("there are no bare clients\n// this crash report is from https://github.com/r58Playz/ikvmcraft");
		c.EmitAReturn();

		accept(writer);
	}
}
