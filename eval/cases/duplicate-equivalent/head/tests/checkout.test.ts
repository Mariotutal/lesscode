import { describe, expect, it } from "vitest";
import { checkoutTotal } from "../src/checkout/checkout.js";
describe("checkoutTotal", () => {
  it("formats the total", () => {
    expect(checkoutTotal([{ price: 1.005, qty: 1 }])).toBe("$1.01");
    expect(checkoutTotal([{ price: 1234.5, qty: 2 }])).toBe("$2,469.00");
  });
});
