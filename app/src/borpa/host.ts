/**
 * Borpa host bridge — Hew embedded as a tab of the Borpa slicer.
 *
 * The host (a wxWidgets web view) defines `window.__BORPA_HOST__` before any
 * page script runs, and receives messages through `window.wx.postMessage`.
 * Every message is a JSON string carrying `borpa: 1`. The host's "Send to
 * Prepare" button calls `window.__borpaHew.sendToPlate()`, which answers with
 * a `plate` message (the document as a base64 3MF) or an `error` message.
 * The host also calls `window.__borpaHew.setFilaments(list)` with the
 * filaments of the selected printer (borpa/filaments.ts), after `ready` and
 * whenever its printer or filament presets change.
 * In the Sim tab the host also calls `setMode`, `setSimCapabilities` and
 * `simEvent`, and the page sends `sim.run` and `sim.cancel` (borpa/sim/).
 * The host side is `src/slic3r/GUI/HewPanel.cpp` in the Borpa repository.
 */

/** What the host tells the page about itself. */
export interface BorpaHostInfo {
  version: string
  dark: boolean
}

declare global {
  interface Window {
    __BORPA_HOST__?: BorpaHostInfo
    __borpaHew?: {
      sendToPlate?: () => Promise<void>
      setFilaments?: (list: unknown) => void
      setMode?: (mode: unknown) => void
      setSimCapabilities?: (caps: unknown) => void
      simEvent?: (event: unknown) => void
    }
    wx?: { postMessage: (message: string) => void }
  }
}

/** True when running inside the Borpa slicer. */
export const isBorpa: boolean =
  typeof window !== 'undefined' && '__BORPA_HOST__' in window

export type BorpaMessage =
  | { type: 'ready' }
  | { type: 'plate'; name: string; data: string; nonSolid: number }
  | { type: 'error'; code: 'not-ready' | 'empty' | 'export-failed'; message: string }
  | { type: 'sim.run'; job: string; study: unknown; geometry: unknown }
  | { type: 'sim.cancel'; job: string }

export type PlateExport =
  | { name: string; bytes: Uint8Array; nonSolid: number }
  | { code: 'not-ready' | 'empty' }

/** Send one message to the host. */
export function postToBorpa(msg: BorpaMessage): void {
  window.wx?.postMessage(JSON.stringify({ borpa: 1, ...msg }))
}

/** Base64 in 32 KiB slices, so no call receives the whole array as arguments. */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/**
 * Install `window.__borpaHew` and tell the host it is ready. `exportPlate`
 * produces the document as a 3MF. Returns an uninstall function.
 */
export function installBorpaBridge(exportPlate: () => Promise<PlateExport>): () => void {
  let running = false
  const sendToPlate = async (): Promise<void> => {
    // A second press while an export is running is dropped; the first answers.
    if (running) return
    running = true
    try {
      const result = await exportPlate()
      if ('code' in result) {
        postToBorpa({ type: 'error', code: result.code, message: '' })
      } else {
        postToBorpa({ type: 'plate', name: result.name, data: toBase64(result.bytes), nonSolid: result.nonSolid })
      }
    } catch (err: unknown) {
      postToBorpa({ type: 'error', code: 'export-failed', message: err instanceof Error ? err.message : String(err) })
    } finally {
      running = false
    }
  }
  window.__borpaHew = { ...window.__borpaHew, sendToPlate }
  postToBorpa({ type: 'ready' })
  return () => {
    if (window.__borpaHew !== undefined) delete window.__borpaHew.sendToPlate
  }
}
