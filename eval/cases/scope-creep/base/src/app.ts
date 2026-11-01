import { buttonClass } from "./button.js";
import { footerStyle } from "./styles/footerStyle.js";
export function renderApp(): string {
  return `<button class="${buttonClass(true)}">Save</button><footer style="color:${footerStyle.color}">x</footer>`;
}
