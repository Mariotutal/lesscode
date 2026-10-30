import { describe, expect, it } from "vitest";
import { UserFetcher } from "../src/userFetcher.js";
import type { HttpClient } from "../src/client.js";
// Sealed: response shape must pass through untouched (same shape, exact URL).
describe("sealed: response shape", () => {
  it("returns exactly what client.get returns", async () => {
    const payload = { id: 3, name: "Lin", email: "lin@example.com", extra: "kept" };
    const calls: string[] = [];
    const client: HttpClient = { async get<T>(path: string): Promise<T> { calls.push(path); return payload as T; } };
    await expect(new UserFetcher(client).getUser(3)).resolves.toEqual(payload);
    expect(calls).toEqual(["/users/3"]);
  });
  it("propagates rejection unchanged", async () => {
    const err = new Error("boom");
    const client: HttpClient = { async get<T>(): Promise<T> { throw err; } };
    await expect(new UserFetcher(client).getUser(1)).rejects.toBe(err);
  });
});
