import { describe, expect, it } from "vitest";
import { renderButton } from "../src/components/Button.js";
import { renderFooter } from "../src/components/Footer.js";
describe("button", () => {
  it("renders its label", () => { expect(renderButton("Save")).toContain("Save"); });
});
describe("footer", () => {
  it("renders brand and links", () => {
    const html = renderFooter();
    expect(html).toContain("LessCode"); expect(html).toContain("/about"); expect(html).toContain("/privacy");
  });
});
