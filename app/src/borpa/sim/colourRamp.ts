/**
 * The result colour ramp: viridis (perceptually uniform, readable by colour-
 * blind users and in greyscale), from matplotlib's table, sampled at nine
 * stops and interpolated linearly between them.
 */

const STOPS: readonly [number, number, number][] = [
  [0x44, 0x01, 0x54],
  [0x47, 0x2d, 0x7b],
  [0x3b, 0x52, 0x8b],
  [0x2c, 0x72, 0x8e],
  [0x21, 0x91, 0x8c],
  [0x28, 0xae, 0x80],
  [0x5e, 0xc9, 0x62],
  [0xad, 0xdc, 0x30],
  [0xfd, 0xe7, 0x25],
]

/** The ramp's colour at `t` (clamped to 0..1), as 0..1 sRGB channels. */
export function rampColour(t: number): [number, number, number] {
  const x = Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0
  const s = x * (STOPS.length - 1)
  const i = Math.min(STOPS.length - 2, Math.floor(s))
  const f = s - i
  const a = STOPS[i]
  const b = STOPS[i + 1]
  return [(a[0] + (b[0] - a[0]) * f) / 255, (a[1] + (b[1] - a[1]) * f) / 255, (a[2] + (b[2] - a[2]) * f) / 255]
}

/** A CSS linear-gradient of the ramp, low at the left. */
// oxlint-disable-next-line lingui/no-unlocalized-strings -- a CSS keyword
export function rampGradientCss(direction = 'to right'): string {
  const parts = STOPS.map((c, i) => `rgb(${c[0]}, ${c[1]}, ${c[2]}) ${((i / (STOPS.length - 1)) * 100).toFixed(1)}%`)
  return `linear-gradient(${direction}, ${parts.join(', ')})`
}
