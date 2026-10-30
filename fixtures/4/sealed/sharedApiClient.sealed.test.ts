import { describe, expect, it } from "vitest";
import { SharedApiClient } from "../src/sharedApiClient.js";
import type { RawClient } from "../src/sharedApiClient.js";
import { getUser } from "../src/features/users.js";
import { getOrder } from "../src/features/orders.js";
// Sealed: the inlined version fails this - forwarding raw.get directly would
// hand callers the {data, requestId} envelope instead of data, for both features.
describe("sealed: shared wrapper is load-bearing", () => {
  it("both features get unwrapped data via the shared client", async () => {
    const calls: string[] = [];
    const raw: RawClient = { async get<T>(path: string): Promise<T> {
      calls.push(path);
      return (path.includes("orders") ? { data: { id: 9, total: 42 }, requestId: "r2" } : { data: { id: 1, name: "Ada" }, requestId: "r1" }) as T;
    } };
    const api = new SharedApiClient(raw);
    await expect(getUser(api, 1)).resolves.toEqual({ id: 1, name: "Ada" });
    await expect(getOrder(api, 9)).resolves.toEqual({ id: 9, total: 42 });
    expect(calls).toEqual(["/users/1", "/orders/9"]);
  });
});
