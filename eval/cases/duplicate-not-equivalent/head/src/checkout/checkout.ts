import { formatMoney } from "./formatMoney.js";
export interface LineItem { price: number; qty: number; }
export function checkoutTotal(items: LineItem[]): string {
  return formatMoney(items.reduce((sum, i) => sum + i.price * i.qty, 0));
}
