import { describe, expect, it } from 'vitest'
import { BsrError, fieldScalars, parseBsr } from './bsr'

/** A BSR1 file built the way `write_result_file` (Borpa's ResultFile.cpp) writes it. */
function makeBsr(opts: {
  positions: number[]
  triangles: number[]
  faceIndex: number[]
  fields: { name: string; components: number; unit: string; min: number; max: number; values: number[] }[]
  summary?: Record<string, unknown>
  pad?: boolean
}): ArrayBuffer {
  const header = {
    nodes: opts.positions.length / 3,
    triangles: opts.triangles.length / 3,
    fields: opts.fields.map(({ name, components, unit, min, max }) => ({ name, components, unit, min, max })),
    summary: opts.summary ?? {},
  }
  let text = JSON.stringify(header)
  if (opts.pad !== false) while ((8 + text.length) % 4 !== 0) text += ' '
  const headerBytes = new TextEncoder().encode(text)
  const arrays = [
    new Float32Array(opts.positions),
    new Uint32Array(opts.triangles),
    new Uint32Array(opts.faceIndex),
    ...opts.fields.map((f) => new Float32Array(f.values)),
  ]
  const size = 8 + headerBytes.length + arrays.reduce((n, a) => n + a.byteLength, 0)
  const out = new Uint8Array(size)
  out.set([0x42, 0x53, 0x52, 0x31])
  new DataView(out.buffer).setUint32(4, headerBytes.length, true)
  out.set(headerBytes, 8)
  let o = 8 + headerBytes.length
  for (const a of arrays) {
    out.set(new Uint8Array(a.buffer), o)
    o += a.byteLength
  }
  return out.buffer
}

const TRIANGLE = {
  positions: [0, 0, 0, 10, 0, 0, 0, 10, 0],
  triangles: [0, 1, 2],
  faceIndex: [4],
  fields: [
    { name: 'displacement', components: 3, unit: 'mm', min: 0, max: 5, values: [0, 0, 0, 3, 4, 0, 0, 0, -2] },
    { name: 'vonMises', components: 1, unit: 'MPa', min: 1, max: 9, values: [1, 9, 5] },
  ],
  summary: { nodes: 3, maxDisplacement: 5, reactionForce: [0, 0, 10] },
}

describe('parseBsr', () => {
  it('reads positions, triangles, face indices, fields and the summary', () => {
    const r = parseBsr(makeBsr(TRIANGLE))
    expect([...r.positions]).toEqual(TRIANGLE.positions)
    expect([...r.triangles]).toEqual([0, 1, 2])
    expect([...r.faceIndex]).toEqual([4])
    expect(r.fields.map((f) => [f.name, f.components, f.unit, f.min, f.max])).toEqual([
      ['displacement', 3, 'mm', 0, 5],
      ['vonMises', 1, 'MPa', 1, 9],
    ])
    expect([...r.fields[0].values]).toEqual([0, 0, 0, 3, 4, 0, 0, 0, -2])
    expect([...r.fields[1].values]).toEqual([1, 9, 5])
    expect(r.summary).toEqual(TRIANGLE.summary)
  })

  it('takes a vector field as its magnitude', () => {
    const r = parseBsr(makeBsr(TRIANGLE))
    const d = fieldScalars(r.fields[0])
    expect([...d.values]).toEqual([0, 5, 2])
    expect(d.min).toBe(0)
    expect(d.max).toBe(5)
  })

  it('refuses a file that is not BSR1', () => {
    const bad = new Uint8Array(makeBsr(TRIANGLE))
    bad[3] = 0x32
    expect(() => parseBsr(bad.buffer)).toThrow(BsrError)
    expect(() => parseBsr(new ArrayBuffer(4))).toThrow(BsrError)
  })

  it('refuses a cut-short file', () => {
    const whole = makeBsr(TRIANGLE)
    expect(() => parseBsr(whole.slice(0, whole.byteLength - 4))).toThrow(/cut short/)
  })

  it('refuses arrays off the 4-byte boundary', () => {
    const header = JSON.stringify({ nodes: 0, triangles: 0, fields: [], summary: {} })
    expect((8 + header.length) % 4).not.toBe(0)
    expect(() => parseBsr(makeBsr({ positions: [], triangles: [], faceIndex: [], fields: [], pad: false }))).toThrow(/boundary/)
  })

  it('refuses a triangle naming a node the file lacks', () => {
    expect(() => parseBsr(makeBsr({ ...TRIANGLE, triangles: [0, 1, 3] }))).toThrow(/node/)
  })
})
