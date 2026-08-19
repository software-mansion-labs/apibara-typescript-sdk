import type { Filter } from "@apibara/starknet";
import { describe, expect, it } from "vitest";
import type { StarknetEndpointCapabilities } from "../src/endpoint-capabilities";
import { StarknetRpcCapabilities } from "../src/rpc-capabilities";
import { StarknetRpcStream } from "../src/stream-config";

const baseline = {
  rpc: {
    ...StarknetRpcCapabilities.fromSpecVersion("0.9.0"),
    traces: false,
  },
  endpoint: {
    batch: false,
    webSocket: false,
  },
} satisfies {
  rpc: StarknetRpcCapabilities;
  endpoint: StarknetEndpointCapabilities;
};

const addressFiltering = {
  ...baseline,
  rpc: {
    ...StarknetRpcCapabilities.fromSpecVersion("0.10.2"),
    traces: false,
  },
};

describe("query-plan call counts", () => {
  it("rejects invalid cache and provider work limits", () => {
    for (const options of [
      { cacheSize: -1 },
      { blockRangeSize: 0 },
      { eventPageSize: 1.5 },
      { eventRangeSize: 0n },
    ]) {
      expect(
        () => new StarknetRpcStream({ url: "http://rpc.invalid", ...options }),
      ).toThrow();
    }
  });

  it("reports provider method drift as a capability error", async () => {
    const stream = configuredStream(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { id: number };
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "method not found" },
      });
    });

    await expect(
      stream.fetchBlockRangeMany({
        startBlock: 0n,
        maxBlock: 0n,
        force: false,
        clampAllowed: true,
        filters: [{ events: [{}] }],
      }),
    ).rejects.toThrow("capability 'starknet_getEvents'");
  });

  it("shares event discovery and one receipt block across top-level filters", async () => {
    const calls: string[] = [];
    const stream = configuredStream(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
      };
      calls.push(request.method);
      const result =
        request.method === "starknet_getEvents"
          ? {
              events: [
                {
                  block_number: 5,
                  from_address: "0xabc",
                  keys: ["0x1"],
                  data: [],
                },
              ],
            }
          : receiptBlock(5);
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    });
    const filters: Filter[] = [
      { events: [{ id: 1, address: "0xabc", keys: ["0x1"] }] },
      { events: [{ id: 2, address: "0x0abc", keys: ["0x1"] }] },
    ];

    const result = await stream.fetchBlockRangeMany({
      startBlock: 5n,
      maxBlock: 100n,
      force: false,
      clampAllowed: true,
      filters,
    });

    expect(
      calls.filter((method) => method === "starknet_getEvents"),
    ).toHaveLength(1);
    expect(
      calls.filter((method) => method === "starknet_getBlockWithReceipts"),
    ).toHaveLength(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].blocks).toHaveLength(2);
    expect(result.data[0].blocks[0]?.events[0].filterIds).toEqual([1]);
    expect(result.data[0].blocks[1]?.events[0].filterIds).toEqual([2]);
  });

  it("uses only wildcard discovery when a wildcard event filter is present", async () => {
    const eventQueries: Record<string, unknown>[] = [];
    const stream = configuredStream(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: [Record<string, unknown>];
      };
      if (request.method === "starknet_getEvents") {
        eventQueries.push(request.params[0]);
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: { events: [{ block_number: 5 }] },
        });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: receiptBlock(5, "0xdef"),
      });
    });

    const result = await stream.fetchBlockRangeMany({
      startBlock: 5n,
      maxBlock: 100n,
      force: false,
      clampAllowed: true,
      filters: [
        { events: [{ id: 1 }] },
        { events: [{ id: 2, address: "0xabc" }] },
      ],
    });

    expect(eventQueries).toHaveLength(1);
    expect(eventQueries[0]).not.toHaveProperty("address");
    expect(result.data).toHaveLength(1);
    expect(result.data[0].blocks[0]?.events[0].filterIds).toEqual([1]);
    expect(result.data[0].blocks[1]).toBeNull();
  });

  it("pushes a safe event-key superset into discovery queries", async () => {
    const eventQueries: Record<string, unknown>[] = [];
    const stream = configuredStream(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: [Record<string, unknown>];
      };
      if (request.method === "starknet_getEvents") {
        eventQueries.push(request.params[0]);
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: { events: [] },
        });
      }
      throw new Error(`Unexpected method ${request.method}`);
    });

    await stream.fetchBlockRangeMany({
      startBlock: 5n,
      maxBlock: 100n,
      force: false,
      clampAllowed: true,
      filters: [
        {
          events: [
            { address: "0xabc", keys: ["0x01", null, "0x03"] },
            { address: "0xabc", keys: ["0x02", "0x04", "0x05"] },
            { address: "0xdef", keys: ["0x06", "0x07", "0x08"] },
            { address: "0xdef", keys: ["0x09"] },
          ],
        },
      ],
    });

    expect(eventQueries).toEqual([
      expect.objectContaining({
        address: "0xabc",
        keys: [["0x1", "0x2"], [], ["0x3", "0x5"]],
      }),
      expect.objectContaining({
        address: "0xdef",
        keys: [["0x6", "0x9"]],
      }),
    ]);
  });

  it("omits key pushdown when any matching filter has no key prefix", async () => {
    const eventQueries: Record<string, unknown>[] = [];
    const stream = configuredStream(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: [Record<string, unknown>];
      };
      if (request.method === "starknet_getEvents") {
        eventQueries.push(request.params[0]);
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: { events: [] },
        });
      }
      throw new Error(`Unexpected method ${request.method}`);
    });

    await stream.fetchBlockRangeMany({
      startBlock: 5n,
      maxBlock: 100n,
      force: false,
      clampAllowed: true,
      filters: [
        {
          events: [{ address: "0xabc", keys: ["0x1"] }, { address: "0xabc" }],
        },
      ],
    });

    expect(eventQueries).toHaveLength(1);
    expect(eventQueries[0]).not.toHaveProperty("keys");
  });

  it("pushes a safe key union into merged multi-address discovery", async () => {
    const eventQueries: Record<string, unknown>[] = [];
    const stream = configuredStream(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: [Record<string, unknown>];
      };
      if (request.method === "starknet_getEvents") {
        eventQueries.push(request.params[0]);
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: { events: [] },
        });
      }
      throw new Error(`Unexpected method ${request.method}`);
    }, addressFiltering);

    await stream.fetchBlockRangeMany({
      startBlock: 5n,
      maxBlock: 100n,
      force: false,
      clampAllowed: false,
      filters: [
        {
          events: [
            { address: "0xabc", keys: ["0x1"] },
            { address: "0xdef", keys: ["0x2"] },
          ],
        },
      ],
    });

    expect(eventQueries).toEqual([
      expect.objectContaining({
        address: ["0xabc", "0xdef"],
        keys: [["0x1", "0x2"]],
      }),
    ]);
  });

  it("exhausts event pages without clamping the requested block range", async () => {
    const eventQueries: Record<string, unknown>[] = [];
    const stream = configuredStream(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: [Record<string, unknown>];
      };
      if (request.method === "starknet_getEvents") {
        eventQueries.push(request.params[0]);
        const result =
          eventQueries.length === 1
            ? {
                events: [{ block_number: 5 }],
                continuation_token: "next-page",
              }
            : { events: [{ block_number: 50_000 }] };
        return Response.json({ jsonrpc: "2.0", id: request.id, result });
      }
      const blockId = request.params[0] as { block_number: number };
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: receiptBlock(blockId.block_number),
      });
    });

    const result = await stream.fetchBlockRangeMany({
      startBlock: 5n,
      maxBlock: 50_000n,
      force: false,
      clampAllowed: true,
      filters: [{ events: [{ address: "0xabc", keys: ["0x1"] }] }],
    });

    expect(result.endBlock).toBe(50_000n);
    expect(eventQueries).toEqual([
      {
        from_block: { block_number: 5 },
        to_block: { block_number: 50_000 },
        chunk_size: 1_000,
        address: "0xabc",
        keys: [["0x1"]],
      },
      {
        from_block: { block_number: 5 },
        to_block: { block_number: 50_000 },
        chunk_size: 1_000,
        continuation_token: "next-page",
        address: "0xabc",
        keys: [["0x1"]],
      },
    ]);
    expect(result.data).toHaveLength(2);
  });

  it("loads headers, not receipt blocks, for non-candidates in a mixed filter set", async () => {
    const calls: string[] = [];
    const stream = configuredStream(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: [{ block_number?: number }];
      };
      calls.push(request.method);
      const number = request.params[0].block_number ?? 5;
      const result =
        request.method === "starknet_getEvents"
          ? { events: [{ block_number: 5 }] }
          : request.method === "starknet_getBlockWithReceipts"
            ? receiptBlock(number)
            : headerBlock(number);
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    });

    const result = await stream.fetchBlockRangeMany({
      startBlock: 5n,
      maxBlock: 100n,
      force: false,
      clampAllowed: true,
      filters: [
        { events: [{ address: "0xabc", keys: ["0x1"] }] },
        { header: "always" },
      ],
    });

    expect(result.endBlock).toBe(24n);
    expect(
      calls.filter((method) => method === "starknet_getBlockWithReceipts"),
    ).toHaveLength(1);
    expect(
      calls.filter((method) => method === "starknet_getBlockWithTxHashes"),
    ).toHaveLength(19);
    expect(result.data).toHaveLength(20);
    expect(result.data[1].blocks).toEqual([
      null,
      expect.objectContaining({ transactions: [] }),
    ]);
  });

  it("scans state filters in a bounded 20-block window", async () => {
    const calls: string[] = [];
    const stream = configuredStream(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: [{ block_number: number }];
      };
      calls.push(request.method);
      const number = request.params[0].block_number;
      const result =
        request.method === "starknet_getStateUpdate"
          ? {
              state_diff: {
                storage_diffs: [
                  {
                    address: "0xabc",
                    storage_entries: [{ key: "0x1", value: "0x2" }],
                  },
                ],
              },
            }
          : headerBlock(number);
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    });

    const result = await stream.fetchBlockRangeMany({
      startBlock: 5n,
      maxBlock: 100n,
      force: false,
      clampAllowed: true,
      filters: [
        { storageDiffs: [{ id: 1, contractAddress: "0xabc" }] },
        { nonceUpdates: [{ id: 2, contractAddress: "0xdef" }] },
      ],
    });

    expect(result.endBlock).toBe(24n);
    expect(
      calls.filter((method) => method === "starknet_getBlockWithTxHashes"),
    ).toHaveLength(20);
    expect(
      calls.filter((method) => method === "starknet_getStateUpdate"),
    ).toHaveLength(20);
    expect(result.data).toHaveLength(20);
    expect(result.data[0].blocks).toHaveLength(2);
  });

  it("isolates sequential state updates by address filter", async () => {
    const stateQueries: string[][] = [];
    const stream = configuredStream(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: [{ block_number: number }, { contract_addresses: string[] }?];
      };
      if (request.method === "starknet_getStateUpdate") {
        const addresses = request.params[1]?.contract_addresses ?? [];
        stateQueries.push(addresses);
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: stateUpdate(addresses[0]),
        });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: headerBlock(request.params[0].block_number),
      });
    }, addressFiltering);

    const first = await fetchStateBlock(stream, "0xabc");
    const second = await fetchStateBlock(stream, "0xdef");

    expect(stateQueries).toEqual([["0xabc"], ["0xdef"]]);
    expect(first.data[0].blocks[0]?.storageDiffs).toHaveLength(1);
    expect(second.data[0].blocks[0]?.storageDiffs).toHaveLength(1);
  });

  it("isolates overlapping state requests by address filter", async () => {
    const stateQueries: string[][] = [];
    let headerCalls = 0;
    let releaseSecondHeader!: () => void;
    const secondHeaderGate = new Promise<void>((resolve) => {
      releaseSecondHeader = resolve;
    });
    const stream = configuredStream(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: [{ block_number: number }, { contract_addresses: string[] }?];
      };
      if (request.method === "starknet_getStateUpdate") {
        const addresses = request.params[1]?.contract_addresses ?? [];
        stateQueries.push(addresses);
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: stateUpdate(addresses[0]),
        });
      }
      headerCalls++;
      if (headerCalls === 2) await secondHeaderGate;
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: headerBlock(request.params[0].block_number),
      });
    }, addressFiltering);

    const firstPromise = fetchStateBlock(stream, "0xabc");
    const secondPromise = fetchStateBlock(stream, "0xdef");
    await firstPromise;
    releaseSecondHeader();
    const second = await secondPromise;

    expect(stateQueries).toEqual([["0xabc"], ["0xdef"]]);
    expect(second.data[0].blocks[0]?.storageDiffs).toHaveLength(1);
  });

  it("bounds all accepted-block caches during long backfills", async () => {
    const stream = configuredStream(async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as {
        id: number;
        method: string;
        params: [{ block_number: number }];
      };
      const number = request.params[0].block_number;
      const result =
        request.method === "starknet_getStateUpdate"
          ? stateUpdate("0xabc")
          : receiptBlock(number);
      return Response.json({ jsonrpc: "2.0", id: request.id, result });
    });

    for (let start = 0n; start < 140n; start += 20n) {
      await stream.fetchBlockRangeMany({
        startBlock: start,
        maxBlock: start + 19n,
        force: false,
        clampAllowed: true,
        filters: [{ transactions: [{}], storageDiffs: [{}] }],
      });
    }

    const caches = stream as unknown as {
      headerCache: Map<bigint, unknown>;
      receiptCache: Map<bigint, unknown>;
      stateCache: Map<bigint, unknown>;
      cacheOrder: Map<bigint, unknown>;
    };
    expect(caches.headerCache.size).toBe(128);
    expect(caches.receiptCache.size).toBe(128);
    expect(caches.stateCache.size).toBe(128);
    expect(caches.cacheOrder.size).toBe(128);
    expect(caches.headerCache.has(0n)).toBe(false);
    expect(caches.headerCache.has(139n)).toBe(true);
  });

  it("applies configured cache and provider work limits", async () => {
    const eventQueries: Record<string, unknown>[] = [];
    const stream = configuredStream(
      async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          id: number;
          method: string;
          params: [Record<string, unknown>];
        };
        if (request.method === "starknet_getEvents") {
          eventQueries.push(request.params[0]);
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: { events: [] },
          });
        }
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: headerBlock(
            (request.params[0] as { block_number: number }).block_number,
          ),
        });
      },
      baseline,
      {
        cacheSize: 3,
        blockRangeSize: 3,
        eventPageSize: 17,
        eventRangeSize: 3n,
      },
    );

    await stream.fetchBlockRangeMany({
      startBlock: 0n,
      maxBlock: 9n,
      force: false,
      clampAllowed: true,
      filters: [{ events: [{}] }],
    });
    expect(eventQueries).toEqual([
      expect.objectContaining({
        from_block: { block_number: 0 },
        to_block: { block_number: 2 },
        chunk_size: 17,
      }),
      expect.objectContaining({
        from_block: { block_number: 3 },
        to_block: { block_number: 5 },
        chunk_size: 17,
      }),
      expect.objectContaining({
        from_block: { block_number: 6 },
        to_block: { block_number: 8 },
        chunk_size: 17,
      }),
      expect.objectContaining({
        from_block: { block_number: 9 },
        to_block: { block_number: 9 },
        chunk_size: 17,
      }),
    ]);

    for (let number = 0n; number < 5n; number++) {
      await stream.fetchCursor({ blockNumber: number });
    }
    const caches = stream as unknown as {
      headerCache: Map<bigint, unknown>;
      cacheOrder: Map<bigint, unknown>;
    };
    expect(caches.headerCache.size).toBe(3);
    expect(caches.cacheOrder.size).toBe(3);
    expect(caches.headerCache.has(0n)).toBe(false);
    expect(caches.headerCache.has(4n)).toBe(true);

    const uncached = configuredStream(
      async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          id: number;
          params: [{ block_number: number }];
        };
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: receiptBlock(request.params[0].block_number),
        });
      },
      baseline,
      { cacheSize: 0 },
    );
    await uncached.fetchBlockRangeMany({
      startBlock: 1n,
      maxBlock: 1n,
      force: false,
      clampAllowed: true,
      filters: [{ transactions: [{}] }],
    });
    const disabledCaches = uncached as unknown as {
      headerCache: Map<bigint, unknown>;
      receiptCache: Map<bigint, unknown>;
      cacheOrder: Map<bigint, unknown>;
    };
    expect(disabledCaches.headerCache.size).toBe(0);
    expect(disabledCaches.receiptCache.size).toBe(0);
    expect(disabledCaches.cacheOrder.size).toBe(0);
  });

  it("produces on_data_or_on_new_block headers only at the chain tip", async () => {
    // One filter matches events at block 6, so that block is fetched. The
    // second filter matches nothing there: whether it still receives the empty
    // header is what the block's production mode decides.
    const filters: Filter[] = [
      { events: [{ address: "0xabc", keys: ["0x1"] }] },
      { header: "on_data_or_on_new_block" },
    ];

    const streamWithHead = (head: number) =>
      configuredStream(async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          id: number;
          method: string;
          params: [string | { block_number?: number }];
        };
        if (request.method === "starknet_getEvents") {
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            result: { events: [{ block_number: 6 }] },
          });
        }
        const blockId = request.params[0];
        // Starknet encodes the `latest` tag as a bare string, not an object.
        const number =
          typeof blockId === "string" ? head : blockId.block_number;
        return Response.json({
          jsonrpc: "2.0",
          id: request.id,
          result: receiptBlock(number ?? head),
        });
      });

    const headerAtHead = async (head: number) => {
      const stream = streamWithHead(head);
      // The stream driver refreshes the head before requesting a range; that is
      // how the config learns where the tip is.
      await stream.fetchCursor({ blockTag: "latest" });
      const result = await stream.fetchBlockRangeMany({
        startBlock: 5n,
        maxBlock: 6n,
        force: false,
        clampAllowed: true,
        filters,
      });
      const block6 = result.data.find((item) => item.endCursor.orderKey === 6n);
      expect(block6?.blocks[0]).not.toBeNull();
      return block6?.blocks[1] ?? null;
    };

    // Block 6 is the head: the second filter receives an empty header.
    expect(await headerAtHead(6)).toMatchObject({
      header: { blockNumber: 6n },
      events: [],
    });

    // The chain has moved on, so block 6 is history and the filter is dropped.
    expect(await headerAtHead(100)).toBeNull();
  });
});

