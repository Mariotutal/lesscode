import type { HttpClient, User } from "./client.js";
export class UserFetcher {
  constructor(private readonly client: HttpClient) {}
  getUser(id: number): Promise<User> { return this.client.get<User>(`/users/${id}`); }
}
