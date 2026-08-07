import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StarknetWebSocketSignal } from "../src/websocket";

describe("StarknetWebSocketSignal", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("subscribes to PRE_CONFIRMED data and accepts v0.10 subscription IDs", async () => {
    const signal = new StarknetWebSocketSignal("ws://devnet/ws", 100);
    const connected = signal.connect();
    const socket = MockWebSocket.instances[0];
    socket.open();
    await Promise.resolve();
    socket.receive({ jsonrpc: "2.0", id: 1, result: "head-subscription" });
    await Promise.resolve();
    socket.receive({ jsonrpc: "2.0", id: 2, result: "pending-subscription" });
    socket.receive({ jsonrpc: "2.0", id: 3, result: "event-subscription" });
    await connected;

    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "starknet_subscribeNewHeads",
        params: {},
      },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "starknet_subscribeNewTransactions",
        params: { finality_status: ["PRE_CONFIRMED"] },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "starknet_subscribeEvents",
        params: { finality_status: "PRE_CONFIRMED" },
      },
    ]);

    const pending = signal.wait("pending", 100);
    socket.receive({
      jsonrpc: "2.0",
      method: "starknet_subscriptionNewTransaction",
      params: {
        subscription_id: "pending-subscription",
        result: {},
      },
    });
    await expect(pending).resolves.toBeUndefined();

    signal.close();
  });

  it("rejects failed subscription acknowledgements and closes the socket", async () => {
    const signal = new StarknetWebSocketSignal("ws://devnet/ws", 100);
    const connected = signal.connect(false);
    const socket = MockWebSocket.instances[0];
    socket.open();
    await Promise.resolve();
    socket.receive({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "unsupported" },
    });

    await expect(connected).rejects.toThrow("subscription rejected");
    expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("reconnects after a remote close", async () => {
    const signal = new StarknetWebSocketSignal("ws://devnet/ws", 100);
    const first = signal.connect(false);
    const firstSocket = MockWebSocket.instances[0];
    firstSocket.open();
    await Promise.resolve();
    firstSocket.receive({ jsonrpc: "2.0", id: 1, result: "head-1" });
    await first;
    firstSocket.close();
    // The close notification wakes the current poll cycle; the following wait
    // establishes the replacement connection.
    await signal.wait("accepted", 100);

    const waiting = signal.wait("accepted", 1_000);
    const secondSocket = MockWebSocket.instances[1];
    secondSocket.open();
    await Promise.resolve();
    secondSocket.receive({ jsonrpc: "2.0", id: 2, result: "head-2" });
    await Promise.resolve();
    secondSocket.receive({
      jsonrpc: "2.0",
      method: "starknet_subscriptionNewHeads",
      params: { subscription_id: "head-2", result: {} },
    });
    await expect(waiting).resolves.toBeUndefined();
    signal.close();
  });
});

class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  readonly sent: string[] = [];

  constructor(readonly url: string) {
    super();
    MockWebSocket.instances.push(this);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  send(data: string): void {
    this.sent.push(data);
  }

  receive(payload: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify(payload) }),
    );
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}
