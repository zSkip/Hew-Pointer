//! STL import for Hew.
//!
//! I/O-free and WASM-bound (DEVELOPMENT.md rule 1 — depends on `kernel` +
//! `mesh-heal`, never the reverse). STL is the format the maker community
//! lives in — downloaded prints from Printables/Thingiverse arrive as `.stl`
//! — but it is the crudest interchange format Hew reads: a single
//! unstructured triangle soup with no shared vertices, no object grouping,
//! no names, no materials, and no units. Every other importer's foreign
//! structure (glTF nodes/meshes, COLLADA geometries, `.skp` components) is
//! absent here; [`build`] is what turns raw triangles back into distinct,
//! editable, watertight-or-honestly-leaky Objects.
//!
//! # Pipeline
//!
//! ```text
//! STL bytes ──parse.rs (auto-detect binary/ASCII)──> raw triangle soup
//!   ──build.rs (weld → split into shells → per-shell heal)──> kernel::ImportScene
//! ```
//!
//! No new external dependency: the binary layout is a fixed-width record and
//! the ASCII grammar is a handful of whitespace-separated tokens, both
//! straightforward on `std` alone — see `parse.rs`.

pub mod build;
pub mod parse;

/// Typed failures from [`import`].
///
/// The `Display` text is the exact, plain-language, user-facing copy from
/// DESIGN §6 — not developer jargon. `wasm-api` tags it `"STL: <display>"`,
/// and the app's `kernelErrors.ts` treats `STL` as a wrapper prefix (like
/// `DAE`/`glTF`/`SKP`), stripping the tag and showing the payload verbatim.
/// The `Parse` variant's inner `String` carries a developer-facing detail for
/// logs/`Debug` only; it is deliberately NOT surfaced in `Display`.
#[derive(Debug, Clone)]
pub enum StlError {
    /// The bytes are neither valid binary nor valid ASCII STL. The inner
    /// string is a developer detail (see the type docs); users see the fixed
    /// copy below.
    Parse(String),
    /// Structurally STL but empty: zero triangles in the file, or every
    /// parsed triangle was degenerate and healed away to nothing.
    Empty,
    /// Importing this many triangles would need more memory than is left
    /// ([`IMPORT_BYTES_PER_TRIANGLE`] each, [`kernel::memory`]): refused
    /// before anything is parsed.
    TooLarge {
        /// The file's triangle count ([`parse::triangle_count`]).
        triangles: usize,
    },
}

impl std::fmt::Display for StlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StlError::Parse(_) => write!(f, "This file isn't a valid STL."),
            StlError::Empty => write!(f, "This STL is empty."),
            StlError::TooLarge { triangles } => write!(
                f,
                "This STL has {} triangles, more than there is memory left to import. Reduce it in a mesh tool (decimate it) and import it again.",
                thousands(*triangles)
            ),
        }
    }
}

impl std::error::Error for StlError {}

/// `n` with a comma between each group of three digits.
fn thousands(n: usize) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// What importing one triangle holds at the import's peak: the parsed
/// soup, the weld and heal, the kernel object and, in the app, the render
/// mesh built right after. Measured on the WebAssembly build (about 650 to
/// 700 bytes from 1M to 5M triangles) with a margin; a 64-bit build needs
/// less (561).
pub const IMPORT_BYTES_PER_TRIANGLE: usize = 720;

/// The largest single buffer an import allocates per triangle: the parsed
/// corners (three `Point3`s).
const IMPORT_LARGEST_PER_TRIANGLE: usize = 72;

/// What importing `triangles` needs at its peak ([`IMPORT_BYTES_PER_TRIANGLE`]).
pub fn import_need(triangles: usize) -> kernel::memory::Need {
    kernel::memory::Need::new(
        triangles.saturating_mul(IMPORT_BYTES_PER_TRIANGLE),
        triangles.saturating_mul(IMPORT_LARGEST_PER_TRIANGLE),
    )
}

/// A parsed STL, ready for `Document::ingest`.
pub struct StlScene {
    /// The import recipe (`ingest` consumes it).
    pub scene: kernel::ImportScene,
    /// Always empty for STL — no external resources are ever referenced.
    /// Present so the importer shape matches `ingest`'s
    /// `(scene, missing)` calling convention shared by every importer.
    pub missing: Vec<String>,
    /// User-visible warnings for the import report: non-manifold splits and
    /// leaky (open) pieces (DEVELOPMENT.md rule 4 — any decomposition the
    /// heal pass performs is reported, never silent).
    pub warnings: Vec<String>,
}

/// Parse STL bytes into a kernel [`ImportScene`](kernel::ImportScene) recipe.
/// I/O-free: STL never references external resources. Both binary and ASCII
/// STL are accepted; the encoding is auto-detected (see `parse.rs`).
///
/// `unit_scale` is meters-per-STL-unit — STL carries no units of its own, so
/// the caller (the UI's units-chooser prompt) decides; this crate is
/// unit-blind and just applies the scalar it is given.
///
/// `name_hint` names the imported Objects — the UI passes the picked file's
/// stem (e.g. `"bunny"` for `bunny.stl`). A single Object takes the stem;
/// multiples take `"<stem>"`, `"<stem> (2)"`, `"<stem> (3)"`, … `None` (or a
/// blank hint) falls back to `"Imported"`.
///
/// A watertight-after-healing piece becomes a watertight Object; a piece
/// with genuine gaps arrives leaky-flagged, never refused and never
/// fake-closed (DEVELOPMENT.md rule 4) — exactly like `.dae`/`.gltf` import.
///
/// On success returns a [`StlScene`]. A totally unparseable file, or one
/// that reduces to zero triangles, returns `Err(StlError)`; one whose
/// import cannot fit in the memory left ([`import_need`]) returns
/// [`StlError::TooLarge`] before parsing anything.
pub fn import(
    stl_bytes: &[u8],
    unit_scale: f64,
    name_hint: Option<&str>,
) -> Result<StlScene, StlError> {
    let triangles = parse::triangle_count(stl_bytes);
    if !kernel::memory::has_room(import_need(triangles)) {
        return Err(StlError::TooLarge { triangles });
    }
    let (raw, mut warnings) = parse::parse(stl_bytes)?;
    if raw.faces.is_empty() {
        return Err(StlError::Empty);
    }
    let (scene, build_warnings) = build::build_scene(raw, unit_scale, name_hint);
    if scene.roots.is_empty() {
        // Every parsed triangle healed away to nothing (fully degenerate
        // input) — as empty, in effect, as a zero-triangle file.
        return Err(StlError::Empty);
    }
    warnings.extend(build_warnings);
    Ok(StlScene {
        scene,
        missing: Vec::new(),
        warnings,
    })
}
