using System.Linq;
using org.objectweb.asm;
using org.objectweb.asm.commons;

internal class SwapNettyBackendTransform(string name, ClassWriter writer) : ClassRemapper(writer, RemapperForClass(name))
{
	// Up to 1.21.x these build their own event loop groups and name their channel classes.
	private const string McConnection = "net.minecraft.network.Connection";
	private const string McServerStatusPinger = "net.minecraft.client.multiplayer.ServerStatusPinger";
	private const string McServerConnectionListener = "net.minecraft.server.network.ServerConnectionListener";

	// 26.1+ moved both into EventLoopGroupHolder, which the classes above are handed. It holds the channel classes,
	// and each transport is an anonymous subclass ($1-$4, in declaration order) whose ioHandlerFactory() picks the
	// transport's IoHandler; every subclass gets the same remap, as only the NIO one references NioIoHandler.
	private const string McEventLoopGroupHolder = "net.minecraft.server.network.EventLoopGroupHolder";
	private const int McEventLoopGroupHolderSubclasses = 4;

	private const string NioEventLoopGroup = "io/netty/channel/nio/NioEventLoopGroup";
	private const string DefaultEventLoopGroup = "io/netty/channel/DefaultEventLoopGroup";
	private const string NioIoHandler = "io/netty/channel/nio/NioIoHandler";
	private const string LocalIoHandler = "io/netty/channel/local/LocalIoHandler";
	private const string NioSocketChannel = "io/netty/channel/socket/nio/NioSocketChannel";
	private const string IkvmWebSocketChannel = "ikvmcraft/IkvmWebSocketChannel"; // loader/java, on the game's classpath

	private static readonly string[] McEventLoopGroupHolderClasses =
		[McEventLoopGroupHolder, .. Enumerable.Range(1, McEventLoopGroupHolderSubclasses).Select(i => $"{McEventLoopGroupHolder}${i}")];

	public static IkvmClassLoaderTransformer Transformer = () => {
		string[] classes = [McConnection, McServerStatusPinger, McServerConnectionListener, .. McEventLoopGroupHolderClasses];
		// a layout's classes aren't in the other's mappings
		return (classes.Select(x => Mappings.CurrentMappings.GetClass(x)?.Name).Where(x => x != null).ToArray(), typeof(SwapNettyBackendTransform));
	};

	private static bool Is(string name, string klass) => name == Mappings.CurrentMappings.GetClass(klass)?.Name;

	private static SimpleRemapper RemapperForClass(string name)
	{
		java.util.HashMap map = [];

		if (McEventLoopGroupHolderClasses.Any(x => Is(name, x)))
		{
			map.put(NioIoHandler, LocalIoHandler);
			map.put(NioSocketChannel, IkvmWebSocketChannel);
		}
		else if (Is(name, McServerConnectionListener))
		{
			map.put(NioEventLoopGroup, DefaultEventLoopGroup);
		}
		else
		{
			if (Is(name, McConnection))
				map.put(NioEventLoopGroup, DefaultEventLoopGroup);
			map.put(NioSocketChannel, IkvmWebSocketChannel);
		}

		return new(Opcodes.ASM9, map);
	}
}
