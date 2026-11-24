//! Executable specs for `export_3mf_with_document` / `read_embedded_document`
//! (src/document_3mf.rs): a 3MF any slicer reads as an ordinary model, with
//! the editable document carried as one extra, declared OPC part.

use std::io::{Cursor, Read};

use kernel::{Document, ImportNode, ImportScene, MeshRecipe, Point3};
use mesh_export::{
    EMBEDDED_DOCUMENT_CONTENT_TYPE, EMBEDDED_DOCUMENT_PART, EmbeddedDocumentError, export_3mf,
    export_3mf_with_document, read_embedded_document,
};

/// A unit cube ingested as a mesh, outward-wound.
fn box_document() -> Document {
    let positions: Vec<Point3> = (0..8)
        .map(|i| {
            Point3::new(
                if i & 1 == 0 { 0.0 } else { 1.0 },
                if i & 2 == 0 { 0.0 } else { 1.0 },
                if i & 4 == 0 { 0.0 } else { 1.0 },
            )
        })
        .collect();
    let faces = vec![
        vec![0, 2, 3, 1],
        vec![4, 5, 7, 6],
        vec![0, 1, 5, 4],
        vec![2, 6, 7, 3],
        vec![0, 4, 6, 2],
        vec![1, 3, 7, 5],
    ];
    let count = faces.len();
    let mesh = MeshRecipe {
        name: "Box".into(),
        positions,
        faces,
        face_materials: vec![kernel::serialize::NO_MATERIAL; count],
        face_uv_frames: vec![None; count],
        face_holes: vec![vec![]; count],
        base_material: kernel::serialize::NO_MATERIAL,
        tags: vec![],
        extra: Default::default(),
    };
    let scene = ImportScene {
        materials: vec![],
        defs: vec![],
        roots: vec![ImportNode::Mesh(mesh)],
        guides: vec![],
        tags: vec![],
        camera: None,
        scenes: vec![],
        section: None,
        view_style: None,
        extra: Default::default(),
        geo: None,
    };
    let mut doc = Document::new();
    doc.ingest(scene, vec![]).unwrap();
    doc
}

/// Every entry of a zip, in archive order, as (name, bytes).
fn entries(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("a valid zip");
    (0..zip.len())
        .map(|i| {
            let mut entry = zip.by_index(i).unwrap();
            let mut data = Vec::new();
            entry.read_to_end(&mut data).unwrap();
            (entry.name().unwrap().to_string(), data)
        })
        .collect()
}

fn entry<'a>(all: &'a [(String, Vec<u8>)], name: &str) -> &'a [u8] {
    &all.iter()
        .find(|(n, _)| n == name)
        .unwrap_or_else(|| panic!("entry {name} present"))
        .1
}

#[test]
fn the_document_round_trips_byte_identical() {
    let doc = box_document();
    let saved = doc.save_for_persistence();
    let package = export_3mf_with_document(&doc, 0, false, false, &saved).unwrap();
    assert_eq!(read_embedded_document(&package).unwrap(), saved);
    // And the bytes still load as the same document.
    let reopened = Document::load(&read_embedded_document(&package).unwrap()).unwrap();
    assert_eq!(
        reopened.state_hash(),
        Document::load(&saved).unwrap().state_hash()
    );
}

/// The carried bytes are opaque: any payload, of any length, comes back
/// exactly — including empty and ones that look like zips themselves.
#[test]
fn any_payload_round_trips_exactly() {
    let doc = box_document();
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut payloads: Vec<Vec<u8>> = vec![
        Vec::new(),
        vec![0],
        b"PK\x03\x04 not really a zip".to_vec(),
        doc.save_for_persistence(),
    ];
    for len in [1usize, 2, 17, 255, 4096, 70_000] {
        let bytes = (0..len)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                (seed >> 24) as u8
            })
            .collect();
        payloads.push(bytes);
    }
    for payload in payloads {
        let package = export_3mf_with_document(&doc, 0, false, false, &payload).unwrap();
        assert_eq!(
            read_embedded_document(&package).unwrap(),
            payload,
            "payload of {} bytes",
            payload.len()
        );
    }
}

