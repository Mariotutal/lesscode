import { describe, expect, it } from "vitest";
import { SharedApiClient } from "../src/sharedApiClient.js";
import type { RawClient } from "../src/sharedApiClient.js";
import { getOrder } from "../src/features/orders.js";
import { getUser } from "../src/features/users.js";
describe("two features share SharedApiClient", () => {
  it("both receive unwrapped data", async () => {
    const calls: string[] = [];
    const raw: RawClient = { async get<T>(path: string): Promise<T> {
      calls.push(path);
      return (path.includes("orders") ? { data: { id: 9, total: 42 }, requestId: "r2" } : { data: { id: 1, name: "Ada" }, requestId: "r1" }) as T;
    } };
    const api = new SharedApiClient(raw);
    await expect(getOrder(api, 9)).resolves.toEqual({ id: 9, total: 42 });
    await expect(getUser(api, 1)).resolves.toEqual({ id: 1, name: "Ada" });
  });
});
