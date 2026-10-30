import { describe, expect, it } from "vitest";
import { checkoutTotal } from "../src/checkout/checkout.js";
// Sealed: rounding edge the existing lib helper handles. Must hold before and after retargeting to src/lib.
describe("sealed: rounding edge", () => {
  it("rounds half-up at the cent edge", () => {
    expect(checkoutTotal([{ price: 1.005, qty: 1 }])).toBe("$1.01");
    expect(checkoutTotal([{ price: 2.675, qty: 1 }])).toBe("$2.68");
    expect(checkoutTotal([{ price: -1.005, qty: 1 }])).toBe("-$1.01");
  });
});
