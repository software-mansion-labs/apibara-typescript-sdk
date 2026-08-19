import type { EventFilter } from "@apibara/starknet";
import { normalizeFelt } from "./felt";

export type EventDiscoveryQuery = {
  address?: string | string[];
  keys?: string[][];
};

export type EventDiscoveryQueryBuilderOptions = {
  filters: readonly EventFilter[];
  mergeAddresses: boolean;
};

/**
 * Builds the broad `starknet_getEvents` queries used to discover candidate
 * blocks. Exact matching remains the responsibility of BlockMapper.
 *
 * For example, filters `A:[X]`, `A:[Y]`, and `B:[Z]` produce:
 *
 * - `{ address: A, keys: [[X, Y]] }`
 * - `{ address: B, keys: [[Z]] }`
 *
 * With address merging enabled, they instead produce:
 *
 * - `{ address: [A, B], keys: [[X, Y, Z]] }`
 */
export class EventDiscoveryQueryBuilder {
  private readonly filters: readonly EventFilter[];
  private readonly mergeAddresses: boolean;

  constructor(options: EventDiscoveryQueryBuilderOptions) {
    this.filters = options.filters;
    this.mergeAddresses = options.mergeAddresses;
  }

  build(): EventDiscoveryQuery[] {
    if (this.filters.length === 0) return [];

    const filtersByAddress = new Map<string, EventFilter[]>();
    for (const filter of this.filters) {
      // An address-less filter matches every address. A restricted query would
      // therefore miss valid events.
      if (!filter.address) {
        return [this.buildQuery(undefined, this.filters)];
      }

      const address = normalizeFelt(filter.address);
      const addressFilters = filtersByAddress.get(address) ?? [];
      addressFilters.push(filter);
      filtersByAddress.set(address, addressFilters);
    }

    if (this.mergeAddresses) {
      const addresses = [...filtersByAddress.keys()];
      const address = addresses.length === 1 ? addresses[0] : addresses;
      return [this.buildQuery(address, this.filters)];
    }

    return [...filtersByAddress].map(([address, filters]) =>
      this.buildQuery(address, filters),
    );
  }

  private buildQuery(
    address: string | string[] | undefined,
    filters: readonly EventFilter[],
  ): EventDiscoveryQuery {
    const query: EventDiscoveryQuery = {};
    if (address !== undefined) query.address = address;

    const keys = this.buildSafeKeySuperset(filters);
    if (keys) query.keys = keys;
    return query;
  }

  /**
   * Combines exact key filters without excluding any event they could match.
   *
   * `[A, null, C]` combined with `[B, D]` becomes `[[A, B], []]`:
   * the first key may be A or B, the empty second position is an RPC wildcard,
   * and C cannot be pushed because the second filter has no third key.
   */
  private buildSafeKeySuperset(
    filters: readonly EventFilter[],
  ): string[][] | undefined {
    const prefixLength = Math.min(
      ...filters.map((filter) => filter.keys?.length ?? 0),
    );
    if (prefixLength === 0) return undefined;

    return Array.from({ length: prefixLength }, (_, index) => {
      const choices = new Set<string>();
      for (const filter of filters) {
        const key = filter.keys?.[index];
        if (key === null || key === undefined) return [];
        choices.add(normalizeFelt(key));
      }
      return [...choices];
    });
  }
}
