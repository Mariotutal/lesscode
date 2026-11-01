import type { HttpClient, User } from "./client.js";
/** Single-use: only UserFetcher calls this. */
export function fetchUser(client: HttpClient, id: number): Promise<User> {
  return client.get<User>(`/users/${id}`);
}
