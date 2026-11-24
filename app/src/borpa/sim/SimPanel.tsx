/**
 * SimPanel — the Sim tab's study panel, shown in place of the tray while the
 * page is in simulation mode (borpa/sim/simBridge.ts).
 *
 * A study is set up on one Object: the selected one, kept while nothing else
 * is chosen. The panel shows its material (placeholder values for its
 * filament's type, until measured properties exist), its fixtures and forces
 * as lists of picked faces, and the mesh size, and runs it through the host.
 * Faces are picked in the viewport (borpa/sim/simLayer.ts): "Pick faces" on
 * a fixture or force, then click faces of the Object to add or remove them.
 * Each change is one undo step in the document (borpa/sim/study.ts).
 *
 * When the host reports a result, the panel fetches it and the viewport
 * draws it in place of the Object, coloured by von Mises stress or
 * displacement, deformed by a chosen scale; the value under the pointer is
 * shown beside it. An edit to the Object after the run greys the result.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Trans, useLingui } from '@lingui/react/macro'
import type { Scene as WasmScene } from '../../wasm/loader'
import { filamentForLink, readFilamentLinks } from '../buildMaterial'
import { getFilamentState, subscribeFilaments } from '../filaments'
import { fieldScalars, parseBsr, type BsrResult } from './bsr'
import { rampGradientCss } from './colourRamp'
import { faceForHandle, faceHandles, objectFaces, shapeSignature, simGeometry, weldSurface, type ObjectFaces } from './objectFaces'
import { hasPlaceholderFor, placeholderMaterial, type SimMaterial } from './placeholderMaterials'
import {
  canRunStructural,
  cancelSimJob,
  clearSimJob,
  failSimJobLocally,
  getSimBridgeState,
  startSimJob,
  subscribeSimBridge,
  type SimJob,
} from './simBridge'
import { simLayer, type SimArrow, type SimMark } from './simLayer'
import {
  addItem,
  dropLostPicks,
  emptyStudy,
  readStudy,
  removeItem,
  requestStudy,
  studyProblem,
  toggleFace,
  writeStudy,
  type ResolvedItem,
  type ResolvedStudy,
  type StoredStudy,
  type StudyProblem,
  type Vec3,
} from './study'

interface Props {
  scene: WasmScene
  /** Bumped on every document change. */
  docRev: number
  /** The selected world Object, or null. */
  selectedObject: bigint | null
  /** Select an Object in the app (a click on it in the viewport). */
  onSelectObject: (object: bigint) => void
  /** The panel changed the document (a study edit). */
  onDocChanged: () => void
  onToast: (message: string) => void
}

/* oxlint-disable lingui/no-unlocalized-strings -- SI unit symbols and the fallback filament type */
const MPA = 'MPa'
const NEWTON = 'N'
const MM = 'mm'
const SECOND = 's'
const FALLBACK_TYPE = 'PLA'
/* oxlint-enable lingui/no-unlocalized-strings */

const FIXTURE_COLOUR = 0x3b82f6
const FORCE_COLOUR = 0xf97316
const HOVER_COLOUR = 0xfacc15

const PANEL_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
  padding: '10px',
  fontSize: '11px',
  color: 'var(--text-secondary, #ccc)',
  overflowY: 'auto',
  height: '100%',
  boxSizing: 'border-box',
}
const SECTION_STYLE: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: '4px' }
const HEADING_STYLE: React.CSSProperties = {
  fontSize: '11px',
  fontWeight: 600,
  color: 'var(--text-primary, #eee)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '6px',
}
const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  minWidth: 0,
  fontSize: '11px',
  background: 'var(--surface-input, #444)',
  color: 'var(--text-primary, #eee)',
  border: '1px solid var(--border-strong, #555)',
  borderRadius: '3px',
  padding: '3px 5px',
  boxSizing: 'border-box',
}
const BTN_STYLE: React.CSSProperties = {
  fontSize: '11px',
  background: 'var(--surface-input, #444)',
  color: 'var(--text-primary, #eee)',
  border: '1px solid var(--border-strong, #555)',
  borderRadius: '3px',
  padding: '3px 8px',
  cursor: 'pointer',
}
const PRIMARY_BTN_STYLE: React.CSSProperties = {
  ...BTN_STYLE,
  background: 'var(--accent, #745FA8)',
  borderColor: 'var(--accent, #745FA8)',
  color: '#fff',
  fontWeight: 600,
  padding: '5px 12px',
}
const ITEM_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  padding: '6px',
  borderRadius: '4px',
  border: '1px solid var(--border-subtle, #444)',
}
const NOTE_STYLE: React.CSSProperties = { color: 'var(--text-tertiary, #999)', lineHeight: 1.4 }
const WARN_STYLE: React.CSSProperties = { color: 'var(--text-warning, #f0b429)', lineHeight: 1.4 }

