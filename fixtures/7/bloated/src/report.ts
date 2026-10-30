export interface InvoiceRow { label: string; cents: number; }
export function renderInvoice(rows: InvoiceRow[]): string {
  return rows.map((r) => `${r.label}: ${(r.cents / 100).toFixed(2)}`).join("\n");
}
export function renderReceipt(rows: InvoiceRow[]): string {
  // Design smell (non-mechanical): the receipt boundary re-derives the
  // invoice presentation instead of sharing the Invoice concept, so a
  // formatting change must be made in two places. No checker proves
  // this is wrong; a lead flags it in the note, not in a patch.
  return rows.map((r) => `${r.label} .... ${(r.cents / 100).toFixed(2)}`).join("\n");
}
