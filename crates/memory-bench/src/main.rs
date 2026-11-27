// Outside the determinism-critical kernel scope (kernel / inference /
// tessellate / mesh-heal): the transcendentals here only shape the synthetic
// test mesh, which is generated the same way on every run of this binary and
// never reaches a document the app saves. The workspace clippy.toml ban is
// suppressed here deliberately.
#![allow(clippy::disallowed_methods)]

//! `memory-bench` — how much heap the kernel holds for a large mesh, step by
//! step, measured with a counting global allocator.
//!
//! The mesh is a watertight, slightly rippled sphere written as a binary STL
//! (no two faces coplanar, so nothing merges — the dense-mesh case of a 3D
//! scan or a finely exported model). For each requested triangle count it
//! imports the STL through the same path the app's `Scene::import_stl` takes
//! (`stl_import::import` then `Document::ingest`) and reports, per step, the
//! time, the heap still held afterwards, and the most the step held at once
//! above where it started:
//!
//! - `import`: STL bytes to a document;
//! - `save` / `load`: the native `.hew` encoding and reading it back;
//! - `export 3mf (live)`: `mesh_export::export_3mf_with_document` on the
//!   open document;
//! - `export 3mf (bytes)`: load from saved bytes, then export — what the
//!   wasm `document_to_3mf` does for Save and Send to Prepare inside Borpa;
//! - `move` + `undo`, `push/pull` + `undo`: one edit of the whole object and
//!   of one face, with the undo snapshot it leaves.
//!
//! `--hew <file>` measures load, save and export of an existing document
//! instead. The numbers are native (64-bit) heap; the browser build's wasm32
//! layout is somewhat smaller per record but its memory never shrinks, so
//! compare trends here and absolute ceilings with the app's own benchmark
//! (`app/scripts/memory-bench.mjs`).

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

use kernel::{Document, KernelOp, Transform, Vec3};

struct Counting;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn grew(n: usize) {
    let now = LIVE.fetch_add(n, Relaxed) + n;
    PEAK.fetch_max(now, Relaxed);
}