/** A number field that commits on Enter or when it loses focus, so typing is
 *  not one undo step per key. */
function NumberField({
  value,
  onCommit,
  label,
  testId,
  min,
}: {
  value: number
  onCommit: (v: number) => void
  label: string
  testId?: string
  min?: number
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = () => {
    if (draft === null) return
    const v = Number(draft.replace(',', '.'))
    setDraft(null)
    if (Number.isFinite(v) && (min === undefined || v >= min) && v !== value) onCommit(v)
  }
  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={label}
      title={label}
      data-testid={testId}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit()
        if (e.key === 'Escape') setDraft(null)
        e.stopPropagation()
      }}
      style={INPUT_STYLE}
    />
  )
}

function fmt(v: number, digits = 3): string {
  if (!Number.isFinite(v)) return '–'
  if (v === 0) return '0'
  const a = Math.abs(v)
  if (a >= 1e5 || a < 1e-3) return v.toExponential(digits - 1)
  return Number(v.toPrecision(digits)).toString()
}

/** Triangle corners of `faces`, meters, for a mark. */
function faceTriangles(of: ObjectFaces, faces: readonly number[]): Float32Array {
  let count = 0
  for (const f of faces) count += of.faces[f]?.triangles.length ?? 0
  const out = new Float32Array(count * 9)
  let o = 0
  for (const f of faces) {
    for (const t of of.faces[f]?.triangles ?? []) {
      for (let k = 0; k < 3; k++) {
        const v = of.indices[3 * t + k]
        out[o++] = of.positions[3 * v]
        out[o++] = of.positions[3 * v + 1]
        out[o++] = of.positions[3 * v + 2]
      }
    }
  }
  return out
}

function diagonal(of: ObjectFaces): number {
  return Math.hypot(of.max[0] - of.min[0], of.max[1] - of.min[1], of.max[2] - of.min[2])
}

/** The arrow of a force: at the largest of its faces, pointing along it. */
function forceArrow(of: ObjectFaces, item: ResolvedItem & { vector: Vec3 }): SimArrow | null {
  const len = Math.hypot(...item.vector)
  if (len === 0 || item.faces.length === 0) return null
  let best = item.faces[0]
  for (const f of item.faces) if (of.faces[f].area > of.faces[best].area) best = f
  return {
    tip: of.faces[best].anchor,
    direction: [item.vector[0] / len, item.vector[1] / len, item.vector[2] / len],
    length: Math.max(diagonal(of) * 0.15, 1e-4),
    colour: FORCE_COLOUR,
  }
}

/** The Object's filament as placeholder material values. */
function objectMaterial(scene: WasmScene, object: bigint): { material: SimMaterial; type: string } {
  const { filaments } = getFilamentState()
  try {
    const links = readFilamentLinks(scene)
    for (const m of scene.object_materials(object)) {
      const link = links.get(m)
      if (link === undefined) continue
      const filament = filamentForLink(link, filaments)
      const type = filament?.type || link.type
      return { material: placeholderMaterial(filament?.name ?? link.preset, type, filament?.density ?? null), type }
    }
  } catch {
    // No filament can be read: the fallback below.
  }
  return { material: placeholderMaterial(FALLBACK_TYPE, FALLBACK_TYPE), type: '' }
}

interface LoadedResult {
  jobId: string
  object: bigint
  bsr: BsrResult
  /** The Object's shape when the study was sent. */
  signature: string
  /** Bounding-box diagonal at run time, mm. */
  diagonalMm: number
}

type Field = 'vonMises' | 'displacement'

/** What outlives the panel while the page is in the Model tab: the last
 *  result and whether it was shown, and the shape a running job was sent
 *  with. Coming back to the Sim tab after an edit shows the result greyed. */
const kept: {
  result: LoadedResult | null
  show: boolean
  run: { jobId: string; signature: string; diagonalMm: number } | null
} = { result: null, show: false, run: null }

