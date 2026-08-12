import { afterEach, describe, expect, it, vi } from "vitest";
import { StarknetEndpointCapabilities } from "../src/endpoint-capabilities";
import {
  StarknetRpcCapabilities,
  parseSpecVersion,
} from "../src/rpc-capabilities";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseSpecVersion", () => {
  it("parses supported version spellings", () => {
    expect(parseSpecVersion("0.9.0")).toMatchObject({
      major: 0,
      minor: 9,
      patch: 0,
    });
    expect(parseSpecVersion("v0.10.2")).toMatchObject({
      major: 0,
      minor: 10,
      patch: 2,
    });
  });

  it("rejects non-version responses", () => {
    expect(() => parseSpecVersion("Pathfinder")).toThrow(
      "Invalid starknet_specVersion",
    );
    expect(() => parseSpecVersion("0.10.2 Pathfinder")).toThrow(
      "Invalid starknet_specVersion",
    );
    expect(() => parseSpecVersion("0.10")).toThrow(
      "Invalid starknet_specVersion",
    );
  });
});

describe("StarknetRpcCapabilities", () => {
  it("derives standardized methods and subscriptions from the version", () => {
    expect(StarknetRpcCapabilities.fromSpecVersion("0.8.1")).toMatchObject({
      blockWithReceipts: true,
      stateUpdates: true,
      traces: true,
      subscriptions: {
        newHeads: true,
        newTransactions: false,
        transactionStatus: true,
        events: true,
      },
    });
    expect(
      StarknetRpcCapabilities.fromSpecVersion("0.9.0").subscriptions
        .newTransactions,
    ).toBe(true);
  });

  it("derives features at their spec introduction versions", () => {
    expect(StarknetRpcCapabilities.fromSpecVersion("0.10.0")).toMatchObject({
      multiAddressEvents: false,
      stateAddressFiltering: false,
    });
    expect(StarknetRpcCapabilities.fromSpecVersion("0.10.1")).toMatchObject({
      multiAddressEvents: true,
      stateAddressFiltering: true,
    });
  });
});

describe("capability probes", () => {
  it("constructs RPC and endpoint capabilities through their objects", async () => {
    const requests: unknown[] = [];
    const authorizations: (string | null)[] = [];
    const fetchImplementation: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as
        | { id: number; method: string }
        | { id: number; method: string }[];
      requests.push(body);
      authorizations.push(new Headers(init?.headers).get("authorization"));

      if (Array.isArray(body)) {
        return Response.json(
          body.map((request) => ({
            jsonrpc: "2.0",
            id: request.id,
            result:
              request.method === "starknet_specVersion" ? "0.10.2" : "SN_MAIN",
          })),
        );
      }
      return Response.json({
        jsonrpc: "2.0",
        id: body.id,
        result:
          body.method === "starknet_specVersion"
            ? "0.10.2"
            : { block_hash: "0x1" },
      });
    };
    const [rpc, endpoint] = await Promise.all([
      StarknetRpcCapabilities.probe("http://rpc.invalid", {
        fetch: fetchImplementation,
        headers: { authorization: "Bearer probe" },
      }),
      StarknetEndpointCapabilities.probe("http://rpc.invalid", undefined, {
        fetch: fetchImplementation,
        headers: { authorization: "Bearer probe" },
      }),
    ]);
    expect(rpc).toMatchObject({
      specVersion: "0.10.2",
      blockWithReceipts: true,
      stateUpdates: true,
      traces: true,
    });
    expect(endpoint).toMatchObject({
      batch: true,
      webSocket: false,
    });
    expect(requests).toHaveLength(2);
    expect(authorizations).toEqual(["Bearer probe", "Bearer probe"]);
  });
});