// SAFETY: every method forwards to `System` with the caller's arguments
// unchanged and only updates two counters on the side.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            grew(layout.size());
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        if !p.is_null() {
            grew(layout.size());
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size(), Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        if !p.is_null() {
            if new_size >= layout.size() {
                grew(new_size - layout.size());
            } else {
                LIVE.fetch_sub(layout.size() - new_size, Relaxed);
            }
        }
        p
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

struct Row {
    step: &'static str,
    seconds: f64,
    held_after: usize,
    step_peak: usize,
}

/// Run `f` as one measured step: its time, the heap held when it returns,
/// and the most it held at once above the heap it started from.
fn step<T>(rows: &mut Vec<Row>, name: &'static str, f: impl FnOnce() -> T) -> T {
    let start = LIVE.load(Relaxed);
    PEAK.store(start, Relaxed);
    let t = Instant::now();
    let out = f();
    let seconds = t.elapsed().as_secs_f64();
    rows.push(Row {
        step: name,
        seconds,
        held_after: LIVE.load(Relaxed),
        step_peak: PEAK.load(Relaxed) - start,
    });
    out
}

/// A watertight lat-long sphere of about `n` triangles as a binary STL, radius
/// 50 (file units), with a 1 % ripple so that no two faces are coplanar. The
/// same shape `app/scripts/memory-bench.mjs` builds.
fn sphere_stl(n: usize) -> (Vec<u8>, usize) {
    let rings = ((n as f64 / 4.0).sqrt().round() as usize).max(3);
    let segs = 2 * rings;
    let mut pts = Vec::with_capacity((rings - 1) * segs);
    for i in 1..rings {
        let th = std::f64::consts::PI * i as f64 / rings as f64;
        for j in 0..segs {
            let ph = 2.0 * std::f64::consts::PI * j as f64 / segs as f64;
            let r = 50.0 * (1.0 + 0.01 * (7.0 * th).sin() * (5.0 * ph).cos());
            pts.push([
                r * th.sin() * ph.cos(),
                r * th.sin() * ph.sin(),
                r * th.cos(),
            ]);
        }
    }
    let at = |i: usize, j: usize| pts[i * segs + j % segs];
    let (top, bottom) = ([0.0, 0.0, 50.0], [0.0, 0.0, -50.0]);
    let mut tris = Vec::with_capacity(2 * segs * (rings - 1));
    for j in 0..segs {
        tris.push([top, at(0, j), at(0, j + 1)]);
    }
    for i in 0..rings - 2 {
        for j in 0..segs {
            let (a, b, c, d) = (at(i, j), at(i, j + 1), at(i + 1, j), at(i + 1, j + 1));
            tris.push([a, c, b]);
            tris.push([b, c, d]);
        }
    }
    for j in 0..segs {
        tris.push([bottom, at(rings - 2, j + 1), at(rings - 2, j)]);
    }
    let mut out = Vec::with_capacity(84 + 50 * tris.len());
    out.extend_from_slice(&[0u8; 80]);
    out.extend_from_slice(&(tris.len() as u32).to_le_bytes());
    for t in &tris {
        out.extend_from_slice(&[0u8; 12]);
        for p in t {
            for c in p {
                out.extend_from_slice(&(*c as f32).to_le_bytes());
            }
        }
        out.extend_from_slice(&[0u8; 2]);
    }
    (out, tris.len())
}

fn mb(bytes: usize) -> f64 {
    bytes as f64 / 1_048_576.0
}

fn print_rows(title: &str, triangles: Option<usize>, base: usize, rows: &[Row]) {
    println!("\n{title}");
    match triangles {
        Some(_) => println!(
            "{:<20} {:>8} {:>12} {:>12} {:>10} {:>10}",
            "step", "seconds", "held MB", "peak MB", "held B/tri", "peak B/tri"
        ),
        None => println!(
            "{:<20} {:>8} {:>12} {:>12}",
            "step", "seconds", "held MB", "peak MB"
        ),
    }
    for r in rows {
        let held = r.held_after.saturating_sub(base);
        match triangles {
            Some(t) => println!(
                "{:<20} {:>8.2} {:>12.1} {:>12.1} {:>10} {:>10}",
                r.step,
                r.seconds,
                mb(held),
                mb(r.step_peak),
                held / t.max(1),
                r.step_peak / t.max(1),
            ),
            None => println!(
                "{:<20} {:>8.2} {:>12.1} {:>12.1}",
                r.step,
                r.seconds,
                mb(held),
                mb(r.step_peak)
            ),
        }
    }
}

fn bench_sphere(requested: usize) -> Result<(), String> {
    let (stl, triangles) = sphere_stl(requested);
    let base = LIVE.load(Relaxed);
    let mut rows = Vec::new();

    let mut doc = Document::new();
    let object = step(&mut rows, "import", || -> Result<_, String> {
        let out =
            stl_import::import(&stl, 0.001, Some("sphere")).map_err(|e| format!("STL: {e}"))?;
        let (_, change) = doc
            .ingest(out.scene, out.missing)
            .map_err(|e| format!("ingest: {e}"))?;
        change
            .objects_touched
            .first()
            .copied()
            .ok_or_else(|| "import made no object".to_string())
    })?;
    let stl_len = stl.len();
    drop(stl);
    let base = base.saturating_sub(stl_len);

    let saved = step(&mut rows, "save", || doc.save());
    step(&mut rows, "load", || {
        Document::load(&saved)
            .map(drop)
            .map_err(|e| format!("load: {e}"))
    })?;
    step(&mut rows, "export 3mf (live)", || {
        mesh_export::export_3mf_with_document(&doc, 0, false, false, &saved)
            .map(drop)
            .map_err(|e| format!("export: {}", e.message()))
    })?;
    step(&mut rows, "export 3mf (bytes)", || -> Result<(), String> {
        let reloaded = Document::load(&saved).map_err(|e| format!("load: {e}"))?;
        mesh_export::export_3mf_with_document(&reloaded, 0, false, false, &saved)
            .map(drop)
            .map_err(|e| format!("export: {}", e.message()))
    })?;

    step(&mut rows, "move", || {
        doc.transform_object(object, &Transform::translation(Vec3::new(0.01, 0.0, 0.0)))
            .map(drop)
            .map_err(|e| format!("move: {e}"))
    })?;
    step(&mut rows, "undo move", || {
        doc.undo().map(drop).map_err(|e| format!("undo: {e}"))
    })?;

    let face = doc
        .object(object)
        .and_then(|o| o.faces().keys().next())
        .ok_or("the object has no faces")?;
    step(&mut rows, "push/pull", || {
        doc.apply_object_op(
            object,
            KernelOp::PushPull {
                face,
                distance: 0.001,
            },
        )
        .map(drop)
        .map_err(|e| format!("push/pull: {e}"))
    })?;
    step(&mut rows, "undo push/pull", || {
        doc.undo().map(drop).map_err(|e| format!("undo: {e}"))
    })?;

    print_rows(
        &format!(
            "sphere, {triangles} triangles (STL {:.1} MB, .hew {:.1} MB); held = document + undo",
            mb(stl_len),
            mb(saved.len())
        ),
        Some(triangles),
        base,
        &rows,
    );
    Ok(())
}

fn bench_hew(path: &str) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{path}: {e}"))?;
    let base = LIVE.load(Relaxed);
    let mut rows = Vec::new();
    let doc = step(&mut rows, "load", || {
        Document::load(&bytes).map_err(|e| format!("load: {e}"))
    })?;
    let saved = step(&mut rows, "save", || doc.save());
    step(&mut rows, "export 3mf (live)", || {
        mesh_export::export_3mf_with_document(&doc, 0, false, false, &saved)
            .map(drop)
            .map_err(|e| format!("export: {}", e.message()))
    })?;
    print_rows(
        &format!("{path} ({:.1} MB)", mb(bytes.len())),
        None,
        base,
        &rows,
    );
    Ok(())
}

const USAGE: &str = "usage: memory-bench [--triangles N[,N...]] [--hew FILE]...
  --triangles  sphere sizes to measure (default 100000,1000000)
  --hew        also measure load, save and 3MF export of a .hew document";

fn main() {
    let mut sizes = vec![100_000, 1_000_000];
    let mut hews = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--triangles" => {
                let list = args.next().unwrap_or_default();
                let parsed: Result<Vec<usize>, _> =
                    list.split(',').map(|s| s.trim().parse()).collect();
                match parsed {
                    Ok(v) if !v.is_empty() => sizes = v,
                    _ => {
                        eprintln!("{USAGE}");
                        std::process::exit(2);
                    }
                }
            }
            "--hew" => match args.next() {
                Some(path) => hews.push(path),
                None => {
                    eprintln!("{USAGE}");
                    std::process::exit(2);
                }
            },
            _ => {
                eprintln!("{USAGE}");
                std::process::exit(if arg == "--help" || arg == "-h" { 0 } else { 2 });
            }
        }
    }

    let mut failed = false;
    for n in sizes {
        if let Err(e) = bench_sphere(n) {
            eprintln!("sphere {n}: {e}");
            failed = true;
        }
    }
    for path in &hews {
        if let Err(e) = bench_hew(path) {
            eprintln!("{e}");
            failed = true;
        }
    }
    if failed {
        std::process::exit(1);
    }
}
