package ikvmcraft;

import cli.IkvmWebSocketConnection;
import io.netty.buffer.ByteBuf;
import io.netty.channel.AbstractChannel;
import io.netty.channel.ChannelConfig;
import io.netty.channel.ChannelMetadata;
import io.netty.channel.ChannelOutboundBuffer;
import io.netty.channel.ChannelPipeline;
import io.netty.channel.ChannelPromise;
import io.netty.channel.DefaultChannelConfig;
import io.netty.channel.EventLoop;
import io.netty.channel.RecvByteBufAllocator;
import io.netty.util.ReferenceCountUtil;
import java.io.IOException;
import java.net.ConnectException;
import java.net.SocketAddress;
import java.nio.channels.ClosedChannelException;
import java.util.ArrayDeque;

// Netty channel for the MC game connection, swapped in for NioSocketChannel by SwapNettyBackendTransform. It's
// push/async: inbound chunks are pumped off the WebSocket and posted onto the event loop, outbound writes are queued
// to a serialized send pump. The WebSocket is IkvmWebSocketConnection's (IkvmNetwork.cs). This half is Java so that it
// links against whichever netty the game ships, where a C# subclass would be bound to the netty IkvmWasm was compiled
// against; it's compiled against 4.1.25, the oldest Minecraft ships, and only uses API that 4.2 still has.
public final class IkvmWebSocketChannel extends AbstractChannel {
	private static final ChannelMetadata METADATA = new ChannelMetadata(false);
	private static final int MAX_READER_STACK_DEPTH = 8;

	private final ChannelConfig config = new DefaultChannelConfig(this);
	private final Runnable readTask = this::runReadTask;
	private final ArrayDeque<ByteBuf> inboundBuffer = new ArrayDeque<>();

	private SocketAddress remote;
	private SocketAddress local;

	private IkvmWebSocketConnection connection;

	private volatile boolean open = true;
	private volatile boolean active;
	private boolean readInProgress;
	private int readerDepth;

	public IkvmWebSocketChannel() {
		super(null);
	}

	@Override
	public ChannelMetadata metadata() {
		return METADATA;
	}

	@Override
	public ChannelConfig config() {
		return config;
	}

	@Override
	public boolean isOpen() {
		return open;
	}

	@Override
	public boolean isActive() {
		return active;
	}

	@Override
	protected AbstractUnsafe newUnsafe() {
		return new WispUnsafe();
	}

	// Accept any event loop (Default/Local/Nio/Oio); we drive everything off WebSocket callbacks.
	@Override
	protected boolean isCompatible(EventLoop loop) {
		return true;
	}

	@Override
	protected SocketAddress localAddress0() {
		return local;
	}

	@Override
	protected SocketAddress remoteAddress0() {
		return remote;
	}

	@Override
	protected void doBind(SocketAddress local) {
		this.local = local;
	}

	@Override
	protected void doDisconnect() {
		doClose();
	}

	@Override
	protected void doClose() {
		active = false;
		open = false;
		IkvmWebSocketConnection connection = this.connection;
		this.connection = null;
		if (connection != null)
			connection.Abort(); // non-blocking; a graceful close handshake would stall the loop
		ByteBuf buf;
		while ((buf = inboundBuffer.poll()) != null)
			ReferenceCountUtil.safeRelease(buf);
	}

	@Override
	protected void doBeginRead() {
		if (readInProgress || !active)
			return;
		if (inboundBuffer.isEmpty()) {
			readInProgress = true;
			return;
		}
		deliverInbound();
	}

	@Override
	protected void doWrite(ChannelOutboundBuffer outboundBuffer) {
		IkvmWebSocketConnection connection = this.connection;
		for (;;) {
			Object msg = outboundBuffer.current();
			if (msg == null)
				break;

			if (msg instanceof ByteBuf) {
				ByteBuf buf = (ByteBuf) msg;
				int len = buf.readableBytes();
				if (len > 0 && connection != null) {
					byte[] bytes = new byte[len];
					buf.getBytes(buf.readerIndex(), bytes);
					// Handed to the async send pump; the write promise completes optimistically.
					// (No netty-level write backpressure -- fine for MC's modest packet volume.)
					connection.Send(bytes);
				}
				outboundBuffer.remove();
			} else {
				// MC only writes ByteBufs at this stage; reject anything unexpected.
				outboundBuffer.remove(new UnsupportedOperationException("unsupported message type"));
			}
		}
	}

