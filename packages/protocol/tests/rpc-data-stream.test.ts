import { describe, expect, it } from "vitest";
import type { Bytes, Cursor } from "../src/common";
import { RpcClient } from "../src/rpc/client";
import {
  type BlockInfo,
  type FetchBlockByHashArgs,
  type FetchBlockByHashResult,
  type FetchBlockRangeArgs,
  type FetchBlockRangeResult,
  type FetchCursorArgs,
  type FetchCursorRangeArgs,
  RpcStreamConfig,
} from "../src/rpc/config";

type TestBlock = {
  blockNumber: bigint;
};

class EmptyLiveHeadConfig extends RpcStreamConfig<string, TestBlock> {
  fetchBlockRangeCalls: FetchBlockRangeArgs<string>[] = [];
  headBlock = 2n;

  headRefreshIntervalMs(): number {
    return 10;
  }

  finalizedRefreshIntervalMs(): number {
    return 10_000;
  }

  validateFilter() {
    return { valid: true as const };
  }

  async fetchCursor(args: FetchCursorArgs): Promise<BlockInfo | null> {
    if (args.blockTag === "latest") {
      return blockInfo(this.headBlock);
    }

    if (args.blockTag === "finalized") {
      return blockInfo(1n);
    }

    if (args.blockNumber !== undefined) {
      return blockInfo(args.blockNumber);
    }

    return blockInfo(blockNumberFromHash(args.blockHash ?? "0x0"));
  }

  async fetchCursorRange({
    startBlockNumber,
    endBlockNumber,
  }: FetchCursorRangeArgs): Promise<BlockInfo[]> {
    const blocks: BlockInfo[] = [];
    for (
      let blockNumber = startBlockNumber;
      blockNumber <= endBlockNumber;
      blockNumber++
    ) {
      blocks.push(blockInfo(blockNumber));
    }
    return blocks;
  }

  async fetchBlockRange(
    args: FetchBlockRangeArgs<string>,
  ): Promise<FetchBlockRangeResult<TestBlock>> {
    this.fetchBlockRangeCalls.push(args);
    await sleep(1);

    return {
      startBlock: args.startBlock,
      endBlock: args.maxBlock,
      data: [],
    };
  }

  async fetchHeaderByHash({
    blockHash,
  }: FetchBlockByHashArgs<string>): Promise<FetchBlockByHashResult<TestBlock>> {
    const blockNumber = blockNumberFromHash(blockHash);
    const info = blockInfo(blockNumber);

    return {
      blockInfo: info,
      data: {
        cursor: cursorForBlock(blockNumber - 1n),
        endCursor: cursorForBlock(blockNumber)!,
        block: { blockNumber },
      },
    };
  }
}

class MultiFilterConfig extends EmptyLiveHeadConfig {
  override async fetchBlockRange(
    args: FetchBlockRangeArgs<string>,
  ): Promise<FetchBlockRangeResult<TestBlock>> {
    this.fetchBlockRangeCalls.push(args);
    return {
      startBlock: args.startBlock,
      endBlock: args.maxBlock,
      data: [
        {
          cursor: cursorForBlock(args.startBlock - 1n),
          endCursor: cursorForBlock(args.startBlock)!,
          block:
            args.filter === "empty" ? null : { blockNumber: args.startBlock },
        },
      ],
    };
  }
}

class PendingConfig extends MultiFilterConfig {
  override async initializeRequest(): Promise<void> {}
}

/**
 * A chain that forks right after block 3:
 *
 *   1 → 2 → 3 → 4a          (original branch)
 *             ↘ 4b → 5b     (new branch, longer)
 *
 * The config serves a single block per range call so the stream cursor lags
 * behind the tracked head. That's what makes the reorg land while the head is
 * still ahead of the last processed block, with a common ancestor that is
 * exactly the last processed block.
 */
const FORK_AFTER = 3n;

class ForkAfterProcessedBlockConfig extends RpcStreamConfig<string, TestBlock> {
  rangeCalls: { startBlock: bigint; maxBlock: bigint }[] = [];
  headerByHashCalls: Bytes[] = [];
  private latestCalls = 0;
  private servedUpTo = -1n;

  // The new branch only becomes visible once the stream processed the fork
  // point, so the reorg cannot be noticed before block 3 is emitted.
  private get branch(): Branch {
    return this.servedUpTo >= FORK_AFTER ? "b" : "a";
  }

  headRefreshIntervalMs(): number {
    return 0;
  }

  finalizedRefreshIntervalMs(): number {
    return 60_000;
  }

  validateFilter() {
    return { valid: true as const };
  }

  async fetchCursor(args: FetchCursorArgs): Promise<BlockInfo | null> {
    if (args.blockTag === "finalized") {
      return forkedBlockInfo(1n, "a");
    }

    if (args.blockTag === "latest") {
      // The first call happens while the stream initializes: the tracker starts
      // at the block the client resumes from.
      if (this.latestCalls++ === 0) {
        return forkedBlockInfo(2n, "a");
      }

      return this.branch === "a"
        ? forkedBlockInfo(4n, "a")
        : forkedBlockInfo(5n, "b");
    }

    if (args.blockNumber !== undefined) {
      return forkedBlockInfo(args.blockNumber, this.branch);
    }

    const blockHash = args.blockHash ?? "0x0";
    return forkedBlockInfo(
      blockNumberFromForkedHash(blockHash),
      branchFromForkedHash(blockHash),
    );
  }

