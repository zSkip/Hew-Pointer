/**
 * Placeholder material values for a filament type, until Borpa's property
 * table (roadmap M4) gives measured ones. Isotropic, for a solid part: E in
 * MPa, density in tonne/mm³ (the study's unit set: mm, N, MPa). Printed parts
 * are weaker and less stiff than these, and not isotropic; the panel says
 * the values are placeholders.
 *
 * Values are typical datasheet figures for unfilled grades.
 */

export interface SimMaterial {
  /** Shown name: the filament's preset name, or its type. */
  name: string
  /** Young's modulus, MPa. */
  E: number
  /** Poisson's ratio. */
  nu: number
  /** tonne/mm³ (g/cm³ × 1e-9). */
  density: number
}

/* oxlint-disable lingui/no-unlocalized-strings -- filament types are identifiers shared with the slicer */
const BY_TYPE: Record<string, { E: number; nu: number; density: number }> = {
  PLA: { E: 3500, nu: 0.36, density: 1.24 },
  PETG: { E: 2100, nu: 0.38, density: 1.27 },
  ABS: { E: 2200, nu: 0.35, density: 1.04 },
  ASA: { E: 2200, nu: 0.35, density: 1.07 },
  TPU: { E: 26, nu: 0.48, density: 1.21 },
  PA: { E: 1800, nu: 0.39, density: 1.14 },
  PC: { E: 2300, nu: 0.37, density: 1.2 },
}
const FALLBACK_TYPE = 'PLA'
/* oxlint-enable lingui/no-unlocalized-strings */

/** The placeholder for a filament type (`filament_type`, e.g. "PLA", "PETG-CF"):
 *  matched on the base type before any "-" suffix, else PLA's. `density` in
 *  g/cm³ from the filament preset wins over the table's when given. */
export function placeholderMaterial(name: string, type: string, densityGcm3: number | null = null): SimMaterial {
  const base = type.trim().toUpperCase().split(/[-\s+]/)[0]
  const row = BY_TYPE[base] ?? BY_TYPE[FALLBACK_TYPE]
  const density = densityGcm3 !== null && Number.isFinite(densityGcm3) && densityGcm3 > 0 ? densityGcm3 : row.density
  return { name, E: row.E, nu: row.nu, density: density * 1e-9 }
}

/** Whether the type has its own row (false: PLA's values stand in). */
export function hasPlaceholderFor(type: string): boolean {
  return type.trim().toUpperCase().split(/[-\s+]/)[0] in BY_TYPE
}
