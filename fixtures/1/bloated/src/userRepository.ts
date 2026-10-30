import type { User } from "./client.js";
import { UserApiClient } from "./userApiClient.js";
/** Single-use: only UserService calls this. */
export class UserRepository {
  constructor(private readonly api: UserApiClient) {}
  findById(id: number): Promise<User> { return this.api.fetchUser(id); }
}
