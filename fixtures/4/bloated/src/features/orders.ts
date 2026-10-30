import { SharedApiClient } from "../sharedApiClient.js";
export interface Order { id: number; total: number; }
export function getOrder(api: SharedApiClient, id: number): Promise<Order> {
  return api.get<Order>(`orders/${id}`);
}
