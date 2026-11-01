import type { HttpClient, User } from "./client.js";
import { fetchUser } from "./userApi.js";
export class UserFetcher {
  constructor(private readonly client: HttpClient) {}
  getUser(id: number): Promise<User> { return fetchUser(this.client, id); }
}