  async fetchCursorRange({
    startBlockNumber,
    endBlockNumber,
  }: FetchCursorRangeArgs): Promise<BlockInfo[]> {
    const blocks: BlockInfo[] = [];
    for (
      let blockNumber = startBlockNumber;
      blockNumber <= endBlockNumber;
      blockNumber++
    ) {
      blocks.push(forkedBlockInfo(blockNumber, this.branch));
    }
    return blocks;
  }

  async fetchBlockRange(
    args: FetchBlockRangeArgs<string>,
  ): Promise<FetchBlockRangeResult<TestBlock>> {
    this.rangeCalls.push({
      startBlock: args.startBlock,
      maxBlock: args.maxBlock,
    });

    if (args.startBlock > args.maxBlock) {
      // A real node rejects an inverted range. Stay permissive so the test
      // asserts on what the stream does, not on an RPC error.
      return { startBlock: args.startBlock, endBlock: args.maxBlock, data: [] };
    }

    const { branch } = this;
    const blockNumber = args.startBlock;
    if (blockNumber > this.servedUpTo) {
      this.servedUpTo = blockNumber;
    }

    return {
      startBlock: blockNumber,
      endBlock: blockNumber,
      data: [
        {
          cursor: forkedCursor(blockNumber - 1n, branch),
          endCursor: forkedCursor(blockNumber, branch)!,
          block: { blockNumber },
        },
      ],
    };
  }

  async fetchHeaderByHash({
    blockHash,
  }: FetchBlockByHashArgs<string>): Promise<FetchBlockByHashResult<TestBlock>> {
    this.headerByHashCalls.push(blockHash);
    const blockNumber = blockNumberFromForkedHash(blockHash);
    const branch = branchFromForkedHash(blockHash);

    return {
      blockInfo: forkedBlockInfo(blockNumber, branch),
      data: {
        cursor: forkedCursor(blockNumber - 1n, branch),
        endCursor: forkedCursor(blockNumber, branch)!,
        block: { blockNumber },
      },
    };
  }
}

