import type { User } from "./client.js";
import { UserRepository } from "./userRepository.js";
/** Single-use: only UserFetcher calls this. */
export class UserService {
  constructor(private readonly repo: UserRepository) {}
  loadUser(id: number): Promise<User> { return this.repo.findById(id); }
}
