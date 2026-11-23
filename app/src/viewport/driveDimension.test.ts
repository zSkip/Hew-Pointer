/**
 * driveDimension tests — which typed texts drive the model and which stay a
 * label, and that a kernel refusal comes back as toast copy.
 */
import { describe, it, expect, vi } from 'vitest'
import { driveDimensionLength } from './driveDimension'
import type { AnnotationSnapshot } from './annotationEdit'
import type { Scene as WasmScene } from '../wasm/loader'

const linear: AnnotationSnapshot = {
  kind: 'linear',
  a: { nodeKind: 0, nodeId: 5n, point: [0, 0, 0] },
  b: { nodeKind: 0, nodeId: 5n, point: [1, 0, 0] },
  offset: [0, -0.5, 0],
  plane: [0, 0, 0, 0, 0, 1],
  textOverride: undefined,
}

const leader: AnnotationSnapshot = {
  kind: 'leader',
  anchor: { nodeKind: -1, nodeId: 0n, point: [0, 0, 0] },
  offset: [0, 1, 0],
  text: 'note',
}

function fakeScene(refuseWith?: string) {
  const free = vi.fn()
  const set = vi.fn(() => {
    if (refuseWith !== undefined) throw new Error(refuseWith)
    return { free }
  })
  return { scene: { set_linear_dimension_length: set } as unknown as WasmScene, set, free }
}

/** Metres from a bare number, as in a metres display; null otherwise. */
const metres = (s: string): number | null => {
  const t = s.trim()
  return t !== '' && /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null
}

describe('driveDimensionLength', () => {
  it('drives a linear dimension when the text is a length', () => {
    const { scene, set, free } = fakeScene()
    expect(driveDimensionLength(scene, 7n, linear, '1.5', metres)).toEqual({ kind: 'driven' })
    expect(set).toHaveBeenCalledWith(7n, 1.5)
    expect(free).toHaveBeenCalledOnce()
  })

  it('keeps the label path for text that is not a length', () => {
    const { scene, set } = fakeScene()
    expect(driveDimensionLength(scene, 7n, linear, 'Width', metres)).toEqual({ kind: 'label' })
    expect(driveDimensionLength(scene, 7n, linear, '', metres)).toEqual({ kind: 'label' })
    expect(set).not.toHaveBeenCalled()
  })

  it('never drives anything but a linear dimension', () => {
    const { scene, set } = fakeScene()
    expect(driveDimensionLength(scene, 7n, leader, '1.5', metres)).toEqual({ kind: 'label' })
    expect(set).not.toHaveBeenCalled()
  })

  it('reads lengths with the real unit parser by default', () => {
    const { scene, set } = fakeScene()
    expect(driveDimensionLength(scene, 7n, linear, '250mm')).toEqual({ kind: 'driven' })
    const calls = set.mock.calls as unknown as [bigint, number][]
    expect(calls[0][0]).toBe(7n)
    expect(calls[0][1]).toBeCloseTo(0.25, 12)
  })

  it('returns readable copy when the kernel refuses', () => {
    const { scene } = fakeScene('NoSquareFace: no flat face is square to the dimension at either end')
    const out = driveDimensionLength(scene, 7n, linear, '2', metres)
    expect(out.kind).toBe('refused')
    if (out.kind === 'refused') {
      expect(out.message).toMatch(/square to this dimension/)
      expect(out.message).not.toMatch(/NoSquareFace/)
    }
  })
})
