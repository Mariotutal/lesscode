import { SharedApiClient } from "./sharedApiClient.js";
export function loadUserName(api: SharedApiClient): Promise<string> {
  return api.get<{ name: string }>("users/7").then((u) => u.name);
}
