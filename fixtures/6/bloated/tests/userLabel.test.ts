import { describe, expect, it, vi } from "vitest";
import { fetchUserLabel } from "../src/userLabel.js";

describe("fetchUserLabel", () => {
  it("formats the fetched user", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      json: async () => ({ id: 7, name: "Ada", email: "ada@example.com" }),
    }));
    await expect(fetchUserLabel(7)).resolves.toBe("Ada <ada@example.com>");
  });
});