describe("RpcDataStream", () => {
  it("bounds network fetches by the ending cursor", async () => {
    const config = new MultiFilterConfig();
    config.headBlock = 100n;
    const iterator = new RpcClient(config)
      .streamData(
        {
          finality: "accepted",
          filter: ["matched"],
          startingCursor: { orderKey: 1n },
        },
        { endingCursor: { orderKey: 3n } },
      )
      [Symbol.asyncIterator]();

    try {
      await iterator.next();
      expect(config.fetchBlockRangeCalls[0]).toMatchObject({
        startBlock: 2n,
        maxBlock: 3n,
      });
    } finally {
      await iterator.return?.();
    }
  });

  it("keeps response blocks aligned with multiple requested filters", async () => {
    const config = new MultiFilterConfig();
    const client = new RpcClient(config);
    const stream = client.streamData({
      finality: "accepted",
      filter: ["matched", "empty"],
      startingCursor: { orderKey: 1n },
    });
    const iterator = stream[Symbol.asyncIterator]();

    try {
      const message = await iterator.next();
      expect(message.done).toBe(false);
      expect(message.value).toMatchObject({
        _tag: "data",
        data: {
          endCursor: { orderKey: 2n },
          data: [{ blockNumber: 2n }, null],
        },
      });
      expect(config.fetchBlockRangeCalls.map((call) => call.filter)).toEqual([
        "matched",
        "empty",
      ]);
    } finally {
      await iterator.return?.();
    }
  });

  it("rejects pending finality unless the config explicitly supports it", async () => {
    const client = new RpcClient(new MultiFilterConfig());
    const iterator = client
      .streamData({
        finality: "pending",
        filter: ["logs"],
      })
      [Symbol.asyncIterator]();

    await expect(iterator.next()).rejects.toThrowError(
      "RPC stream does not support pending finality",
    );
  });

  it("emits mutable pending snapshots without advancing accepted state", async () => {
    const config = new PendingConfig();
    config.headBlock = 1n;
    let revision = 0;
    config.fetchPendingBlocks = async (filters) => ({
      revision: String(++revision),
      blocks: filters.map(() => ({ blockNumber: 2n })),
      endCursor: { orderKey: 2n },
    });
    const client = new RpcClient(config);
    const iterator = client
      .streamData({
        finality: "pending",
        filter: ["a", "b"],
        startingCursor: { orderKey: 1n },
      })
      [Symbol.asyncIterator]();

    try {
      const first = await iterator.next();
      expect(first.value).toMatchObject({
        _tag: "data",
        data: {
          cursor: { orderKey: 1n },
          endCursor: { orderKey: 2n },
          finality: "pending",
          data: [{ blockNumber: 2n }, { blockNumber: 2n }],
        },
      });
      const invalidation = await iterator.next();
      expect(invalidation.value).toEqual({
        _tag: "invalidate",
        invalidate: { cursor: { orderKey: 1n, uniqueKey: blockHash(1n) } },
      });
    } finally {
      await iterator.return?.();
    }
  });

  it("does not refetch empty accepted blocks as the live head advances", async () => {
    const config = new EmptyLiveHeadConfig();
    const client = new RpcClient(config);
    const stream = client.streamData({
      finality: "accepted",
      filter: ["logs"],
      startingCursor: { orderKey: 1n },
    });
    const iterator = stream[Symbol.asyncIterator]();

    try {
      const first = await iterator.next();

      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({
        _tag: "data",
        data: {
          endCursor: { orderKey: 2n },
          finality: "accepted",
          production: "live",
        },
      });
      expect(config.fetchBlockRangeCalls).toHaveLength(1);
      expect(config.fetchBlockRangeCalls[0]).toMatchObject({
        startBlock: 2n,
        maxBlock: 2n,
      });

      config.headBlock = 3n;
      const second = await withTimeout(iterator.next(), 1_000);

      expect(second.done).toBe(false);
      expect(second.value).toMatchObject({
        _tag: "data",
        data: {
          endCursor: { orderKey: 3n },
          finality: "accepted",
          production: "live",
        },
      });
      expect(config.fetchBlockRangeCalls).toHaveLength(2);
      expect(config.fetchBlockRangeCalls[1]).toMatchObject({
        startBlock: 2n,
        maxBlock: 3n,
      });
      await iterator.return?.();
    } finally {
      await iterator.return?.();
    }
  });

  it("resumes on the new branch when a reorg rewinds the head to the last processed block", async () => {
    const config = new ForkAfterProcessedBlockConfig();
    const client = new RpcClient(config);
    const iterator = client
      .streamData({
        finality: "accepted",
        filter: ["logs"],
        startingCursor: { orderKey: 2n },
      })
      [Symbol.asyncIterator]();

    const dataCursors: bigint[] = [];
    const invalidateCursors: (bigint | undefined)[] = [];

    try {
      while (dataCursors.length < 3) {
        const message = await withTimeout(iterator.next(), 5_000);
        if (message.done) break;

        if (message.value._tag === "data") {
          const orderKey = message.value.data.endCursor?.orderKey;
          if (orderKey !== undefined) {
            dataCursors.push(orderKey);
          }
        }

        if (message.value._tag === "invalidate") {
          invalidateCursors.push(message.value.invalidate.cursor?.orderKey);
        }
      }
    } finally {
      await iterator.return?.();
    }

    // The fork is above block 3, the last block the stream produced, so nothing
    // the client already processed changed and no invalidation is needed.
    expect(invalidateCursors).toEqual([]);
    // The head moves back to block 3 while the cursor already is at block 3, so
    // there is nothing to fetch until the chain grows again.
    expect(
      config.rangeCalls.filter((call) => call.startBlock > call.maxBlock),
    ).toEqual([]);
    // Block 3 must not be sent twice: the stream continues on the new branch.
    expect(dataCursors).toEqual([3n, 4n, 5n]);
  });
});

type Branch = "a" | "b";

function forkedBlockHash(blockNumber: bigint, branch: Branch): Bytes {
  const value = blockNumber < 0n ? 0n : blockNumber;
  // Blocks up to the fork point are shared by both branches.
  const prefix = value <= FORK_AFTER || branch === "a" ? "1" : "2";
  return `0x${prefix}${value.toString(16).padStart(63, "0")}`;
}

function forkedBlockInfo(blockNumber: bigint, branch: Branch): BlockInfo {
  return {
    blockNumber,
    blockHash: forkedBlockHash(blockNumber, branch),
    parentBlockHash: forkedBlockHash(blockNumber - 1n, branch),
  };
}

function forkedCursor(blockNumber: bigint, branch: Branch): Cursor | undefined {
  if (blockNumber < 0n) {
    return undefined;
  }

  return {
    orderKey: blockNumber,
    uniqueKey: forkedBlockHash(blockNumber, branch),
  };
}

function branchFromForkedHash(hash: Bytes): Branch {
  return hash.startsWith("0x2") ? "b" : "a";
}

function blockNumberFromForkedHash(hash: Bytes): bigint {
  return BigInt(`0x${hash.slice(3)}`);
}

function blockInfo(blockNumber: bigint): BlockInfo {
  return {
    blockNumber,
    blockHash: blockHash(blockNumber),
    parentBlockHash: blockHash(blockNumber - 1n),
  };
}

function cursorForBlock(blockNumber: bigint): Cursor | undefined {
  if (blockNumber < 0n) {
    return undefined;
  }

  return {
    orderKey: blockNumber,
    uniqueKey: blockHash(blockNumber),
  };
}

function blockHash(blockNumber: bigint): Bytes {
  const value = blockNumber < 0n ? 0n : blockNumber;
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function blockNumberFromHash(hash: Bytes): bigint {
  return BigInt(hash);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`Timed out after ${ms}ms`);
    }),
  ]);
}
