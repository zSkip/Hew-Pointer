/**
 * The page's side of Borpa's simulation messages (docs/HLSD/hew-tab.md in
 * the Borpa repository, "Simulation messages").
 *
 * The host calls `window.__borpaHew.setMode("model" | "sim")` when the web
 * view moves between the Model and Sim tabs, `setSimCapabilities({mesher,
 * structural})` after every `ready`, and `simEvent(event)` while a job runs.
 * The page starts a job with a `sim.run` message and stops it with
 * `sim.cancel`. One job runs at a time: a new run replaces the old one, and
 * events for any other job are ignored.
 *
 * This module is a small store the study panel and the viewport layer read;
 * it holds no document state.
 */

import { isBorpa, postToBorpa } from '../host'

export type SimMode = 'model' | 'sim'

export interface SimCapabilities {
  mesher: boolean
  structural: boolean
}

export type SimStage = 'mesh' | 'solve' | 'read'

export type SimFailureCode =
  | 'solver-missing'
  | 'bad-study'
  | 'mesh-failed'
  | 'solve-failed'
  | 'no-result'
  | 'timeout'
  | 'stalled'
  | 'cancelled'

export interface SimSummary {
  nodes: number
  elements: number
  meshSize: number | null
  maxDisplacement: number
  maxVonMises: number
  reactionForce: [number, number, number]
  wallSeconds: number
}

/** The current job as the host last reported it. */
export type SimJob =
  | { id: string; object: bigint; state: 'starting' }
  | { id: string; object: bigint; state: 'running'; stage: SimStage; progress: number | null; message: string }
  | { id: string; object: bigint; state: 'done'; resultUrl: string; summary: SimSummary }
  | { id: string; object: bigint; state: 'failed'; code: SimFailureCode | string; message: string; logTail: string }

export interface SimBridgeState {
  mode: SimMode
  /** Null until the host has said which solvers it found. */
  capabilities: SimCapabilities | null
  job: SimJob | null
}

let state: SimBridgeState = { mode: 'model', capabilities: null, job: null }
const listeners = new Set<() => void>()

function publish(next: SimBridgeState): void {
  state = next
  for (const l of listeners) l()
}

export function getSimBridgeState(): SimBridgeState {
  return state
}

export function subscribeSimBridge(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** The host's `setMode`. Anything but "sim" or "model" is ignored. */
export function setMode(raw: unknown): void {
  if ((raw !== 'sim' && raw !== 'model') || raw === state.mode) return
  publish({ ...state, mode: raw })
}

/** The host's `setSimCapabilities`. */
export function setSimCapabilities(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return
  const r = raw as Record<string, unknown>
  publish({ ...state, capabilities: { mesher: r.mesher === true, structural: r.structural === true } })
}

/** Whether a structural study can run with the solvers the host found. */
export function canRunStructural(caps: SimCapabilities | null): boolean {
  return caps !== null && caps.mesher && caps.structural
}

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function parseSummary(raw: unknown): SimSummary {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const rf = Array.isArray(r.reactionForce) ? r.reactionForce : []
  return {
    nodes: num(r.nodes),
    elements: num(r.elements),
    meshSize: typeof r.meshSize === 'number' && Number.isFinite(r.meshSize) ? r.meshSize : null,
    maxDisplacement: num(r.maxDisplacement),
    maxVonMises: num(r.maxVonMises),
    reactionForce: [num(rf[0]), num(rf[1]), num(rf[2])],
    wallSeconds: num(r.wallSeconds),
  }
}

/** The host's `simEvent`. Events for a job other than the current one are
 *  dropped, and so is anything after the job finished. */
export function simEvent(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return
  const e = raw as Record<string, unknown>
  const job = state.job
  if (job === null || e.job !== job.id || job.state === 'done' || job.state === 'failed') return
  const base = { id: job.id, object: job.object }
  if (e.state === 'running') {
    const stage = e.stage === 'mesh' || e.stage === 'solve' || e.stage === 'read' ? e.stage : 'mesh'
    const progress = typeof e.progress === 'number' && Number.isFinite(e.progress) ? Math.min(1, Math.max(0, e.progress)) : null
    publish({ ...state, job: { ...base, state: 'running', stage, progress, message: str(e.message) } })
  } else if (e.state === 'done') {
    publish({ ...state, job: { ...base, state: 'done', resultUrl: str(e.resultUrl), summary: parseSummary(e.summary) } })
  } else if (e.state === 'failed') {
    publish({ ...state, job: { ...base, state: 'failed', code: str(e.code), message: str(e.message), logTail: str(e.logTail) } })
  }
}

let jobCounter = 0

/** A new job id: `[A-Za-z0-9_-]{1,64}`, unique within this page. */
export function newJobId(now = Date.now()): string {
  jobCounter += 1
  return `j${now.toString(36)}_${jobCounter.toString(36)}_${Math.floor(Math.random() * 0x10000).toString(36)}`
}

/** Start a job: the host cancels any job already running. */
export function startSimJob(object: bigint, study: unknown, geometry: unknown): string {
  const id = newJobId()
  publish({ ...state, job: { id, object, state: 'starting' } })
  postToBorpa({ type: 'sim.run', job: id, study, geometry })
  return id
}

/** Ask the host to stop the current job. Its `cancelled` failure ends it. */
export function cancelSimJob(): void {
  const job = state.job
  if (job === null || job.state === 'done' || job.state === 'failed') return
  postToBorpa({ type: 'sim.cancel', job: job.id })
}

/** Forget the current job (its result is no longer shown). */
export function clearSimJob(): void {
  if (state.job === null) return
  publish({ ...state, job: null })
}

/** Fail the current job from the page's side (the request could not be built). */
export function failSimJobLocally(object: bigint, code: string, message: string): void {
  publish({ ...state, job: { id: newJobId(), object, state: 'failed', code, message, logTail: '' } })
}

// The host's entry points, installed at load beside `setFilaments` so the
// mode the host sends after `ready` always has somewhere to land.
if (isBorpa) window.__borpaHew = { ...window.__borpaHew, setMode, setSimCapabilities, simEvent }

/** Test seam: put the store back to its initial state. */
export function resetSimBridgeForTest(next: Partial<SimBridgeState> = {}): void {
  publish({ mode: 'model', capabilities: null, job: null, ...next })
}
