import { describe, expect, it } from "vitest";
import { totalPrice } from "../src/pricing.js";

describe("totalPrice", () => {
  it("applies no discount to a plain line", () => {
    expect(totalPrice([{ price: 10, quantity: 2, category: "books", member: false, gift: false, coupon: false }])).toBe(20);
  });
  it("applies the clearance discount", () => {
    expect(totalPrice([{ price: 10, quantity: 1, category: "clearance", member: false, gift: false, coupon: false }])).toBe(6);
  });
  it("applies the member discount", () => {
    expect(totalPrice([{ price: 50, quantity: 1, category: "books", member: true, gift: false, coupon: false }])).toBe(45);
  });
  it("sums multiple lines", () => {
    expect(
      totalPrice([
        { price: 10, quantity: 1, category: "books", member: false, gift: false, coupon: false },
        { price: 10, quantity: 1, category: "clearance", member: false, gift: false, coupon: false },
      ]),
    ).toBe(16);
  });
});
