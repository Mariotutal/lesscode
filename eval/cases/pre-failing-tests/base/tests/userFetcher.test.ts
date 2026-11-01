import { describe, expect, it } from "vitest";
import { UserFetcher } from "../src/userFetcher.js";
import type { HttpClient, User } from "../src/client.js";
const user: User = { id: 7, name: "Ada", email: "ada@example.com" };
describe("UserFetcher", () => {
  it("returns the user", async () => {
    const calls: string[] = [];
    const client: HttpClient = { async get<T>(path: string): Promise<T> { calls.push(path); return user as T; } };
    await expect(new UserFetcher(client).getUser(7)).resolves.toEqual(user);
    expect(calls).toEqual(["/users/WRONG"]);
  });
});