export function SimPanel({ scene, docRev, selectedObject, onSelectObject, onDocChanged, onToast }: Props) {
  const { t } = useLingui()
  const bridge = useSyncExternalStore(subscribeSimBridge, getSimBridgeState, getSimBridgeState)
  const filamentState = useSyncExternalStore(subscribeFilaments, getFilamentState, getFilamentState)
  const [object, setObject] = useState<bigint | null>(selectedObject)
  const [picking, setPicking] = useState<string | null>(null)
  const [hoverFace, setHoverFace] = useState<number | null>(null)
  const [result, setResult] = useState<LoadedResult | null>(() => kept.result)
  const [resultError, setResultError] = useState<string | null>(null)
  const [showResult, setShowResult] = useState(() => kept.show)
  const [field, setField] = useState<Field>('vonMises')
  /** Deformation slider: 0 undeformed, 50 the automatic scale. */
  const [deform, setDeform] = useState(50)
  useEffect(() => {
    kept.result = result
    kept.show = showResult
  }, [result, showResult])

  // The study follows the selection; an empty selection keeps it.
  useEffect(() => {
    if (selectedObject !== null) setObject(selectedObject)
  }, [selectedObject])

  const worldObject = object !== null && scene.object_ids().includes(object) ? object : null

  const faces = useMemo<ObjectFaces | null>(() => {
    if (worldObject === null) return null
    try {
      return objectFaces(scene, worldObject)
    } catch {
      return null
    }
    // docRev: the Object's shape may have changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, worldObject, docRev])

  const resolved = useMemo<ResolvedStudy | null>(() => {
    if (faces === null) return null
    try {
      return readStudy(scene, faces)
    } catch (err) {
      console.error('Borpa: the study could not be read', err)
      return null
    }
  }, [scene, faces])

  const placeholder = useMemo(
    () => (worldObject === null ? null : objectMaterial(scene, worldObject)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [scene, worldObject, docRev, filamentState],
  )
  const material: SimMaterial | null =
    placeholder === null
      ? null
      : resolved?.stored.material
        ? { ...placeholder.material, E: resolved.stored.material.E, nu: resolved.stored.material.nu }
        : placeholder.material

  const watertight = useMemo(() => {
    if (worldObject === null) return false
    try {
      return scene.object_watertight(worldObject)
    } catch {
      return false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, worldObject, docRev])

  const signature = useMemo(() => (faces === null ? null : shapeSignature(faces)), [faces])
  const stale = result !== null && (result.object !== worldObject || result.signature !== signature)

  // A picked item that is gone (undo) stops picking.
  useEffect(() => {
    if (picking === null) return
    const keys = [...(resolved?.fixtures ?? []), ...(resolved?.loads ?? [])].map((i) => i.key)
    if (!keys.includes(picking)) setPicking(null)
  }, [resolved, picking])

  // ── Edits ──────────────────────────────────────────────────────────────

  const edit = useCallback(
    (work: () => void) => {
      try {
        work()
        onDocChanged()
      } catch (err: unknown) {
        onToast(err instanceof Error ? err.message : String(err))
      }
    },
    [onDocChanged, onToast],
  )

  const changeStudy = (label: string, change: (s: StoredStudy) => void) => {
    if (worldObject === null || faces === null) return
    // The first edit of an Object without a study makes it.
    const next = structuredClone(resolved?.stored ?? emptyStudy())
    change(next)
    edit(() => writeStudy(scene, worldObject, next, label))
  }

  const add = (kind: 'fixture' | 'force') => {
    if (worldObject === null) return
    edit(() => {
      const key = addItem(scene, worldObject, resolved?.stored ?? null, kind, kind === 'fixture' ? t`Add fixture` : t`Add force`)
      setPicking(key)
    })
  }

  // ── Viewport ───────────────────────────────────────────────────────────

  useEffect(() => {
    simLayer.setActive(true)
    return () => {
      simLayer.setActive(false)
      simLayer.setMarks([], [])
      simLayer.setHoverMark(null)
      simLayer.setResult(null)
      simLayer.setHiddenObject(null)
      simLayer.setProbeFormat(null)
    }
  }, [])

  // Clicks: pick faces, or choose the study's Object.
  const clickState = useRef({ picking, faces, resolved, worldObject })
  clickState.current = { picking, faces, resolved, worldObject }
  useEffect(
    () =>
      simLayer.onClick((pick) => {
        const s = clickState.current
        if (s.picking === null) {
          if (pick !== null && pick.instance === undefined && pick.object !== s.worldObject) {
            setObject(pick.object)
            onSelectObject(pick.object)
          }
          return
        }
        if (pick === null) return
        if (s.faces === null || s.resolved === null || pick.object !== s.worldObject || pick.instance !== undefined) {
          onToast(t`Pick faces of the Object this study is on.`)
          return
        }
        const face = faceForHandle(scene, s.faces, pick.face)
        if (face === null) return
        const isFixture = s.resolved.fixtures.some((f) => f.key === s.picking)
        const of = s.faces
        const res = s.resolved
        const key = s.picking
        edit(() => toggleFace(scene, of, res, key, face, isFixture ? t`Change fixed faces` : t`Change loaded faces`))
      }),
    [scene, edit, onSelectObject, onToast, t],
  )

  // Hover while picking.
  useEffect(() => {
    if (picking === null) {
      setHoverFace(null)
      return
    }
    return simLayer.onHover((pick) => {
      const s = clickState.current
      if (pick === null || s.faces === null || pick.object !== s.worldObject || pick.instance !== undefined) setHoverFace(null)
      else setHoverFace(faceForHandle(scene, s.faces, pick.face))
    })
  }, [picking, scene])

  useEffect(() => {
    simLayer.setHoverMark(
      hoverFace === null || faces === null || hoverFace >= faces.faces.length
        ? null
        : { triangles: faceTriangles(faces, [hoverFace]), colour: HOVER_COLOUR, opacity: 0.55 },
    )
  }, [hoverFace, faces])

  // The study's marks.
  useEffect(() => {
    if (faces === null || resolved === null) {
      simLayer.setMarks([], [])
      return
    }
    const marks: SimMark[] = []
    const arrows: SimArrow[] = []
    for (const f of resolved.fixtures) {
      marks.push({ triangles: faceTriangles(faces, f.faces), colour: FIXTURE_COLOUR, opacity: f.key === picking ? 0.75 : 0.5 })
    }
    for (const l of resolved.loads) {
      marks.push({ triangles: faceTriangles(faces, l.faces), colour: FORCE_COLOUR, opacity: l.key === picking ? 0.75 : 0.5 })
      const arrow = forceArrow(faces, l)
      if (arrow !== null) arrows.push(arrow)
    }
    simLayer.setMarks(marks, arrows)
  }, [faces, resolved, picking])

  // ── Jobs and results ───────────────────────────────────────────────────

  const job: SimJob | null = bridge.job !== null && bridge.job.object === worldObject ? bridge.job : null
  const running = job !== null && (job.state === 'starting' || job.state === 'running')
  const problem: StudyProblem | null = resolved === null || material === null ? 'no-fixture' : studyProblem(resolved, material)
  const solversReady = canRunStructural(bridge.capabilities)

  const run = () => {
    if (worldObject === null || material === null) return
    let fresh: ObjectFaces
    let study: ResolvedStudy | null
    try {
      fresh = objectFaces(scene, worldObject)
      study = readStudy(scene, fresh)
    } catch (err: unknown) {
      failSimJobLocally(worldObject, 'bad-study', err instanceof Error ? err.message : String(err))
      return
    }
    if (study === null) return
    const objectId = scene.object_public_ids(BigUint64Array.from([worldObject]))[0]
    const geometry = simGeometry(objectId, faceHandles(scene, fresh), weldSurface(fresh))
    setPicking(null)
    setShowResult(false)
    const jobId = startSimJob(worldObject, requestStudy(objectId, study, material), geometry)
    kept.run = { jobId, signature: shapeSignature(fresh), diagonalMm: diagonal(fresh) * 1000 }
  }

  // Fetch a finished job's result.
  useEffect(() => {
    const j = bridge.job
    if (j === null || j.state !== 'done' || result?.jobId === j.id) return
    const sig = kept.run
    if (sig === null || sig.jobId !== j.id) return
    let cancelled = false
    setResultError(null)
    void fetch(j.resultUrl)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return parseBsr(await r.arrayBuffer())
      })
      .then((bsr) => {
        if (cancelled) return
        setResult({ jobId: j.id, object: j.object, bsr, signature: sig.signature, diagonalMm: sig.diagonalMm })
        setShowResult(true)
        setDeform(50)
      })
      .catch((err: unknown) => {
        if (!cancelled) setResultError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [bridge.job, result])

  const shown = result !== null && showResult && result.object === worldObject ? result : null
  const displacementField = shown?.bsr.fields.find((f) => f.name === 'displacement') ?? null
  const shownField = shown?.bsr.fields.find((f) => f.name === field) ?? null
  const scalars = useMemo(() => (shownField === null ? null : fieldScalars(shownField)), [shownField])
  const maxDisp = useMemo(() => (displacementField === null ? 0 : fieldScalars(displacementField).max), [displacementField])
  const autoScale = shown !== null && maxDisp > 0 ? (0.05 * shown.diagonalMm) / maxDisp : 1
  const scale = deform <= 0 ? 0 : autoScale * Math.pow(10, (deform - 50) / 25)
  const unit = shownField?.unit ?? ''

  useEffect(() => {
    if (shown === null || scalars === null) {
      simLayer.setResult(null)
      simLayer.setHiddenObject(null)
      simLayer.setMarksVisible(true)
      simLayer.setProbeFormat(null)
      return
    }
    simLayer.setMarksVisible(false)
    simLayer.setHiddenObject(stale ? null : shown.object)
    simLayer.setResult({
      positions: shown.bsr.positions,
      triangles: shown.bsr.triangles,
      displacement: displacementField?.components === 3 ? displacementField.values : null,
      scale,
      values: scalars.values,
      min: scalars.min,
      max: scalars.max,
      stale,
    })
    simLayer.setProbeFormat(stale ? null : (v) => `${fmt(v, 4)} ${unit}`)
  }, [shown, scalars, displacementField, scale, stale, unit])

  // ── Wording ────────────────────────────────────────────────────────────

  const problemText = (p: StudyProblem): string => {
    switch (p) {
      case 'no-fixture':
        return t`Fix at least one face, or the part is free to fly away.`
      case 'empty-fixture':
        return t`A fixture has no faces. Pick its faces, or remove it.`
      case 'no-force':
        return t`Add a force.`
      case 'empty-force':
        return t`A force has no faces. Pick its faces, or remove it.`
      case 'zero-force':
        return t`Every force is zero.`
      case 'bad-material':
        return t`The material needs a stiffness above 0 and a Poisson's ratio from 0 to below 0.5.`
    }
  }
  const stageText = (j: SimJob): string => {
    if (j.state === 'starting') return t`Starting…`
    if (j.state !== 'running') return ''
    if (j.stage === 'mesh') return t`Meshing…`
    if (j.stage === 'solve') return t`Solving…`
    return t`Reading results…`
  }

  // ── Render ─────────────────────────────────────────────────────────────

  if (worldObject === null || faces === null) {
    return (
      <div style={PANEL_STYLE} data-testid="sim-panel">
        <div style={HEADING_STYLE}>
          <Trans>Simulation</Trans>
        </div>
        <div style={NOTE_STYLE} data-testid="sim-no-object">
          <Trans>Click an Object to set up a stress study on it.</Trans>
        </div>
      </div>
    )
  }

  const objectName = scene.object_name(worldObject) || t`Object`
  const placeholderType = placeholder !== null && hasPlaceholderFor(placeholder.type) ? placeholder.type : null
  const scaleText = fmt(scale, 3)
  const itemRow = (item: ResolvedItem, kind: 'fixture' | 'force', index: number, vector?: Vec3) => {
    const isPicking = picking === item.key
    const count = item.faces.length
    const lost = item.lost
    return (
      <div
        key={item.key}
        style={{ ...ITEM_STYLE, borderColor: isPicking ? 'var(--accent, #745FA8)' : ITEM_STYLE.border as string }}
        data-testid={kind === 'fixture' ? 'sim-fixture' : 'sim-force'}
      >
        <div style={HEADING_STYLE}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span
              aria-hidden="true"
              style={{
                width: '10px',
                height: '10px',
                borderRadius: '2px',
                background: `#${(kind === 'fixture' ? FIXTURE_COLOUR : FORCE_COLOUR).toString(16).padStart(6, '0')}`,
              }}
            />
            {kind === 'fixture' ? <Trans>Fixed {index}</Trans> : <Trans>Force {index}</Trans>}
          </span>
          <span style={{ display: 'flex', gap: '4px' }}>
            <button
              style={{ ...BTN_STYLE, ...(isPicking ? { background: 'var(--accent, #745FA8)', color: '#fff' } : {}) }}
              aria-pressed={isPicking}
              data-testid="sim-pick-faces"
              onClick={() => setPicking(isPicking ? null : item.key)}
            >
              {isPicking ? <Trans>Done</Trans> : <Trans>Pick faces</Trans>}
            </button>
            <button
              style={BTN_STYLE}
              title={t`Remove`}
              aria-label={t`Remove`}
              data-testid="sim-remove-item"
              onClick={() =>
                resolved !== null && edit(() => removeItem(scene, faces, resolved, item.key, kind === 'fixture' ? t`Remove fixture` : t`Remove force`))
              }
            >
              ×
            </button>
          </span>
        </div>
        <div data-testid="sim-face-count">
          {count === 1 ? <Trans>1 face</Trans> : <Trans>{count} faces</Trans>}
          {kind === 'fixture' && count > 0 && (
            <span style={NOTE_STYLE}>
              {' '}
              <Trans>held in place</Trans>
            </span>
          )}
        </div>
        {lost > 0 && (
          <div style={WARN_STYLE} data-testid="sim-lost">
            {lost === 1 ? <Trans>1 face was lost to an edit. Pick it again.</Trans> : <Trans>{lost} faces were lost to an edit. Pick them again.</Trans>}{' '}
            <button
              style={BTN_STYLE}
              onClick={() => resolved !== null && edit(() => dropLostPicks(scene, resolved, worldObject, item.key, t`Forget lost faces`))}
            >
              <Trans>Forget them</Trans>
            </button>
          </div>
        )}
        {vector !== undefined && (
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto 1fr auto 1fr auto', gap: '4px', alignItems: 'center' }}>
            {(['x', 'y', 'z'] as const).map((axis, k) => (
              <FragmentPair key={axis} label={axis}>
                <NumberField
                  value={vector[k]}
                  label={t`Force ${axis}, newtons`}
                  testId={`sim-force-${axis}`}
                  onCommit={(v) =>
                    changeStudy(t`Change force`, (s) => {
                      const l = s.loads.find((x) => x.key === item.key)
                      if (l !== undefined) l.vector[k] = v
                    })
                  }
                />
              </FragmentPair>
            ))}
            <span>{NEWTON}</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={PANEL_STYLE} data-testid="sim-panel">
      <div style={HEADING_STYLE}>
        <span>
          <Trans>Stress study</Trans>
        </span>
        <span style={{ fontWeight: 400, color: 'var(--text-secondary, #aaa)' }} data-testid="sim-object-name">
          {objectName}
        </span>
      </div>
      {!watertight && (
        <div style={WARN_STYLE} data-testid="sim-not-solid">
          <Trans>This Object is not a closed solid, so it cannot be simulated. Model Health can find the gaps.</Trans>
        </div>
      )}

      {shown === null ? (
        <>
          <div style={SECTION_STYLE}>
            <div style={HEADING_STYLE}>
              <Trans>Material</Trans>
            </div>
            {material !== null && (
              <>
                <div data-testid="sim-material-name">{material.name}</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '4px', alignItems: 'center' }}>
                  <span>
                    <Trans>Stiffness E</Trans>
                  </span>
                  <NumberField
                    value={material.E}
                    min={0}
                    label={t`Young's modulus, MPa`}
                    testId="sim-material-e"
                    onCommit={(v) => changeStudy(t`Change material`, (s) => (s.material = { E: v, nu: material.nu }))}
                  />
                  <span>{MPA}</span>
                  <span>
                    <Trans>Poisson's ratio ν</Trans>
                  </span>
                  <NumberField
                    value={material.nu}
                    min={0}
                    label={t`Poisson's ratio`}
                    testId="sim-material-nu"
                    onCommit={(v) => changeStudy(t`Change material`, (s) => (s.material = { E: material.E, nu: v }))}
                  />
                  <span />
                </div>
                {resolved?.stored.material ? (
                  <div style={NOTE_STYLE}>
                    <Trans>Your own values.</Trans>{' '}
                    <button style={BTN_STYLE} onClick={() => changeStudy(t`Change material`, (s) => (s.material = null))}>
                      <Trans>Use placeholder values</Trans>
                    </button>
                  </div>
                ) : (
                  <div style={NOTE_STYLE} data-testid="sim-material-placeholder">
                    {placeholderType !== null ? (
                      <Trans>Placeholder values for {placeholderType}, until measured filament properties are available.</Trans>
                    ) : (
                      <Trans>Placeholder values (PLA's), until measured filament properties are available.</Trans>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div style={SECTION_STYLE}>
            <div style={HEADING_STYLE}>
              <Trans>Fixed faces</Trans>
              <button style={BTN_STYLE} onClick={() => add('fixture')} data-testid="sim-add-fixture">
                <Trans>Add</Trans>
              </button>
            </div>
            {(resolved?.fixtures ?? []).map((f, i) => itemRow(f, 'fixture', i + 1))}
          </div>

          <div style={SECTION_STYLE}>
            <div style={HEADING_STYLE}>
              <Trans>Forces</Trans>
              <button style={BTN_STYLE} onClick={() => add('force')} data-testid="sim-add-force">
                <Trans>Add</Trans>
              </button>
            </div>
            {(resolved?.loads ?? []).map((l, i) => itemRow(l, 'force', i + 1, l.vector))}
          </div>
          {picking !== null && (
            <div style={NOTE_STYLE}>
              <Trans>Click faces of the Object to add them; click a picked face to take it out. Orbit with the middle button.</Trans>
            </div>
          )}

          <div style={SECTION_STYLE}>
            <div style={HEADING_STYLE}>
              <Trans>Mesh size</Trans>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input
                type="checkbox"
                checked={resolved?.stored.mesh.size == null}
                data-testid="sim-mesh-auto"
                onChange={(e) =>
                  changeStudy(t`Change mesh size`, (s) => {
                    s.mesh.size = e.target.checked ? null : Math.max(0.1, Number(((diagonal(faces) * 1000) / 40).toPrecision(2)))
                  })
                }
              />
              <Trans>Automatic</Trans>
            </label>
            {resolved?.stored.mesh.size != null && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '4px', alignItems: 'center' }}>
                <NumberField
                  value={resolved.stored.mesh.size}
                  min={0.01}
                  label={t`Mesh size, millimetres`}
                  testId="sim-mesh-size"
                  onCommit={(v) => changeStudy(t`Change mesh size`, (s) => (s.mesh.size = v))}
                />
                <span>{MM}</span>
              </div>
            )}
          </div>

          <div style={SECTION_STYLE}>
            {problem !== null && resolved !== null && (
              <div style={NOTE_STYLE} data-testid="sim-problem">
                {problemText(problem)}
              </div>
            )}
            {!solversReady && (
              <div style={WARN_STYLE} data-testid="sim-no-solvers">
                {bridge.capabilities === null ? (
                  <Trans>Simulations run inside Borpa.</Trans>
                ) : (
                  <Trans>Borpa did not find its solvers (Gmsh and CalculiX), so studies cannot run. Reinstalling Borpa puts them back.</Trans>
                )}
              </div>
            )}
            <div style={{ display: 'flex', gap: '6px' }}>
              <button
                style={{ ...PRIMARY_BTN_STYLE, opacity: running || problem !== null || !solversReady || !watertight ? 0.5 : 1 }}
                disabled={running || problem !== null || !solversReady || !watertight}
                onClick={run}
                data-testid="sim-run"
              >
                <Trans>Run</Trans>
              </button>
              {running && (
                <button style={BTN_STYLE} onClick={cancelSimJob} data-testid="sim-cancel">
                  <Trans>Cancel</Trans>
                </button>
              )}
              {result !== null && result.object === worldObject && !running && (
                <button style={BTN_STYLE} onClick={() => setShowResult(true)} data-testid="sim-show-result">
                  <Trans>Show result</Trans>
                </button>
              )}
            </div>
          </div>
        </>
      ) : null}

      {job !== null && running && (
        <div style={SECTION_STYLE} data-testid="sim-progress">
          <div>{stageText(job)}</div>
          <div style={{ height: '4px', borderRadius: '2px', background: 'var(--surface-input, #444)', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: job.state === 'running' && job.progress !== null ? `${Math.round(job.progress * 100)}%` : '30%',
                background: 'var(--accent, #745FA8)',
              }}
            />
          </div>
          {job.state === 'running' && job.message !== '' && <div style={NOTE_STYLE}>{job.message}</div>}
        </div>
      )}
      {job !== null && job.state === 'failed' && job.code !== 'cancelled' && (
        <div style={SECTION_STYLE} data-testid="sim-failed">
          <div style={WARN_STYLE}>
            <Trans>The study did not run.</Trans> {job.message}
          </div>
          {job.logTail !== '' && (
            <details>
              <summary>
                <Trans>Solver log</Trans>
              </summary>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: '10px', maxHeight: '200px', overflow: 'auto', margin: 0 }} data-testid="sim-log-tail">
                {job.logTail}
              </pre>
            </details>
          )}
          <button style={BTN_STYLE} onClick={clearSimJob}>
            <Trans>Dismiss</Trans>
          </button>
        </div>
      )}
      {job !== null && job.state === 'failed' && job.code === 'cancelled' && (
        <div style={NOTE_STYLE}>
          <Trans>Cancelled.</Trans>
        </div>
      )}
      {resultError !== null && (
        <div style={WARN_STYLE} data-testid="sim-result-error">
          <Trans>The result could not be read:</Trans> {resultError}
        </div>
      )}

      {shown !== null && scalars !== null && (
        <div style={SECTION_STYLE} data-testid="sim-result">
          <div style={HEADING_STYLE}>
            <Trans>Result</Trans>
            <button style={BTN_STYLE} onClick={() => setShowResult(false)} data-testid="sim-back-to-setup">
              <Trans>Back to setup</Trans>
            </button>
          </div>
          {stale && (
            <div style={WARN_STYLE} data-testid="sim-stale">
              <Trans>The model changed since this run. Run the study again for results that match it.</Trans>
            </div>
          )}
          <select
            value={field}
            onChange={(e) => setField(e.target.value as Field)}
            style={INPUT_STYLE}
            aria-label={t`Result shown`}
            data-testid="sim-field"
          >
            <option value="vonMises">{t`Stress (von Mises)`}</option>
            <option value="displacement">{t`Displacement`}</option>
          </select>
          <div data-testid="sim-legend">
            <div style={{ height: '12px', borderRadius: '2px', background: rampGradientCss() }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '2px' }}>
              <span data-testid="sim-legend-min">
                {fmt(scalars.min, 4)} {unit}
              </span>
              <span data-testid="sim-legend-max">
                {fmt(scalars.max, 4)} {unit}
              </span>
            </div>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
            <span>
              {scale === 0 ? <Trans>Deformation: not shown</Trans> : <Trans>Deformation shown ×{scaleText}</Trans>}
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={deform}
              onChange={(e) => setDeform(Number(e.target.value))}
              aria-label={t`Deformation scale`}
              data-testid="sim-deform"
            />
          </label>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button style={BTN_STYLE} onClick={() => setDeform(50)}>
              <Trans>Automatic</Trans>
            </button>
            <button
              style={BTN_STYLE}
              onClick={() => setDeform(Math.min(100, Math.max(1, 50 + 25 * Math.log10(1 / autoScale))))}
              disabled={autoScale <= 0}
            >
              <Trans>True scale</Trans>
            </button>
          </div>
          <SummaryTable bsr={shown.bsr} />
          <div style={NOTE_STYLE} data-testid="sim-estimate-note">
            <Trans>
              Results for printed parts are estimates: layers, walls and infill make a printed part less stiff and weaker than the solid
              material, and weakest across its layers.
            </Trans>
          </div>
          <div style={NOTE_STYLE}>
            <Trans>Point at the part to read the value there.</Trans>
          </div>
        </div>
      )}
    </div>
  )
}

function FragmentPair({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span>{label}</span>
      {children}
    </>
  )
}

function SummaryTable({ bsr }: { bsr: BsrResult }) {
  const { t } = useLingui()
  const s = bsr.summary
  const n = (k: string) => (typeof s[k] === 'number' ? (s[k] as number) : NaN)
  const rf = Array.isArray(s.reactionForce) ? (s.reactionForce as unknown[]).map((v) => (typeof v === 'number' ? v : NaN)) : []
  const nodes = fmt(n('nodes'), 6)
  const elements = fmt(n('elements'), 6)
  // oxlint-disable-next-line lingui/no-unlocalized-strings -- a list of numbers
  const reaction = rf.length === 3 ? rf.map((v) => fmt(v, 3)).join(', ') : '–'
  const rows: [string, string, string][] = [
    [t`Largest displacement`, fmt(n('maxDisplacement'), 4), MM],
    [t`Largest stress (von Mises)`, fmt(n('maxVonMises'), 4), MPA],
    [t`Reaction at fixtures`, reaction, NEWTON],
    [t`Mesh`, t`${nodes} nodes, ${elements} elements`, ''],
    [t`Mesh size`, fmt(n('meshSize'), 3), MM],
    [t`Time`, fmt(n('wallSeconds'), 3), SECOND],
  ]
  return (
    <table style={{ borderCollapse: 'collapse', width: '100%' }} data-testid="sim-summary">
      <tbody>
        {rows.map(([label, value, u]) => (
          <tr key={label}>
            <td style={{ padding: '1px 4px 1px 0', color: 'var(--text-tertiary, #999)' }}>{label}</td>
            <td style={{ padding: '1px 0', textAlign: 'right', color: 'var(--text-primary, #eee)' }}>
              {value} {u}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
