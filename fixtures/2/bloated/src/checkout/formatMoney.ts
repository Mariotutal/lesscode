/** PR-added duplicate of src/lib/formatMoney.ts (same behaviour, second copy). */
export function formatMoney(amount: number): string {
  const sign = amount < 0 ? "-" : "";
  const rounded = Math.round((Math.abs(amount) + Number.EPSILON) * 100) / 100;
  const [whole, cents] = rounded.toFixed(2).split(".");
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${grouped}.${cents}`;
}
