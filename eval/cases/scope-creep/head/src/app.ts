import { buttonClass } from "./button.js";
import { log } from "./logger.js";
import { footerStyle } from "./styles/footerStyle.js";
export function renderApp(): string {
  log("render");
  return `<button class="${buttonClass(true)}">Save</button><footer style="color:${footerStyle.color}">x</footer>`;
}
