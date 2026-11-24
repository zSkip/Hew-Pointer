/**
 * Reader for the simulation result file the host serves at a job's
 * `resultUrl` (BSR1; written by `src/borpa_sim/ResultFile.cpp` in the Borpa
 * repository, layout documented in `ResultFile.hpp`).
 *
 * Little-endian: the magic `BSR1`, a u32 header length, a UTF-8 JSON header
 * padded with spaces so the arrays start on a 4-byte boundary, then node
 * positions (f32 × 3n, mm), triangles (u32 × 3t), the Hew face index of each
 * triangle (u32 × t), and each field's values (f32 × n × components) in the
 * header's order. The header holds `nodes`, `triangles`, `fields` (`name`,
 * `components`, `unit`, `min`, `max`) and `summary`.
 */

export interface BsrField {
  name: string
  components: number
  unit: string
  /** Of the magnitude, for a vector field. */
  min: number
  max: number
  values: Float32Array
}

export interface BsrResult {
  /** Surface node positions, mm, xyz per node. */
  positions: Float32Array
  /** Three node indices per triangle. */
  triangles: Uint32Array
  /** Index into the request's face list, one per triangle. */
  faceIndex: Uint32Array
  fields: BsrField[]
  summary: Record<string, unknown>
}

/* oxlint-disable lingui/no-unlocalized-strings -- BsrError messages go to the diagnostic log and the failure details, English for the maintainer */
export class BsrError extends Error {}

function count(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new BsrError(`the header's ${what} is not a count`)
  return v
}

/** Parse a BSR1 file. Throws `BsrError` for anything malformed. */
export function parseBsr(buffer: ArrayBuffer): BsrResult {
  const bytes = new Uint8Array(buffer)
  if (bytes.length < 8 || bytes[0] !== 0x42 || bytes[1] !== 0x53 || bytes[2] !== 0x52 || bytes[3] !== 0x31) {
    throw new BsrError('not a Borpa result file')
  }
  const view = new DataView(buffer)
  const headerLength = view.getUint32(4, true)
  if (headerLength > bytes.length - 8) throw new BsrError('the result file is cut short')
  let header: Record<string, unknown>
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength))) as Record<string, unknown>
  } catch {
    throw new BsrError('the header is not JSON')
  }
  if (typeof header !== 'object' || header === null) throw new BsrError('the header is not an object')
  const n = count(header.nodes, 'node count')
  const t = count(header.triangles, 'triangle count')
  const rawFields = Array.isArray(header.fields) ? header.fields : []

  let offset = 8 + headerLength
  if (offset % 4 !== 0) throw new BsrError('the arrays do not start on a 4-byte boundary')
  const take = <T extends Float32Array | Uint32Array>(make: (b: ArrayBuffer, o: number, l: number) => T, length: number): T => {
    if (offset + length * 4 > bytes.length) throw new BsrError('the result file is cut short')
    const out = make(buffer, offset, length)
    offset += length * 4
    return out
  }
  const f32 = (b: ArrayBuffer, o: number, l: number) => new Float32Array(b, o, l)
  const u32 = (b: ArrayBuffer, o: number, l: number) => new Uint32Array(b, o, l)

  const positions = take(f32, 3 * n)
  const triangles = take(u32, 3 * t)
  const faceIndex = take(u32, t)
  for (let i = 0; i < triangles.length; i++) if (triangles[i] >= n) throw new BsrError('a triangle refers to a node the file does not have')

  const fields: BsrField[] = rawFields.map((raw: unknown) => {
    const f = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const components = count(f.components, 'field component count')
    if (components < 1) throw new BsrError('a field has no components')
    return {
      name: typeof f.name === 'string' ? f.name : '',
      components,
      unit: typeof f.unit === 'string' ? f.unit : '',
      min: typeof f.min === 'number' ? f.min : 0,
      max: typeof f.max === 'number' ? f.max : 0,
      values: take(f32, n * components),
    }
  })
  const summary = typeof header.summary === 'object' && header.summary !== null ? (header.summary as Record<string, unknown>) : {}
  return { positions, triangles, faceIndex, fields, summary }
}
/* oxlint-enable lingui/no-unlocalized-strings */

/** The value shown for one node of a field: the value itself, or the
 *  magnitude of a vector. */
export function fieldScalar(field: BsrField, node: number): number {
  const c = field.components
  if (c === 1) return field.values[node]
  let sum = 0
  for (let k = 0; k < c; k++) {
    const v = field.values[node * c + k]
    sum += v * v
  }
  return Math.sqrt(sum)
}

/** Every node's shown value, and their range. */
export function fieldScalars(field: BsrField): { values: Float32Array; min: number; max: number } {
  const n = field.values.length / field.components
  const values = new Float32Array(n)
  let min = Infinity
  let max = -Infinity
  for (let i = 0; i < n; i++) {
    const v = fieldScalar(field, i)
    values[i] = v
    if (v < min) min = v
    if (v > max) max = v
  }
  if (n === 0) {
    min = 0
    max = 0
  }
  return { values, min, max }
}
