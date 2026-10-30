import type { HttpClient, User } from "./client.js";
import { UserApiClient } from "./userApiClient.js";
import { UserRepository } from "./userRepository.js";
import { UserService } from "./userService.js";
export class UserFetcher {
  private readonly service: UserService;
  constructor(client: HttpClient) {
    this.service = new UserService(new UserRepository(new UserApiClient(client)));
  }
  getUser(id: number): Promise<User> { return this.service.loadUser(id); }
}