	private void runOnLoop(Runnable task) {
		EventLoop loop = eventLoop();
		if (loop.inEventLoop())
			task.run();
		else
			loop.execute(task);
	}

	// --- IkvmWebSocketConnection's callbacks, from whichever thread finished the I/O ---

	private void onInbound(byte[] chunk) {
		runOnLoop(() -> readInbound(chunk));
	}

	private void onInboundClosed(String error) {
		runOnLoop(() -> closeInbound(error));
	}

	// --- on the event loop ---

	private void readInbound(byte[] chunk) {
		if (!active)
			return;
		ByteBuf buf = config.getAllocator().buffer(chunk.length);
		buf.writeBytes(chunk);

		inboundBuffer.add(buf);
		if (readInProgress) {
			readInProgress = false;
			deliverInbound();
		}
	}

	private void closeInbound(String error) {
		if (!open)
			return;
		// Surface a failure to the pipeline, then close (fires channelInactive -> MC disconnect).
		if (error != null)
			pipeline().fireExceptionCaught(new IOException(error));
		unsafe().close(unsafe().voidPromise());
	}

	private void runReadTask() {
		if (!active || inboundBuffer.isEmpty())
			return;
		readFromBuffer();
	}

	// Bounce off the stack via the event loop if fireChannelRead re-enters us too deeply.
	private void deliverInbound() {
		if (readerDepth >= MAX_READER_STACK_DEPTH) {
			eventLoop().execute(readTask);
			return;
		}
		readerDepth++;
		try {
			readFromBuffer();
		} finally {
			readerDepth--;
		}
	}

	private void readFromBuffer() {
		RecvByteBufAllocator.Handle handle = unsafe().recvBufAllocHandle();
		handle.reset(config);
		ChannelPipeline pipeline = pipeline();
		do {
			ByteBuf received = inboundBuffer.poll();
			if (received == null)
				break;
			int n = received.readableBytes();
			handle.attemptedBytesRead(n);
			handle.lastBytesRead(n);
			handle.incMessagesRead(1);
			pipeline.fireChannelRead(received);
		} while (handle.continueReading());
		handle.readComplete();
		pipeline.fireChannelReadComplete();
	}

	private final class WispUnsafe extends AbstractUnsafe {
		@Override
		public void connect(SocketAddress remoteAddress, SocketAddress localAddress, ChannelPromise promise) {
			if (!promise.setUncancellable() || !ensureOpen(promise))
				return;

			try {
				if (localAddress != null)
					local = localAddress;
				remote = remoteAddress;

				connection = IkvmWebSocketConnection.Connect(remoteAddress, config.getConnectTimeoutMillis(),
					failure -> runOnLoop(() -> finishConnect(failure, promise)),
					IkvmWebSocketChannel.this::onInbound,
					IkvmWebSocketChannel.this::onInboundClosed);
			} catch (Throwable t) {
				promise.tryFailure(annotateConnectException(new ConnectException(t.getMessage()), remoteAddress));
				closeIfClosed();
			}
		}

		private void finishConnect(String failure, ChannelPromise promise) {
			if (!isOpen()) {
				// Closed while the handshake was in flight, which aborted it.
				promise.tryFailure(new ClosedChannelException());
				return;
			}

			if (failure != null) {
				promise.tryFailure(annotateConnectException(new ConnectException(failure), remote));
				close(voidPromise());
				return;
			}

			boolean wasActive = active;
			active = true;
			boolean promiseSet = promise.trySuccess();
			if (!wasActive)
				pipeline().fireChannelActive();
			// begin pumping inbound chunks only after channelActive, unless that closed us
			IkvmWebSocketConnection connection = IkvmWebSocketChannel.this.connection;
			if (connection != null)
				connection.StartReceiving();
			if (!promiseSet)
				close(voidPromise());
		}
	}
}