function configuredStream(
  fetchImplementation: typeof fetch,
  capabilities: {
    rpc: StarknetRpcCapabilities;
    endpoint: StarknetEndpointCapabilities;
  } = baseline,
  options: Partial<ConstructorParameters<typeof StarknetRpcStream>[0]> = {},
): StarknetRpcStream {
  const stream = new StarknetRpcStream({
    url: "http://rpc.invalid",
    fetch: fetchImplementation,
    requestsPerSecond: 10_000,
    maxConcurrency: 8,
    retryCount: 0,
    ...options,
  });
  Object.assign(stream, { capabilities });
  return stream;
}

function fetchStateBlock(stream: StarknetRpcStream, address: `0x${string}`) {
  return stream.fetchBlockRangeMany({
    startBlock: 5n,
    maxBlock: 5n,
    force: false,
    clampAllowed: true,
    filters: [{ storageDiffs: [{ contractAddress: address }] }],
  });
}

function headerBlock(number: number) {
  return {
    block_hash: `0x${(number + 1_000).toString(16)}`,
    parent_hash: `0x${(number + 999).toString(16)}`,
    block_number: number,
    timestamp: 1_700_000_000 + number,
    sequencer_address: "0x1",
    starknet_version: "0.13.6",
    transactions: [],
  };
}

function receiptBlock(number: number, eventAddress = "0xabc") {
  return {
    ...headerBlock(number),
    transactions: [
      {
        transaction: {
          type: "INVOKE",
          version: "0x1",
          transaction_hash: "0xaa",
          sender_address: "0x1",
          calldata: [],
          max_fee: "0x0",
          signature: [],
          nonce: "0x0",
        },
        receipt: {
          transaction_hash: "0xaa",
          actual_fee: { amount: "0x0", unit: "WEI" },
          execution_status: "SUCCEEDED",
          execution_resources: {},
          events: [{ from_address: eventAddress, keys: ["0x1"], data: [] }],
          messages_sent: [],
        },
      },
    ],
  };
}

function stateUpdate(address: string) {
  return {
    state_diff: {
      storage_diffs: [
        {
          address,
          storage_entries: [{ key: "0x1", value: "0x2" }],
        },
      ],
    },
  };
}
