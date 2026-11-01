/** Duplicate of src/lib/formatMoney.ts (same behaviour, renamed locals). */
export function formatMoney(value: number): string {
  const sign = value < 0 ? "-" : "";
  const rounded = Math.round((Math.abs(value) + Number.EPSILON) * 100) / 100;
  const [whole, cents] = rounded.toFixed(2).split(".");
  const grouped = (whole ?? "0").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}$${grouped}.${cents}`;
}
