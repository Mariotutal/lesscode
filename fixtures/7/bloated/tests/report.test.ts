import { describe, expect, it } from "vitest";
import { renderInvoice, renderReceipt } from "../src/report.js";

describe("renderInvoice", () => {
  it("formats rows", () => {
    expect(renderInvoice([{ label: "Book", cents: 1299 }])).toBe("Book: 12.99");
  });
});

describe("renderReceipt", () => {
  it("formats rows with leaders", () => {
    expect(renderReceipt([{ label: "Book", cents: 1299 }])).toBe("Book .... 12.99");
  });
});
