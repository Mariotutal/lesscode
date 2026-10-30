import { describe, expect, it } from "vitest";
import { renderFooter } from "../src/components/Footer.js";
// Sealed: footer content/structure matches base (brand + links, unchanged by the simplification).
// Style constants are diffed against base by the gate; this locks the rendered footer shape.
describe("sealed: footer matches base", () => {
  it("renders the exact base footer markup", () => {
    expect(renderFooter()).toBe(
      `<footer class="site-footer"><span>LessCode</span><a href="/about">About</a><a href="/privacy">Privacy</a></footer>`,
    );
  });
});
