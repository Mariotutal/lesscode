import { describe, expect, it } from "vitest";
import { totalPrice } from "../src/pricing.js";

// Harness-only: public behaviour of the god-function version must still pass,
// so the gate's rejection can only come from cyclomatic complexity.
describe("totalPrice (sealed)", () => {
  it("matches base behaviour on every discount branch", () => {
    expect(totalPrice([{ price: 300, quantity: 1, category: "books", member: true, gift: false, coupon: false }])).toBe(240);
    expect(totalPrice([{ price: 300, quantity: 1, category: "books", member: false, gift: false, coupon: false }])).toBe(285);
    expect(totalPrice([{ price: 10, quantity: 3, category: "clearance", member: true, gift: false, coupon: false }])).toBe(18);
    expect(totalPrice([])).toBe(0);
  });
});
