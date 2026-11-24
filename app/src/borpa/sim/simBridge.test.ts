import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  canRunStructural,
  cancelSimJob,
  getSimBridgeState,
  newJobId,
  resetSimBridgeForTest,
  setMode,
  setSimCapabilities,
  simEvent,
  startSimJob,
} from './simBridge'

let posted: Record<string, unknown>[] = []

beforeEach(() => {
  posted = []
  vi.stubGlobal('window', { wx: { postMessage: (m: string) => posted.push(JSON.parse(m) as Record<string, unknown>) } })
  resetSimBridgeForTest()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('simBridge', () => {
  it('switches mode on "sim" and "model" only', () => {
    setMode('sim')
    expect(getSimBridgeState().mode).toBe('sim')
    setMode('nonsense')
    expect(getSimBridgeState().mode).toBe('sim')
    setMode('model')
    expect(getSimBridgeState().mode).toBe('model')
  })

  it('runs a structural study only when both solvers were found', () => {
    expect(canRunStructural(getSimBridgeState().capabilities)).toBe(false)
    setSimCapabilities({ mesher: true, structural: false })
    expect(canRunStructural(getSimBridgeState().capabilities)).toBe(false)
    setSimCapabilities({ mesher: true, structural: true })
    expect(canRunStructural(getSimBridgeState().capabilities)).toBe(true)
  })

  it('makes job ids the host accepts', () => {
    for (let i = 0; i < 50; i++) expect(newJobId()).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(newJobId()).not.toBe(newJobId())
  })

  it('posts sim.run and sim.cancel with borpa: 1', () => {
    const id = startSimJob(7n, { version: 1 }, { objects: [] })
    expect(posted[0]).toEqual({ borpa: 1, type: 'sim.run', job: id, study: { version: 1 }, geometry: { objects: [] } })
    cancelSimJob()
    expect(posted[1]).toEqual({ borpa: 1, type: 'sim.cancel', job: id })
  })

  it('follows the current job and ignores others', () => {
    const id = startSimJob(7n, {}, {})
    simEvent({ job: 'other', state: 'failed', code: 'timeout', message: 'x', logTail: '' })
    expect(getSimBridgeState().job?.state).toBe('starting')
    simEvent({ job: id, state: 'running', stage: 'solve', progress: 0.5, message: 'CalculiX' })
    expect(getSimBridgeState().job).toMatchObject({ state: 'running', stage: 'solve', progress: 0.5, message: 'CalculiX', object: 7n })
    simEvent({
      job: id,
      state: 'done',
      resultUrl: 'https://hew.wxsite/sim/x/result.bsr',
      summary: { nodes: 10, elements: 4, maxDisplacement: 2, maxVonMises: 30, reactionForce: [0, 0, 10], wallSeconds: 1.5 },
    })
    expect(getSimBridgeState().job).toMatchObject({
      state: 'done',
      resultUrl: 'https://hew.wxsite/sim/x/result.bsr',
      summary: { nodes: 10, maxDisplacement: 2, reactionForce: [0, 0, 10], meshSize: null },
    })
    // A finished job takes no more events.
    simEvent({ job: id, state: 'failed', code: 'cancelled', message: '', logTail: '' })
    expect(getSimBridgeState().job?.state).toBe('done')
  })

  it('keeps the failure code, message and log tail', () => {
    const id = startSimJob(1n, {}, {})
    simEvent({ job: id, state: 'failed', code: 'mesh-failed', message: 'Gmsh could not mesh', logTail: 'Error: ...' })
    expect(getSimBridgeState().job).toMatchObject({ state: 'failed', code: 'mesh-failed', message: 'Gmsh could not mesh', logTail: 'Error: ...' })
  })
})
