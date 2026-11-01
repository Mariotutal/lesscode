import { SharedApiClient } from "./sharedApiClient.js";
export function loadOrderTotal(api: SharedApiClient): Promise<number> {
  return api.get<{ total: number }>("orders/9").then((o) => o.total);
}
