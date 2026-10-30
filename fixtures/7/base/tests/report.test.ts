import { describe, expect, it } from "vitest";
import { renderInvoice } from "../src/report.js";

describe("renderInvoice", () => {
  it("formats rows", () => {
    expect(renderInvoice([{ label: "Book", cents: 1299 }])).toBe("Book: 12.99");
  });
});
