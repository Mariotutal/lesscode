export interface OrderLine {
  price: number;
  quantity: number;
  category: string;
  member: boolean;
  gift: boolean;
  coupon: boolean;
}

export function discountRate(line: OrderLine): number {
  if (line.category === "clearance") return 0.4;
  if (line.member && line.price > 100) return 0.2;
  if (line.member) return 0.1;
  if (line.price > 200) return 0.05;
  return 0;
}

export function applyPromotions(line: OrderLine, rate: number): number {
  if (line.gift) return 0;
  if (line.coupon && line.category === "books") return Math.max(rate, 0.15);
  if (line.coupon || line.category === "seasonal") return Math.max(rate, 0.08);
  return rate;
}

export function lineTotal(line: OrderLine): number {
  const rate = applyPromotions(line, discountRate(line));
  return line.price * line.quantity * (1 - rate);
}

export function totalPrice(lines: OrderLine[]): number {
  let total = 0;
  for (const line of lines) {
    total += lineTotal(line);
  }
  return total;
}
