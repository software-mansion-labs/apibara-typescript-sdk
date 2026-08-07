import type { Filter } from "@apibara/starknet";
import { describe, expect, it } from "vitest";
import type { StarknetRpcBlock } from "../src/block";
import { FilterSet } from "../src/filter";
import type {
  RpcBlockWithReceipts,
  RpcObject,
  RpcReceipt,
  RpcStateUpdate,
} from "../src/rpc-types";
import { StarknetRpcMapper } from "../src/transform";

const rpcMapper = new StarknetRpcMapper();

const receiptBlock: RpcBlockWithReceipts = {
  block_hash: "0x10",
  parent_hash: "0x0f",
  block_number: 16,
  new_root: "0x20",
  timestamp: 1_700_000_000,
  sequencer_address: "0x123",
  starknet_version: "0.13.6",
  l1_gas_price: { price_in_wei: "0x1", price_in_fri: "0x2" },
  l1_data_gas_price: { price_in_wei: "0x3", price_in_fri: "0x4" },
  l2_gas_price: { price_in_wei: "0x5", price_in_fri: "0x6" },
  l1_da_mode: "BLOB",
  transactions: [
    {
      transaction: {
        type: "INVOKE",
        version: "0x1",
        transaction_hash: "0xaa",
        sender_address: "0x100",
        calldata: ["0x1"],
        max_fee: "0x2",
        signature: ["0x3"],
        nonce: "0x4",
      },
      receipt: {
        type: "INVOKE",
        transaction_hash: "0xaa",
        actual_fee: { amount: "0x5", unit: "WEI" },
        execution_status: "SUCCEEDED",
        execution_resources: {
          total_gas_consumed: {
            l1_gas: "0x6",
            l1_data_gas: "0x7",
            l2_gas: "0x8",
          },
        },
        events: [
          { from_address: "0xabc", keys: ["0x11", "0x22"], data: ["0x33"] },
          { from_address: "0xabc", keys: ["0x44"], data: [] },
        ],
        messages_sent: [
          { from_address: "0xabc", to_address: "0x99", payload: ["0x55"] },
        ],
      },
    },
    {
      transaction: {
        type: "DECLARE",
        version: "0x2",
        transaction_hash: "0xbb",
        sender_address: "0x200",
        class_hash: "0x201",
        compiled_class_hash: "0x202",
        max_fee: "0x2",
        signature: [],
        nonce: "0x1",
      },
      receipt: {
        type: "DECLARE",
        transaction_hash: "0xbb",
        actual_fee: { amount: "0x0", unit: "WEI" },
        execution_status: "REVERTED",
        revert_reason: "fixture revert",
        execution_resources: {},
        events: [{ from_address: "0xdef", keys: ["0x11"], data: [] }],
        messages_sent: [],
      },
    },
  ],
};

const stateUpdate: RpcStateUpdate = {
  block_hash: "0x10",
  state_diff: {
    storage_diffs: [
      {
        address: "0xabc",
        storage_entries: [{ key: "0x1", value: "0x2" }],
      },
    ],
    declared_classes: [{ class_hash: "0xc1", compiled_class_hash: "0xc2" }],
    deprecated_declared_classes: ["0xc3"],
    deployed_contracts: [{ address: "0xd1", class_hash: "0xd2" }],
    replaced_classes: [{ contract_address: "0xe1", class_hash: "0xe2" }],
    nonces: [{ contract_address: "0xabc", nonce: "0x9" }],
  },
};

function blockWithTransaction(
  transaction: RpcObject,
  receipt: Partial<RpcReceipt> = {},
): RpcBlockWithReceipts {
  return {
    ...receiptBlock,
    transactions: [
      {
        transaction: {
          transaction_hash: "0x1",
          signature: [],
          calldata: [],
          sender_address: "0x1",
          contract_address: "0x1",
          entry_point_selector: "0x1",
          class_hash: "0x1",
          compiled_class_hash: "0x1",
          contract_address_salt: "0x1",
          constructor_calldata: [],
          nonce: "0x0",
          max_fee: "0x0",
          resource_bounds: {
            l1_gas: { max_amount: "0x0", max_price_per_unit: "0x0" },
            l2_gas: { max_amount: "0x0", max_price_per_unit: "0x0" },
          },
          tip: "0x0",
          paymaster_data: [],
          account_deployment_data: [],
          nonce_data_availability_mode: "L1",
          fee_data_availability_mode: "L1",
          ...transaction,
        },
        receipt: {
          transaction_hash: "0x1",
          actual_fee: { amount: "0x0", unit: "WEI" },
          execution_status: "SUCCEEDED",
          execution_resources: {},
          contract_address: "0x1",
          events: [],
          messages_sent: [],
          ...receipt,
        },
      },
    ],
  };
}

