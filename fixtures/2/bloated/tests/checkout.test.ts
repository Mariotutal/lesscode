import { describe, expect, it } from "vitest";
import { checkoutTotal } from "../src/checkout/checkout.js";
import { formatMoney } from "../src/lib/formatMoney.js";
describe("checkoutTotal", () => {
  it("formats a summed total", () => {
    expect(checkoutTotal([{ price: 10, qty: 2 }, { price: 2.5, qty: 1 }])).toBe("$22.50");
  });
  it("lib helper groups thousands", () => { expect(formatMoney(1234.5)).toBe("$1,234.50"); });
});
