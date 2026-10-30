import type { HttpClient, User } from "./client.js";
/** Single-use: only UserRepository calls this. */
export class UserApiClient {
  constructor(private readonly client: HttpClient) {}
  fetchUser(id: number): Promise<User> { return this.client.get<User>(`/users/${id}`); }
}
