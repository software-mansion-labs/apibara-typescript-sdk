import type { StreamDataRequest, StreamDataResponse } from "@apibara/protocol";
import { RpcClient } from "@apibara/protocol/rpc";
import type { Filter } from "@apibara/starknet";
import { describe, expect, it } from "vitest";
import type { StarknetRpcBlock } from "../src/block";
import { StarknetRpcStream } from "../src/stream-config";
import { DevnetControl } from "./support/devnet";
import { getDevnetUrl, getDevnetWsUrl } from "./support/live-endpoints";

/**
 * WebSocket behavior against a controllable starknet-devnet.
 *
 * Public nodes cannot guarantee that a block or pending transaction arrives
 * during a short test. Devnet lets each test subscribe first and then trigger
 * the exact notification it expects.
 */

const devnetUrl = getDevnetUrl();
const devnetWsUrl = getDevnetWsUrl();

type NewHead = { blockNumber: number; blockHash: string };

function nextNewHeadAfter(
  wsUrl: string,
  trigger: () => Promise<unknown>,
  timeoutMs = 5_000,
): Promise<NewHead> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl);
    let subscriptionId: string | undefined;
    let settled = false;

    const settle = (result: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      result();
    };
    const fail = (error: unknown) =>
      settle(() =>
        reject(error instanceof Error ? error : new Error(String(error))),
      );
    const timer = setTimeout(
      () => fail(new Error("no deterministic newHeads notification in time")),
      timeoutMs,
    );

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "starknet_subscribeNewHeads",
          params: {},
        }),
      );
    });
    socket.addEventListener("error", () =>
      fail(new Error("WebSocket upgrade/connection failed")),
    );
    socket.addEventListener("message", (event) => {
      let message: {
        id?: number;
        result?: unknown;
        error?: { message?: string };
        params?: {
          subscription_id?: unknown;
          subscription?: unknown;
          result?: { block_number?: number; block_hash?: string };
        };
      };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (message.id === 1) {
        if (message.error) {
          fail(new Error(message.error.message ?? "subscription failed"));
          return;
        }
        subscriptionId = String(message.result);
        void trigger().catch(fail);
        return;
      }

      const notificationId =
        message.params?.subscription_id ?? message.params?.subscription;
      const blockNumber = message.params?.result?.block_number;
      const blockHash = message.params?.result?.block_hash;
      if (
        String(notificationId) === subscriptionId &&
        typeof blockNumber === "number" &&
        typeof blockHash === "string"
      ) {
        settle(() => resolve({ blockNumber, blockHash }));
      }
    });
  });
}

/** Reaches into the private WS signal to close it after a test (no leak). */
function closeStreamSocket(stream: StarknetRpcStream): void {
  stream.close();
}

async function nextPendingData(
  iterator: AsyncIterator<StreamDataResponse<StarknetRpcBlock>>,
  predicate: (block: StarknetRpcBlock | null) => boolean,
): Promise<Extract<StreamDataResponse<StarknetRpcBlock>, { _tag: "data" }>> {
  for (;;) {
    const next = await iterator.next();
    if (next.done) throw new Error("pending stream ended unexpectedly");
    const message = next.value;
    if (
      message._tag === "data" &&
      message.data.finality === "pending" &&
      predicate(message.data.data[0] ?? null)
    ) {
      return message;
    }
  }
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`operation did not complete within ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(!devnetUrl || !devnetWsUrl)(
  "Starknet RPC WebSocket (devnet)",
  () => {
    it("delivers a newHeads notification for a block created on demand", async () => {
      const devnet = new DevnetControl(devnetUrl!);
      await devnet.restart();

      let blockCreation: Promise<string> | undefined;
      const head = await nextNewHeadAfter(devnetWsUrl!, () => {
        blockCreation = devnet.createBlock();
        return blockCreation;
      });

      expect(head.blockNumber).toBe(1);
      expect(head.blockHash).toBe(await blockCreation);
      expect(await devnet.blockNumber()).toBe(1);
    });

    it("wakes a pending stream when an on-demand transaction arrives", async () => {
      const devnet = new DevnetControl(devnetUrl!);
      await devnet.restart();
      await devnet.acceptOnL1(0);

      const stream = new StarknetRpcStream({
        url: devnetUrl!,
        wsUrl: devnetWsUrl!,
        requestsPerSecond: 50,
        maxConcurrency: 8,
        timeout: 5_000,
        // A polling fallback cannot satisfy the 5s test deadline; the
        // PRE_CONFIRMED WebSocket notification must wake the stream.
        headRefreshIntervalMs: 60_000,
        pendingDebounceMs: 25,
      });
      const client = new RpcClient<Filter, StarknetRpcBlock>(stream);
      const controller = new AbortController();
      const request: StreamDataRequest<Filter> = {
        finality: "pending",
        filter: [
          {
            header: "always",
            events: [{ includeTransaction: true }],
          },
        ],
        startingCursor: { orderKey: 0n },
      };

      const iterator = client
        .streamData(request, { signal: controller.signal })
        [Symbol.asyncIterator]();
      const stop = () => {
        controller.abort();
        closeStreamSocket(stream);
      };
      try {
        await within(
          nextPendingData(iterator, () => true),
          5_000,
          stop,
        );
        await devnet.mint("0x1", 1_000_000_000_000_000_000);
        const updated = await within(
          nextPendingData(
            iterator,
            (block) => (block?.transactions.length ?? 0) > 0,
          ),
          5_000,
          stop,
        );
        expect(updated.data.endCursor?.uniqueKey).toBeUndefined();
      } finally {
        stop();
        await iterator.return?.();
      }
    }, 15_000);
  },
);
