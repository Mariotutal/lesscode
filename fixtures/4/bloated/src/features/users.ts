import { SharedApiClient } from "../sharedApiClient.js";
export interface User { id: number; name: string; }
export function getUser(api: SharedApiClient, id: number): Promise<User> {
  return api.get<User>(`users/${id}`);
}
