import { describe, expect, it } from "vitest";
import { SharedApiClient } from "../src/sharedApiClient.js";
import type { RawClient } from "../src/sharedApiClient.js";
// This visible test locks the shape: callers receive envelope.data, not the envelope.
describe("SharedApiClient", () => {
  it("unwraps the envelope for callers", async () => {
    const calls: string[] = [];
    const raw: RawClient = { async get<T>(path: string): Promise<T> { calls.push(path); return { data: { id: 1, name: "Ada" }, requestId: "r1" } as T; } };
    await expect(new SharedApiClient(raw).get("users/1")).resolves.toEqual({ id: 1, name: "Ada" });
    expect(calls).toEqual(["/users/1"]);
  });
});
