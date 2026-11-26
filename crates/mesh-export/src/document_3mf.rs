//! A 3MF that also carries the editable document — the file an embedding
//! host saves when it wants one file that any slicer opens as an ordinary
//! model AND that the modeler reopens with everything (dimensions,
//! sketches, true curves, components) intact.
//!
//! **Layout.** The package is exactly what [`crate::export_3mf`] writes —
//! the same `_rels/.rels` and the same `3D/3dmodel.model`, byte for byte —
//! plus one extra OPC part, [`EMBEDDED_DOCUMENT_PART`], holding the
//! document's own serialized bytes (`Document::save_for_persistence`'s
//! output, untouched). `[Content_Types].xml` declares that part with an
//! `<Override>` for [`EMBEDDED_DOCUMENT_CONTENT_TYPE`], so every part in
//! the package has a declared content type and the package stays a valid
//! OPC container. Nothing references the part from a relationship: a 3MF
//! consumer reaches the model through `_rels/.rels` and never visits it.
//!
//! **Trust.** The mesh is derived from the document at save time. A reader
//! that finds the part trusts it; if another program re-saved the file and
//! kept the part while changing the mesh, the document wins on reopen.
//!
//! **Nothing to mesh.** A document with no meshable object (empty, or
//! drawing lines only) still saves: its model part lists no objects. This
//! is the one deliberate difference from [`crate::export_3mf`], which
//! refuses `nothing_to_export` — a save must never lose a document that a
//! plain export has nothing to say about.

use std::io::{Cursor, Read};

use kernel::Document;

use crate::{ExportError, Model3mf, RELS_XML, build_3mf_model, world_roots, write_3mf_package};

/// The zip entry name of the embedded document part (OPC part name
/// `/Metadata/borpa_document.hew`).
pub const EMBEDDED_DOCUMENT_PART: &str = "Metadata/borpa_document.hew";

/// The content type `[Content_Types].xml` declares for
/// [`EMBEDDED_DOCUMENT_PART`].
pub const EMBEDDED_DOCUMENT_CONTENT_TYPE: &str = "application/vnd.borpa.hew-document";

/// `export_3mf`'s content types plus the `<Override>` for the document part.
const CONTENT_TYPES_WITH_DOCUMENT_XML: &str = concat!(
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
    "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\n",
    " <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\n",
    " <Default Extension=\"model\" ContentType=\"application/vnd.ms-package.3dmanufacturing-3dmodel+xml\"/>\n",
    " <Override PartName=\"/Metadata/borpa_document.hew\" ContentType=\"application/vnd.borpa.hew-document\"/>\n",
    "</Types>\n"
);

/// Why a 3MF yielded no document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmbeddedDocumentError {
    /// The bytes are not a zip package at all (or the part could not be
    /// read out of it).
    NotAPackage(String),
    /// A readable package with no [`EMBEDDED_DOCUMENT_PART`]: an ordinary
    /// 3MF, or one another program re-saved without the part.
    NoEditableModel,
}

impl EmbeddedDocumentError {
    /// Stable machine name, used as the `CODE` of a thrown boundary error.
    pub fn name(&self) -> &'static str {
        match self {
            EmbeddedDocumentError::NotAPackage(_) => "NotAPackage",
            EmbeddedDocumentError::NoEditableModel => "NoEditableModel",
        }
    }

    /// The plain-language explanation.
    pub fn message(&self) -> String {
        match self {
            EmbeddedDocumentError::NotAPackage(why) => {
                format!("This file is not a 3MF package ({why}).")
            }
            EmbeddedDocumentError::NoEditableModel => {
                "This 3MF holds no editable model.".to_string()
            }
        }
    }
}

impl std::fmt::Display for EmbeddedDocumentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.name(), self.message())
    }
}

impl std::error::Error for EmbeddedDocumentError {}

/// Writes `doc` as a 3MF exactly as [`crate::export_3mf`] does with the
/// same arguments, plus `document` stored verbatim as
/// [`EMBEDDED_DOCUMENT_PART`] (see the module doc). `document` is the
/// caller's serialization of `doc`; it is not inspected.
///
/// Deterministic: the same inputs give the same bytes. Refuses only what
/// meshing itself refuses (`export_failed`, `too_many_occurrences`) and a
/// package that cannot fit in the memory left (`export_too_large`); a
/// document with nothing to mesh writes a model with no objects.
pub fn export_3mf_with_document(
    doc: &Document,
    segments_per_turn: u32,
    solids_only: bool,
    cages: bool,
    document: &[u8],
) -> Result<Vec<u8>, ExportError> {
    let normalized = doc.session_closed();
    let doc: &Document = &normalized;
    let model = match build_3mf_model(
        doc,
        &world_roots(doc),
        segments_per_turn,
        solids_only,
        true,
        cages,
        document.len(),
    ) {
        Ok(model) => model,
        Err(ExportError::NothingToExport) => Model3mf::default(),
        Err(e) => return Err(e),
    };
    // With nothing to mesh the model part lists no resources and an empty
    // build (the core spec allows zero items).
    write_3mf_package(
        &model,
        env!("CARGO_PKG_VERSION"),
        &[
            (
                "[Content_Types].xml",
                CONTENT_TYPES_WITH_DOCUMENT_XML.as_bytes(),
            ),
            ("_rels/.rels", RELS_XML.as_bytes()),
            (EMBEDDED_DOCUMENT_PART, document),
        ],
        2,
    )
}

/// Reads the document bytes back out of a package
/// [`export_3mf_with_document`] wrote: exactly the `document` it was given.
/// The part name is matched ASCII-case-insensitively, as OPC part names
/// are. Never modifies or validates the bytes — `Document::load` does
/// that.
///
/// # Errors
/// [`EmbeddedDocumentError::NotAPackage`] when `bytes` is not a readable
/// zip; [`EmbeddedDocumentError::NoEditableModel`] when it is but carries
/// no such part.
pub fn read_embedded_document(bytes: &[u8]) -> Result<Vec<u8>, EmbeddedDocumentError> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|e| EmbeddedDocumentError::NotAPackage(e.to_string()))?;
    let index = (0..zip.len()).find(|&i| {
        zip.name_for_index(i).is_some_and(|name| {
            name.is_ok_and(|name| {
                name.trim_start_matches('/')
                    .eq_ignore_ascii_case(EMBEDDED_DOCUMENT_PART)
            })
        })
    });
    let Some(index) = index else {
        return Err(EmbeddedDocumentError::NoEditableModel);
    };
    let mut entry = zip
        .by_index(index)
        .map_err(|e| EmbeddedDocumentError::NotAPackage(e.to_string()))?;
    let mut out = Vec::with_capacity(usize::try_from(entry.size()).unwrap_or(0));
    entry
        .read_to_end(&mut out)
        .map_err(|e| EmbeddedDocumentError::NotAPackage(e.to_string()))?;
    Ok(out)
}
