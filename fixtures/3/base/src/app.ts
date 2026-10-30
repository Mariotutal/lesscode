import { renderButton } from "./components/Button.js";
import { renderFooter } from "./components/Footer.js";
export function renderApp(): string { return `${renderButton("Save")}${renderFooter()}`; }
