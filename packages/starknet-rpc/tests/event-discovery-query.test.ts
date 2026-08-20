import type { EventFilter } from "@apibara/starknet";
import { describe, expect, it } from "vitest";
import { EventDiscoveryQueryBuilder } from "../src/event-discovery-query";

describe("EventDiscoveryQueryBuilder", () => {
  it("builds one safe query per address", () => {
    const filters: EventFilter[] = [
      { address: "0xabc", keys: ["0x01", null, "0x03"] },
      { address: "0xabc", keys: ["0x02", "0x04"] },
      { address: "0xdef", keys: ["0x06"] },
    ];

    expect(
      new EventDiscoveryQueryBuilder({
        filters,
        mergeAddresses: false,
      }).build(),
    ).toEqual([
      { address: "0xabc", keys: [["0x1", "0x2"], []] },
      { address: "0xdef", keys: [["0x6"]] },
    ]);
  });

  it("builds one query when addresses can be merged", () => {
    const filters: EventFilter[] = [
      { address: "0xabc", keys: ["0x01"] },
      { address: "0xdef", keys: ["0x02"] },
    ];

    expect(
      new EventDiscoveryQueryBuilder({
        filters,
        mergeAddresses: true,
      }).build(),
    ).toEqual([
      {
        address: ["0xabc", "0xdef"],
        keys: [["0x1", "0x2"]],
      },
    ]);
  });

  it("builds an unrestricted query for an address wildcard", () => {
    const filters: EventFilter[] = [{}, { address: "0xabc", keys: ["0x01"] }];

    expect(
      new EventDiscoveryQueryBuilder({
        filters,
        mergeAddresses: false,
      }).build(),
    ).toEqual([{}]);
  });
});
