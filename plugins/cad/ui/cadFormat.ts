// SPDX-License-Identifier: AGPL-3.0-only
// The CAD figures as the panel shows them.

/** A count with its thousands thin-spaced. */
export const count = (n: number): string => n.toLocaleString('en-US')

/** A volume in mm³, shown the way a machinist reads it: under a tenth of a
 *  litre the millilitres, above it litres. */
export function fmtVol(mm3: number): string {
  if (!Number.isFinite(mm3)) return '—'
  const ml = mm3 / 1000
  if (Math.abs(ml) < 100) return `${ml.toFixed(1)} ml`
  if (Math.abs(ml) < 100_000) return `${Math.round(ml).toLocaleString('en-US')} ml`
  return `${(ml / 1000).toFixed(2)} l`
}
