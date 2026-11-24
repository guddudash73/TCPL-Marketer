/**
 * Exact decimal arithmetic for spend (PH1-03a). Amounts are held as integer
 * micro-units (6 decimal places) so a sum of many small calls never drifts the
 * way floating point does, and the same strings go to and from PostgreSQL
 * NUMERIC(14,6) unchanged.
 */
const MICRO = 1_000_000n;
const DECIMAL = /^\d{1,8}(\.\d{1,6})?$/;

export function parseMicro(value: string): bigint | null {
  const trimmed = value.trim();
  if (!DECIMAL.test(trimmed)) return null;
  const [whole = "0", fraction = ""] = trimmed.split(".");
  return BigInt(whole) * MICRO + BigInt(fraction.padEnd(6, "0"));
}

export function formatMicro(micro: bigint): string {
  const negative = micro < 0n;
  const absolute = negative ? -micro : micro;
  const whole = absolute / MICRO;
  const fraction = (absolute % MICRO).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

/** Rounds up: a cost estimate must never be lower than the true cost. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

/** Cost of `quantity` units priced per million units, in micro-currency, rounded up. */
export function pricePerMillion(quantity: number, microPricePerMillion: bigint): bigint {
  return ceilDiv(BigInt(quantity) * microPricePerMillion, MICRO);
}

/** `amountMicro` multiplied by a micro-currency rate per unit, rounded up. */
export function multiplyMicro(amountMicro: bigint, microRate: bigint): bigint {
  return ceilDiv(amountMicro * microRate, MICRO);
}
