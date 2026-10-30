export interface InvoiceRow { label: string; cents: number; }
export function renderInvoice(rows: InvoiceRow[]): string {
  return rows.map((r) => `${r.label}: ${(r.cents / 100).toFixed(2)}`).join("\n");
}
