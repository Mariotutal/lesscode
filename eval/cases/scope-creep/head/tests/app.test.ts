import { describe, expect, it } from "vitest";
import { renderApp } from "../src/app.js";
import { buttonLabel } from "../src/button.js";
describe("app", () => {
  it("renders the button and the base footer colour", () => {
    expect(buttonLabel(true)).toBe("Save changes");
    expect(renderApp()).toContain("#333");
  });
});