/// The mesh a slicer reads is exactly today's `export_3mf`: same model
/// part, same relationships, in the same order, with the document part
/// appended after them.
#[test]
fn the_mesh_content_is_unchanged_from_export_3mf() {
    let doc = box_document();
    for (solids_only, cages) in [(false, false), (true, false), (false, true)] {
        let plain = entries(&export_3mf(&doc, 0, solids_only, cages).unwrap());
        let with = entries(&export_3mf_with_document(&doc, 0, solids_only, cages, b"doc").unwrap());
        assert_eq!(
            entry(&with, "3D/3dmodel.model"),
            entry(&plain, "3D/3dmodel.model")
        );
        assert_eq!(entry(&with, "_rels/.rels"), entry(&plain, "_rels/.rels"));
        let names: Vec<&str> = with.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(
            names,
            [
                "[Content_Types].xml",
                "_rels/.rels",
                "3D/3dmodel.model",
                EMBEDDED_DOCUMENT_PART
            ]
        );
    }
}

/// Every part has a declared content type: the two defaults `export_3mf`
/// declares, unchanged, plus one Override naming the document part.
#[test]
fn the_document_part_has_a_declared_content_type() {
    let doc = box_document();
    let plain = entries(&export_3mf(&doc, 0, false, false).unwrap());
    let with = entries(&export_3mf_with_document(&doc, 0, false, false, b"doc").unwrap());
    let plain_types = String::from_utf8(entry(&plain, "[Content_Types].xml").to_vec()).unwrap();
    let types = String::from_utf8(entry(&with, "[Content_Types].xml").to_vec()).unwrap();
    let override_line = format!(
        " <Override PartName=\"/{EMBEDDED_DOCUMENT_PART}\" ContentType=\"{EMBEDDED_DOCUMENT_CONTENT_TYPE}\"/>\n"
    );
    assert_eq!(
        types,
        plain_types.replace("</Types>\n", &format!("{override_line}</Types>\n"))
    );
}

#[test]
fn a_plain_3mf_reports_no_editable_model() {
    let plain = export_3mf(&box_document(), 0, false, false).unwrap();
    assert_eq!(
        read_embedded_document(&plain),
        Err(EmbeddedDocumentError::NoEditableModel)
    );
    assert_eq!(
        EmbeddedDocumentError::NoEditableModel.name(),
        "NoEditableModel"
    );
}

#[test]
fn bytes_that_are_not_a_package_say_so() {
    for junk in [&b""[..], b"solid ascii stl", b"PK\x03\x04truncated"] {
        let err = read_embedded_document(junk).unwrap_err();
        assert!(
            matches!(err, EmbeddedDocumentError::NotAPackage(_)),
            "{err:?}"
        );
        assert_eq!(err.name(), "NotAPackage");
    }
}

/// A document `export_3mf` has nothing to say about (here: empty) still
/// saves, with a model part that lists no objects, and still reopens.
#[test]
fn a_document_with_nothing_to_mesh_still_saves() {
    let doc = Document::new();
    assert_eq!(
        export_3mf(&doc, 0, false, false).unwrap_err().name(),
        "nothing_to_export"
    );
    let saved = doc.save_for_persistence();
    let package = export_3mf_with_document(&doc, 0, false, false, &saved).unwrap();
    let all = entries(&package);
    let model = String::from_utf8(entry(&all, "3D/3dmodel.model").to_vec()).unwrap();
    assert!(model.contains("<build>"), "{model}");
    assert!(!model.contains("<object "), "{model}");
    assert!(!model.contains("<item "), "{model}");
    assert_eq!(read_embedded_document(&package).unwrap(), saved);
}

#[test]
fn the_package_is_deterministic() {
    let doc = box_document();
    let saved = doc.save_for_persistence();
    assert_eq!(
        export_3mf_with_document(&doc, 0, false, false, &saved).unwrap(),
        export_3mf_with_document(&doc, 0, false, false, &saved).unwrap()
    );
}

/// OPC part names are case-insensitive; a writer that changed the case of
/// the entry name still yields the document.
#[test]
fn the_part_name_is_matched_case_insensitively() {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    zip.start_file("METADATA/Borpa_Document.HEW", opts).unwrap();
    std::io::Write::write_all(&mut zip, b"payload").unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    assert_eq!(read_embedded_document(&bytes).unwrap(), b"payload");
}
