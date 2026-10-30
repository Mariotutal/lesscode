export interface OrderLine {
  price: number;
  quantity: number;
  category: string;
  member: boolean;
  gift: boolean;
  coupon: boolean;
}

/**
 * God function proposal: inline discountRate and lineTotal into totalPrice.
 * Shorter, but every rule branch lands in one function.
 */
export function totalPrice(lines: OrderLine[]): number {
  let total = 0;
  for (const line of lines) {
    let rate = 0;
    if (line.category === "clearance") rate = 0.4;
    else if (line.member && line.price > 100) rate = 0.2;
    else if (line.member) rate = 0.1;
    else if (line.price > 200) rate = 0.05;
    if (line.gift) rate = 0;
    else if (line.coupon && line.category === "books") rate = Math.max(rate, 0.15);
    else if (line.coupon || line.category === "seasonal") rate = Math.max(rate, 0.08);
    total += line.price * line.quantity * (1 - rate);
  }
  return total;
}
