import { describe, expect, it } from "vitest";
import { SharedApiClient } from "../src/sharedApiClient.js";
import { loadUserName } from "../src/users.js";
describe("SharedApiClient", () => {
  it("unwraps the envelope", async () => {
    const seen: string[] = [];
    const raw = { async get<T>(path: string): Promise<{ data: T; requestId: string }> { seen.push(path); return { data: (path.includes("users") ? { name: "Ada" } : { total: 42 }) as T, requestId: "r1" }; } };
    const api = new SharedApiClient(raw);
    await expect(loadUserName(api)).resolves.toBe("Ada");
    expect(seen).toEqual(["/users/7"]);
  });
});
