export function renderButton(label: string): string {
  return `<button class="btn btn-primary" type="button" aria-label="${label}">${label}</button>`;
}
