import { renderButton } from "./components/Button.js";
import { renderFooter } from "./components/Footer.js";
import { log } from "./logger.js";
export function renderApp(): string {
  log("render");
  return `${renderButton("Save")}${renderFooter()}`;
}