function completeBlock(): StarknetRpcBlock {
  return {
    ...rpcMapper.mapReceiptBlock(receiptBlock),
    traces: [],
    ...rpcMapper.mapStateUpdate(stateUpdate),
  };
}

describe("RPC transforms and block mapping", () => {
  it("maps every transaction version in the Starknet filter vocabulary", () => {
    const variants = [
      ["INVOKE", "0x0", "invokeV0"],
      ["INVOKE", "0x1", "invokeV1"],
      ["INVOKE", "0x3", "invokeV3"],
      ["DECLARE", "0x0", "declareV0"],
      ["DECLARE", "0x1", "declareV1"],
      ["DECLARE", "0x2", "declareV2"],
      ["DECLARE", "0x3", "declareV3"],
      ["DEPLOY", "0x0", "deploy"],
      ["L1_HANDLER", "0x0", "l1Handler"],
      ["DEPLOY_ACCOUNT", "0x1", "deployAccountV1"],
      ["DEPLOY_ACCOUNT", "0x3", "deployAccountV3"],
    ] as const;
    const block: RpcBlockWithReceipts = {
      ...receiptBlock,
      transactions: variants.map(([type, version], index) => ({
        transaction: {
          type,
          version,
          transaction_hash: `0x${(index + 1).toString(16)}`,
          sender_address: "0x1",
          contract_address: "0x1",
          entry_point_selector: "0x1",
          class_hash: "0x1",
          compiled_class_hash: "0x1",
          contract_address_salt: "0x1",
          signature: [],
          calldata: [],
          constructor_calldata: [],
          nonce: "0x0",
          max_fee: "0x0",
          resource_bounds: {
            l1_gas: { max_amount: "0x0", max_price_per_unit: "0x0" },
            l2_gas: { max_amount: "0x0", max_price_per_unit: "0x0" },
          },
          tip: "0x0",
          paymaster_data: [],
          account_deployment_data: [],
          nonce_data_availability_mode: "L1",
          fee_data_availability_mode: "L1",
        },
        receipt: {
          transaction_hash: `0x${(index + 1).toString(16)}`,
          actual_fee: { amount: "0x0", unit: "WEI" },
          execution_status: "SUCCEEDED",
          execution_resources: {},
          contract_address: "0x1",
          ...(type === "L1_HANDLER"
            ? { message_hash: `0x${"11".repeat(32)}` }
            : {}),
          events: [],
          messages_sent: [],
        },
      })),
    };
    expect(
      rpcMapper
        .mapReceiptBlock(block)
        .transactions.map((transaction) => transaction.transaction._tag),
    ).toEqual(variants.map(([, , tag]) => tag));
  });

  it("preserves the required L1 handler receipt message hash", () => {
    const messageHash = "0x12";
    const mapped = rpcMapper.mapReceiptBlock(
      blockWithTransaction(
        {
          type: "L1_HANDLER",
          version: "0x0",
          nonce: "0x0",
          contract_address: "0x1",
          entry_point_selector: "0x2",
        },
        { message_hash: messageHash },
      ),
    );
    const receipt = mapped.receipts[0].receipt;
    expect(receipt._tag).toBe("l1Handler");
    if (receipt._tag !== "l1Handler") {
      throw new Error("Expected an L1 handler receipt");
    }
    expect(receipt.l1Handler.messageHash).toEqual(
      Uint8Array.from({ length: 32 }, (_, index) => (index === 31 ? 0x12 : 0)),
    );
  });

  it("rejects unknown transaction types and unsupported versions", () => {
    const invalidTransactions: [RpcObject, string][] = [
      [
        { type: "FUTURE_TRANSACTION", version: "0x0" },
        "Unsupported transaction type: FUTURE_TRANSACTION",
      ],
      [
        { type: "INVOKE", version: "0x2" },
        "Unsupported INVOKE transaction version: 0x2",
      ],
      [
        {
          type: "INVOKE",
          version: "0x100000000000000000000000000000001",
        },
        "Unsupported INVOKE transaction version: 0x100000000000000000000000000000001",
      ],
      [
        { type: "DECLARE", version: "0x4" },
        "Unsupported DECLARE transaction version: 0x4",
      ],
      [
        { type: "DEPLOY_ACCOUNT", version: "0x2" },
        "Unsupported DEPLOY_ACCOUNT transaction version: 0x2",
      ],
      [
        { type: "DEPLOY", version: "0x1" },
        "Unsupported DEPLOY transaction version: 0x1",
      ],
      [
        { type: "L1_HANDLER", version: "0x1" },
        "Unsupported L1_HANDLER transaction version: 0x1",
      ],
      [{ type: "INVOKE", version: "1" }, "Invalid transaction version: 1"],
      [{ type: "INVOKE" }, "Invalid transaction version: undefined"],
    ];

    for (const [transaction, message] of invalidTransactions) {
      expect(() =>
        rpcMapper.mapReceiptBlock(blockWithTransaction(transaction)),
      ).toThrow(message);
    }
  });

  it("rejects unknown receipt execution statuses", () => {
    for (const executionStatus of ["PENDING", undefined]) {
      expect(() =>
        rpcMapper.mapReceiptBlock(
          blockWithTransaction(
            { type: "INVOKE", version: "0x1" },
            { execution_status: executionStatus },
          ),
        ),
      ).toThrow(`Unknown receipt execution status: ${String(executionStatus)}`);
    }
  });

  it("rejects missing or malformed L1 handler receipt message hashes", () => {
    for (const messageHash of [
      undefined,
      "not-hex",
      `0x${"11".repeat(33)}`,
    ] as const) {
      expect(() =>
        rpcMapper.mapReceiptBlock(
          blockWithTransaction(
            { type: "L1_HANDLER", version: "0x0" },
            { message_hash: messageHash },
          ),
        ),
      ).toThrow("Invalid message_hash");
    }
  });

  it("rejects missing required transaction and receipt fields", () => {
    const malformed: [RpcObject, Partial<RpcReceipt>, string][] = [
      [
        { type: "INVOKE", version: "0x1", sender_address: undefined },
        {},
        "Invalid sender_address",
      ],
      [
        { type: "INVOKE", version: "0x1", calldata: undefined },
        {},
        "Invalid calldata",
      ],
      [
        { type: "DECLARE", version: "0x2", compiled_class_hash: undefined },
        {},
        "Invalid compiled_class_hash",
      ],
      [
        { type: "INVOKE", version: "0x3", resource_bounds: undefined },
        {},
        "Invalid resource_bounds",
      ],
      [
        { type: "INVOKE", version: "0x1" },
        { actual_fee: undefined },
        "Invalid actual_fee",
      ],
      [
        { type: "INVOKE", version: "0x1" },
        { execution_resources: undefined },
        "Invalid execution_resources",
      ],
    ];

    for (const [transaction, receipt, message] of malformed) {
      expect(() =>
        rpcMapper.mapReceiptBlock(blockWithTransaction(transaction, receipt)),
      ).toThrow(message);
    }
  });

  it("derives stable block-global ordering and RPC gas resources", () => {
    const block = completeBlock();
    expect(block.header).toMatchObject({
      blockHash: felt("10"),
      blockNumber: 16n,
      l1DataAvailabilityMode: "blob",
    });
    expect(block.events.map((event) => event.eventIndex)).toEqual([0, 1, 2]);
    expect(block.events.map((event) => event.eventIndexInTransaction)).toEqual([
      0, 1, 0,
    ]);
    expect(block.receipts[0].meta.executionResources).toEqual({
      l1Gas: 6n,
      l1DataGas: 7n,
      l2Gas: 8n,
    });
    expect(block.receipts[1].meta.executionResult).toEqual({
      _tag: "reverted",
      reverted: { reason: "fixture revert" },
    });
    expect(block.contractChanges).toHaveLength(4);
  });

  it("matches strict keys/status and deduplicates related resources", () => {
    const filter: Filter = {
      header: "on_data",
      events: [
        {
          id: 10,
          address: "0x0abc",
          keys: ["0x11"],
          includeTransaction: true,
          includeReceipt: true,
          includeMessages: true,
          includeSiblings: true,
        },
        {
          id: 11,
          address: "0xabc",
          keys: ["0x11", "0x22"],
          strict: true,
          includeTransaction: true,
        },
        {
          id: 12,
          keys: ["0x11"],
          transactionStatus: "reverted",
        },
      ],
    };
    const [projected] = new FilterSet()
      .add(filter)
      .createBlockMapper()
      .map(completeBlock(), "backfill");
    expect(projected).not.toBeNull();
    if (!projected) throw new Error("Expected filter to match the block");
    expect(projected.transactions).toHaveLength(1);
    expect(projected.transactions[0].filterIds).toEqual([10, 11]);
    expect(projected.receipts).toHaveLength(1);
    expect(projected.messages).toHaveLength(1);
    expect(projected.events).toHaveLength(3);
    expect(projected.events[0].filterIds).toEqual([10, 11]);
    expect(projected.events[1].filterIds).toEqual([10]);
    expect(projected.events[2].filterIds).toEqual([12]);
  });

  it("joins traces by hash and maps invocation order to global indices", () => {
    const block = completeBlock();
    const traces = rpcMapper.mapTraces(
      [
        {
          transaction_hash: "0xbb",
          trace_root: {
            type: "DECLARE",
            validate_invocation: {
              contract_address: "0x1",
              entry_point_selector: "0x2",
              calldata: [],
              caller_address: "0x3",
              class_hash: "0x4",
              call_type: "CALL",
              result: [],
              calls: [],
              events: [{ order: 0, keys: [], data: [] }],
              messages: [],
            },
          },
        },
      ],
      block.transactions,
      block.events,
      block.messages,
    );
    expect(traces).toHaveLength(1);
    expect(
      traces[0].traceRoot._tag === "declare"
        ? traces[0].traceRoot.declare.validateInvocation?.events
        : undefined,
    ).toEqual([2]);

    const [projected] = new FilterSet()
      .add({
        events: [
          {
            id: 50,
            address: "0xdef",
            transactionStatus: "reverted",
            includeTransactionTrace: true,
          },
        ],
      })
      .createBlockMapper()
      .map({ ...block, traces }, "backfill");
    expect(projected?.traces[0].filterIds).toEqual([50]);
  });

  it("maps filters by position and snapshots the filter set", () => {
    const filter: Filter = {
      header: "on_data",
      events: [{ address: "0xffff" }],
    };
    const filters = new FilterSet().add(filter);
    const firstMapper = filters.createBlockMapper();

    filters.add({ header: "always" });
    const secondMapper = filters.createBlockMapper();

    expect(firstMapper.map(completeBlock(), "backfill")).toEqual([null]);
    const mapped = secondMapper.map(completeBlock(), "backfill");
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toBeNull();
    expect(mapped[1]).toMatchObject({
      events: [],
      transactions: [],
    });
  });

  it("includes unmatched headers according to production mode", () => {
    const mapper = new FilterSet()
      .add({
        header: "on_data",
        events: [{ address: "0xffff" }],
      })
      .add({
        header: "on_data_or_on_new_block",
        events: [{ address: "0xffff" }],
      })
      .add({
        header: "always",
        events: [{ address: "0xffff" }],
      })
      .createBlockMapper();
    const block = completeBlock();

    const backfill = mapper.map(block, "backfill");
    expect(backfill[0]).toBeNull();
    expect(backfill[1]).toBeNull();
    expect(backfill[2]?.header).toEqual(block.header);

    const live = mapper.map(block, "live");
    expect(live[0]).toBeNull();
    expect(live[1]?.header).toEqual(block.header);
    expect(live[2]?.header).toEqual(block.header);
  });
});

function felt(value: string): `0x${string}` {
  return `0x${value.padStart(64, "0")}`;
}
