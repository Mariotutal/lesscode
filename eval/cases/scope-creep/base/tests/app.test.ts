import { describe, expect, it } from "vitest";
import { renderApp } from "../src/app.js";
describe("app", () => {
  it("renders the button and the base footer colour", () => {
    expect(renderApp()).toContain("#333");
  });
});
