package cli;

import java.net.SocketAddress;
import java.util.function.Consumer;

// What javac sees of the C# IkvmWebSocketConnection (IkvmNetwork.cs), which the game's class loader resolves from
// IkvmWasm.dll at runtime. Only compiled against, never put in ikvmcraft.jar: keep the signatures in sync.
public final class IkvmWebSocketConnection {
	public static IkvmWebSocketConnection Connect(SocketAddress remote, int timeoutMillis, Consumer<String> onOpen, Consumer<byte[]> onData, Consumer<String> onClosed) {
		throw new UnsupportedOperationException();
	}

	public void StartReceiving() {
		throw new UnsupportedOperationException();
	}

	public void Send(byte[] bytes) {
		throw new UnsupportedOperationException();
	}

	public void Abort() {
		throw new UnsupportedOperationException();
	}
}
