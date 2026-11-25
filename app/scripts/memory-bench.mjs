#!/usr/bin/env node
// How much of the browser kernel's 4 GiB a large mesh takes, step by step.
//
// Loads the built WebAssembly kernel (app/src/wasm/pkg, from `pnpm --dir app
// wasm`) in Node, imports a watertight, slightly rippled sphere STL of the
// requested size through `Scene.import_stl` (the app's import path, render
// caches included), then saves it (`Scene.save`) and turns the saved bytes
// into a 3MF (`document_to_3mf`, the path Borpa's Save and Send to Prepare
// take). WebAssembly memory only grows, so each size runs in a process of its
// own and the figure after each step is the most the kernel has needed so
// far. A step that runs out of memory ends the kernel ("unreachable") and is
// reported as such.
//
// The native counterpart, with live and peak heap per step, is
// `cargo run --release -p memory-bench` (crates/memory-bench); it builds the
// same sphere.
//
// Usage: node scripts/memory-bench.mjs [triangles,...] [--pkg <dir>]
//   default sizes: 100000,1000000

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const appDir = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const pkgAt = args.indexOf('--pkg')
const pkgDir = pkgAt >= 0 ? resolve(args[pkgAt + 1]) : join(appDir, 'src', 'wasm', 'pkg')
const rest = args.filter((_, i) => pkgAt < 0 || (i !== pkgAt && i !== pkgAt + 1))

// A watertight lat-long sphere of about `n` triangles, radius 50, with a 1 %
// ripple so that no two faces are coplanar. crates/memory-bench builds the same.
function sphereStl(n) {
  const rings = Math.max(3, Math.round(Math.sqrt(n / 4)))
  const segs = 2 * rings
  const pts = []
  for (let i = 1; i < rings; i++) {
    const th = (Math.PI * i) / rings
    for (let j = 0; j < segs; j++) {
      const ph = (2 * Math.PI * j) / segs
      const r = 50 * (1 + 0.01 * Math.sin(7 * th) * Math.cos(5 * ph))
      pts.push([r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th)])
    }
  }
  const at = (i, j) => pts[i * segs + (j % segs)]
  const top = [0, 0, 50]
  const bottom = [0, 0, -50]
  const tris = []
  for (let j = 0; j < segs; j++) tris.push([top, at(0, j), at(0, j + 1)])
  for (let i = 0; i < rings - 2; i++) {
    for (let j = 0; j < segs; j++) {
      const a = at(i, j), b = at(i, j + 1), c = at(i + 1, j), d = at(i + 1, j + 1)
      tris.push([a, c, b], [b, c, d])
    }
  }
  for (let j = 0; j < segs; j++) tris.push([bottom, at(rings - 2, j + 1), at(rings - 2, j)])
  const buf = Buffer.alloc(84 + 50 * tris.length)
  buf.writeUInt32LE(tris.length, 80)
  let o = 84
  for (const t of tris) {
    o += 12
    for (const p of t) {
      buf.writeFloatLE(p[0], o)
      buf.writeFloatLE(p[1], o + 4)
      buf.writeFloatLE(p[2], o + 8)
      o += 12
    }
    o += 2
  }
  return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.length), count: tris.length }
}

async function measure(n) {
  const MB = (b) => Math.round(b / 1048576)
  const { bytes, count } = sphereStl(n)
  const out = { triangles: count, stlMB: MB(bytes.length) }
  const mod = await import(pathToFileURL(join(pkgDir, 'wasm_api.js')).href)
  const wasm = mod.initSync({ module: readFileSync(join(pkgDir, 'wasm_api_bg.wasm')) })
  const mem = () => MB(wasm.memory.buffer.byteLength)
  const time = (f) => {
    const t = performance.now()
    const v = f()
    return [v, +((performance.now() - t) / 1000).toFixed(1)]
  }
  try {
    const scene = new mod.Scene()
    ;[, out.importSec] = time(() => scene.import_stl(bytes, 0.001, 'sphere'))
    out.memAfterImportMB = mem()
    let doc
    ;[doc, out.saveSec] = time(() => scene.save())
    out.hewMB = MB(doc.length)
    out.memAfterSaveMB = mem()
    let pkg
    ;[pkg, out.threeMfSec] = time(() => mod.document_to_3mf(doc))
    out.threeMfMB = MB(pkg.length)
    out.memAfter3mfMB = mem()
  } catch (e) {
    out.error = String(e?.message || e).slice(0, 200)
    out.memAtErrorMB = mem()
  }
  return out
}

if (process.env.HEW_MEMORY_BENCH_CHILD) {
  console.log(JSON.stringify(await measure(Number(process.env.HEW_MEMORY_BENCH_CHILD))))
} else {
  const sizes = (rest[0] ?? '100000,1000000').split(',').map(Number)
  console.log(`kernel: ${pkgDir} (memory in MB is the kernel's linear memory, at most 4096)`)
  for (const n of sizes) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...args], {
      env: { ...process.env, HEW_MEMORY_BENCH_CHILD: String(n) },
      encoding: 'utf8',
    })
    const line = child.stdout.trim().split('\n').pop()
    console.log(line || `${n}: failed (exit ${child.status}) ${child.stderr.trim().slice(-300)}`)
  }
}
