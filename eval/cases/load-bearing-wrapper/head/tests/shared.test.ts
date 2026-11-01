import { describe, expect, it } from "vitest";
import { SharedApiClient } from "../src/sharedApiClient.js";
import { loadUserName } from "../src/users.js";
import { loadOrderTotal } from "../src/orders.js";
describe("SharedApiClient", () => {
  it("unwraps the envelope for both features", async () => {
    const seen: string[] = [];
    const raw = { async get<T>(path: string): Promise<{ data: T; requestId: string }> { seen.push(path); return { data: (path.includes("users") ? { name: "Ada" } : { total: 42 }) as T, requestId: "r1" }; } };
    const api = new SharedApiClient(raw);
    await expect(loadUserName(api)).resolves.toBe("Ada");
    await expect(loadOrderTotal(api)).resolves.toBe(42);
    expect(seen).toEqual(["/users/7", "/orders/9"]);
  });
});
