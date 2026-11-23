//! Executable specs for [`Document::set_linear_dimension_length`]: typing a
//! length into a linear dimension moves the model (a Push/Pull of the face
//! the dimension ends on, or a Move of the object it ends on) and the
//! dimension with it, as one undo entry; every refusal leaves the document
//! byte-identical.

use kernel::{
    Anchor, Annotation, AnnotationId, DimensionDriveError, DimensionDriveMove, DimensionEnd,
    Document, DocumentError, NodeId, ObjectId, Plane, Point3, Vec3, WatertightState,
};
use proptest::prelude::*;

// ----------------------------------------------------------------- helpers

/// Extrudes the axis-aligned box `[x0, x1] × [y0, y1] × [z0, z0 + h]`.
fn make_box(doc: &mut Document, x0: f64, y0: f64, x1: f64, y1: f64, z0: f64, h: f64) -> ObjectId {
    let plane = Plane::from_polygon(&[
        Point3::new(0.0, 0.0, z0),
        Point3::new(1.0, 0.0, z0),
        Point3::new(0.0, 1.0, z0),
    ])
    .expect("plane");
    let s = doc.add_sketch(plane);
    let c = [
        Point3::new(x0, y0, z0),
        Point3::new(x1, y0, z0),
        Point3::new(x1, y1, z0),
        Point3::new(x0, y1, z0),
    ];
    let sk = doc.sketch_mut(s).expect("sketch");
    for i in 0..4 {
        sk.add_segment(c[i], c[(i + 1) % 4]).expect("segment");
    }
    let regions = doc.extrudable_regions(s).expect("sketch");
    assert_eq!(regions.len(), 1);
    doc.extrude_region(s, regions[0], h).expect("extrude").0
}

fn on(node: Option<ObjectId>, p: Point3) -> Anchor {
    Anchor {
        node: node.map(NodeId::Object),
        point: p,
    }
}

fn xy_plane() -> Plane {
    Plane::from_polygon(&[
        Point3::new(0.0, 0.0, 0.0),
        Point3::new(1.0, 0.0, 0.0),
        Point3::new(0.0, 1.0, 0.0),
    ])
    .expect("plane")
}

fn dim(doc: &mut Document, a: Anchor, b: Anchor, text: Option<&str>) -> AnnotationId {
    doc.add_linear_dimension(
        a,
        b,
        Vec3::new(0.0, -0.5, 0.0),
        xy_plane(),
        text.map(str::to_string),
    )
    .expect("dimension")
}

/// The axis-aligned bounds of an object's vertices.
fn bounds(doc: &Document, o: ObjectId) -> (Point3, Point3) {
    let obj = doc.object(o).expect("live object");
    let mut lo = Point3::new(f64::MAX, f64::MAX, f64::MAX);
    let mut hi = Point3::new(f64::MIN, f64::MIN, f64::MIN);
    for v in obj.vertices().values() {
        let p = v.position;
        lo = Point3::new(lo.x.min(p.x), lo.y.min(p.y), lo.z.min(p.z));
        hi = Point3::new(hi.x.max(p.x), hi.y.max(p.y), hi.z.max(p.z));
    }
    (lo, hi)
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() < 1e-9
}

fn assert_bounds(doc: &Document, o: ObjectId, lo: [f64; 3], hi: [f64; 3]) {
    let (l, h) = bounds(doc, o);
    let got = [l.x, l.y, l.z, h.x, h.y, h.z];
    let want = [lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]];
    assert!(
        got.iter().zip(want).all(|(g, w)| close(*g, w)),
        "bounds {got:?}, expected {want:?}"
    );
}

fn linear(doc: &Document, id: AnnotationId) -> (Anchor, Anchor, Option<String>) {
    match doc.annotation(id).expect("live annotation") {
        Annotation::LinearDimension {
            a,
            b,
            text_override,
            ..
        } => (*a, *b, text_override.clone()),
        other => panic!("expected a linear dimension, got {other:?}"),
    }
}

fn length(doc: &Document, id: AnnotationId) -> f64 {
    let (a, b, _) = linear(doc, id);
    (b.point - a.point).length()
}

fn drive_err(e: DimensionDriveError) -> DocumentError {
    DocumentError::DimensionDrive(e)
}

/// `f` refuses with `want`, and the document is byte-identical with the
/// same undo depth afterwards.
fn assert_refuses(doc: &mut Document, id: AnnotationId, len: f64, want: DocumentError) {
    let bytes = doc.save();
    let depth = doc.undo_depth();
    let got = doc.set_linear_dimension_length(id, len).map(|_| ());
    assert_eq!(got, Err(want));
    assert_eq!(doc.save(), bytes, "a refusal leaves the document unchanged");
    assert_eq!(doc.undo_depth(), depth, "a refusal records nothing");
}

// ------------------------------------------------------------------ specs

/// The basic drive: a dimension along a box's bottom front edge grows the
/// box on that axis only — the face at `b` moves, the opposite face stays —
/// the solid stays watertight, the dimension measures the new length with
/// no override, and ONE undo restores the solid and the dimension exactly.
#[test]
fn setting_a_length_pushes_the_face_at_b_as_one_undo_step() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 2.0, 0.0, 3.0);
    let id = dim(
        &mut doc,
        on(Some(o), Point3::new(0.0, 0.0, 0.0)),
        on(Some(o), Point3::new(1.0, 0.0, 0.0)),
        Some("custom"),
    );
    let before = doc.save();
    let depth = doc.undo_depth();

    let (drive, change) = doc.set_linear_dimension_length(id, 1.5).expect("drive");
    assert_eq!(drive.end, DimensionEnd::B);
    assert!(matches!(drive.moved, DimensionDriveMove::Face { object, .. } if object == o));
    assert!(close(drive.old_length, 1.0));
    assert!(change.objects_touched.contains(&o));
    assert_bounds(&doc, o, [0.0, 0.0, 0.0], [1.5, 2.0, 3.0]);
    assert_eq!(
        doc.object(o).unwrap().watertight(),
        WatertightState::Watertight
    );
    let (a, b, text) = linear(&doc, id);
    assert_eq!(a.point, Point3::new(0.0, 0.0, 0.0));
    assert!(close(b.point.x, 1.5) && close(b.point.y, 0.0) && close(b.point.z, 0.0));
    assert_eq!(b.node, Some(NodeId::Object(o)));
    assert_eq!(text, None);
    assert!(close(length(&doc, id), 1.5));
    assert_eq!(doc.annotation_detached(id), Some(false));
    assert_eq!(doc.undo_depth(), depth + 1, "one undo entry");
    let after = doc.save();

    doc.undo().expect("undo");
    assert_eq!(doc.save(), before, "one undo restores solid and dimension");
    doc.redo().expect("redo");
    assert_eq!(doc.save(), after, "redo re-applies both");
}

/// Shrinking works the same way (a push instead of a pull).
#[test]
fn a_shorter_length_pushes_the_face_in() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
    let id = dim(
        &mut doc,
        on(Some(o), Point3::new(0.0, 0.0, 1.0)),
        on(Some(o), Point3::new(0.0, 1.0, 1.0)),
        None,
    );
    doc.set_linear_dimension_length(id, 0.25).expect("drive");
    assert_bounds(&doc, o, [0.0, 0.0, 0.0], [1.0, 0.25, 1.0]);
    assert!(close(length(&doc, id), 0.25));
}

/// The END that moves is `b`, whichever way the dimension was drawn: drawn
/// from right to left, the left face moves.
#[test]
fn the_b_end_moves_when_both_ends_qualify() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
    let id = dim(
        &mut doc,
        on(Some(o), Point3::new(1.0, 0.0, 0.0)),
        on(Some(o), Point3::new(0.0, 0.0, 0.0)),
        None,
    );
    let (drive, _) = doc.set_linear_dimension_length(id, 2.0).expect("drive");
    assert_eq!(drive.end, DimensionEnd::B);
    assert_bounds(&doc, o, [-1.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    let (a, b, _) = linear(&doc, id);
    assert_eq!(a.point, Point3::new(1.0, 0.0, 0.0));
    assert!(close(b.point.x, -1.0));
}

/// With `b` a free point, the face at `a` moves instead, and `a` with it.
#[test]
fn the_a_end_moves_when_b_cannot() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
    let id = dim(
        &mut doc,
        on(Some(o), Point3::new(1.0, 0.5, 0.5)),
        on(None, Point3::new(3.0, 0.5, 0.5)),
        None,
    );
    let (drive, _) = doc.set_linear_dimension_length(id, 2.5).expect("drive");
    assert_eq!(drive.end, DimensionEnd::A);
    // `a` travels away from `b` by the half meter: the face at x = 1 is
    // pushed in to x = 0.5.
    assert_bounds(&doc, o, [0.0, 0.0, 0.0], [0.5, 1.0, 1.0]);
    let (a, b, _) = linear(&doc, id);
    assert!(close(a.point.x, 0.5));
    assert_eq!(b.point, Point3::new(3.0, 0.5, 0.5));
    assert!(close(length(&doc, id), 2.5));
}

/// A dimension across a gap between two faces of one object (a slot) moves
/// the face at `b`, which faces back toward `a`: widening the gap pushes
/// that face into the material.
#[test]
fn a_gap_dimension_moves_the_face_that_faces_back() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
    // Free `a` 0.5 to the left of the box; `b` on its left face, whose
    // normal (−x) points back at `a`.
    let id = dim(
        &mut doc,
        on(None, Point3::new(-0.5, 0.5, 0.5)),
        on(Some(o), Point3::new(0.0, 0.5, 0.5)),
        None,
    );
    doc.set_linear_dimension_length(id, 0.75).expect("drive");
    assert_bounds(&doc, o, [0.25, 0.0, 0.0], [1.0, 1.0, 1.0]);
    assert!(close(length(&doc, id), 0.75));
}

/// Anchors on two different objects: `b`'s object moves along the
/// dimension as a whole; `a`'s object stays; one undo restores both.
#[test]
fn ends_on_two_objects_move_the_b_object() {
    let mut doc = Document::new();
    let left = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
    let right = make_box(&mut doc, 2.0, 0.0, 3.0, 1.0, 0.0, 1.0);
    let id = dim(
        &mut doc,
        on(Some(left), Point3::new(1.0, 0.0, 0.0)),
        on(Some(right), Point3::new(2.0, 0.0, 0.0)),
        Some("gap"),
    );
    let before = doc.save();
    let depth = doc.undo_depth();

    let (drive, _) = doc.set_linear_dimension_length(id, 1.5).expect("drive");
    assert_eq!(drive.end, DimensionEnd::B);
    assert_eq!(drive.moved, DimensionDriveMove::Object { object: right });
    assert_bounds(&doc, left, [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    assert_bounds(&doc, right, [2.5, 0.0, 0.0], [3.5, 1.0, 1.0]);
    let (_, b, text) = linear(&doc, id);
    assert!(close(b.point.x, 2.5));
    assert_eq!(text, None);
    assert_eq!(doc.undo_depth(), depth + 1);
    doc.undo().expect("undo");
    assert_eq!(doc.save(), before);
}

/// Typing the length the dimension already shows clears an override as
/// one undo step and moves nothing; with no override there is nothing to
/// record at all.
#[test]
fn the_current_length_only_clears_the_override() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
    let id = dim(
        &mut doc,
        on(Some(o), Point3::new(0.0, 0.0, 0.0)),
        on(Some(o), Point3::new(1.0, 0.0, 0.0)),
        Some("one"),
    );
    let geometry = doc.object(o).unwrap().clone();
    let depth = doc.undo_depth();
    let (drive, _) = doc.set_linear_dimension_length(id, 1.0).expect("drive");
    assert_eq!(drive.moved, DimensionDriveMove::Nothing);
    assert_eq!(linear(&doc, id).2, None);
    assert_eq!(doc.undo_depth(), depth + 1);
    assert_bounds(&doc, o, [0.0, 0.0, 0.0], [1.0, 1.0, 1.0]);
    assert_eq!(
        doc.object(o).unwrap().vertices().len(),
        geometry.vertices().len()
    );

    let bytes = doc.save();
    doc.set_linear_dimension_length(id, 1.0).expect("no-op");
    assert_eq!(doc.undo_depth(), depth + 1, "nothing recorded");
    assert_eq!(doc.save(), bytes);
}

/// A diagonal dimension has no face square to it at either end.
#[test]
fn a_diagonal_dimension_refuses() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
    let id = dim(
        &mut doc,
        on(Some(o), Point3::new(0.0, 0.0, 0.0)),
        on(Some(o), Point3::new(1.0, 1.0, 0.0)),
        None,
    );
    assert_refuses(
        &mut doc,
        id,
        2.0,
        drive_err(DimensionDriveError::NoSquareFace),
    );
    // Refused even when the length would not change.
    assert_refuses(
        &mut doc,
        id,
        2f64.sqrt(),
        drive_err(DimensionDriveError::NoSquareFace),
    );
}

/// A length that is not a positive finite number refuses.
#[test]
fn an_invalid_length_refuses() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
    let id = dim(
        &mut doc,
        on(Some(o), Point3::new(0.0, 0.0, 0.0)),
        on(Some(o), Point3::new(1.0, 0.0, 0.0)),
        None,
    );
    for len in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        assert_refuses(
            &mut doc,
            id,
            len,
            drive_err(DimensionDriveError::InvalidDimensionLength),
        );
    }
}

/// A dimension whose object was deleted is detached and refuses.
#[test]
fn a_detached_dimension_refuses() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
    let id = dim(
        &mut doc,
        on(Some(o), Point3::new(0.0, 0.0, 0.0)),
        on(Some(o), Point3::new(1.0, 0.0, 0.0)),
        None,
    );
    doc.delete_node(NodeId::Object(o)).expect("delete");
    assert_eq!(doc.annotation_detached(id), Some(true));
    assert_refuses(
        &mut doc,
        id,
        2.0,
        drive_err(DimensionDriveError::DimensionDetached),
    );
}

/// Two free points name no geometry to move.
#[test]
fn free_anchors_refuse() {
    let mut doc = Document::new();
    let id = dim(
        &mut doc,
        on(None, Point3::new(0.0, 0.0, 0.0)),
        on(None, Point3::new(1.0, 0.0, 0.0)),
        None,
    );
    assert_refuses(
        &mut doc,
        id,
        2.0,
        drive_err(DimensionDriveError::FreeAnchors),
    );
}

/// An anchor whose point is no longer on its object refuses.
#[test]
fn an_anchor_off_its_object_refuses() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
    let id = dim(
        &mut doc,
        on(Some(o), Point3::new(0.0, 0.0, 0.0)),
        on(Some(o), Point3::new(1.5, 0.0, 0.0)),
        None,
    );
    assert_refuses(
        &mut doc,
        id,
        2.0,
        drive_err(DimensionDriveError::AnchorOffGeometry),
    );
}

/// An anchor on a group (not an object) is out of scope for now.
#[test]
fn an_anchor_on_a_group_refuses() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
    let (g, _) = doc.group_nodes(&[NodeId::Object(o)]).expect("group");
    let id = doc
        .add_linear_dimension(
            Anchor {
                node: Some(NodeId::Group(g)),
                point: Point3::new(0.0, 0.0, 0.0),
            },
            on(Some(o), Point3::new(1.0, 0.0, 0.0)),
            Vec3::new(0.0, -0.5, 0.0),
            xy_plane(),
            None,
        )
        .expect("dimension");
    assert_refuses(
        &mut doc,
        id,
        2.0,
        drive_err(DimensionDriveError::AnchorNotOnObject),
    );
}

/// Only a linear dimension can be driven.
#[test]
fn a_leader_refuses() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
    let id = doc
        .add_leader_text(
            on(Some(o), Point3::new(0.0, 0.0, 0.0)),
            Vec3::new(0.0, -0.5, 0.0),
            "note".to_string(),
        )
        .expect("leader");
    assert_refuses(
        &mut doc,
        id,
        2.0,
        drive_err(DimensionDriveError::NotLinearDimension),
    );
}

/// A refusal of the move itself is passed through unchanged: a locked
/// object refuses the push.
#[test]
fn a_refused_push_passes_through() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
    let id = dim(
        &mut doc,
        on(Some(o), Point3::new(0.0, 0.0, 0.0)),
        on(Some(o), Point3::new(1.0, 0.0, 0.0)),
        None,
    );
    doc.set_nodes_locked(&[NodeId::Object(o)], true)
        .expect("lock");
    let bytes = doc.save();
    let depth = doc.undo_depth();
    let got = doc.set_linear_dimension_length(id, 2.0);
    assert!(
        matches!(got, Err(DocumentError::LockedNode { .. })),
        "{got:?}"
    );
    assert_eq!(doc.save(), bytes);
    assert_eq!(doc.undo_depth(), depth);
}

/// A pull that would carry the face into other material of the same
/// object (the Push/Pull tool's merge-through, which can replace the
/// object) refuses rather than merging: the inner face of one upright of a
/// U pulled past the other upright.
#[test]
fn a_drive_through_other_material_refuses() {
    let mut doc = Document::new();
    let base = make_box(&mut doc, 0.0, 0.0, 3.0, 1.0, 0.0, 1.0);
    let left = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 0.5, 1.5);
    let right = make_box(&mut doc, 2.0, 0.0, 3.0, 1.0, 0.5, 1.5);
    let (u, _) = doc
        .boolean(kernel::BooleanOp::Union, base, left)
        .expect("union");
    let (u, _) = doc
        .boolean(kernel::BooleanOp::Union, u, right)
        .expect("union");
    let id = dim(
        &mut doc,
        on(Some(u), Point3::new(0.0, 0.0, 2.0)),
        on(Some(u), Point3::new(1.0, 0.0, 2.0)),
        None,
    );
    // Inside the gap is fine.
    doc.set_linear_dimension_length(id, 1.5).expect("drive");
    assert!(close(length(&doc, id), 1.5));
    doc.undo().expect("undo");
    // Past the far upright is not.
    assert_refuses(
        &mut doc,
        id,
        2.5,
        drive_err(DimensionDriveError::WouldCutThrough),
    );
}

/// A stale annotation id refuses.
#[test]
fn a_deleted_dimension_refuses() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
    let id = dim(
        &mut doc,
        on(Some(o), Point3::new(0.0, 0.0, 0.0)),
        on(Some(o), Point3::new(1.0, 0.0, 0.0)),
        None,
    );
    doc.delete_annotation(id).expect("delete");
    assert_refuses(&mut doc, id, 2.0, DocumentError::UnknownAnnotation);
}

// ------------------------------------------------------------- properties

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// Undo and redo of a drive are exact: undo restores the bytes before,
    /// redo the bytes after. Setting the length back to the original then
    /// restores the geometry (within tolerance), and the solid stays
    /// watertight throughout.
    #[test]
    fn a_drive_round_trips(
        w in 0.2f64..3.0,
        d in 0.2f64..3.0,
        h in 0.2f64..3.0,
        axis in 0usize..3,
        new_len in 0.05f64..5.0,
    ) {
        let mut doc = Document::new();
        let o = make_box(&mut doc, 0.0, 0.0, w, d, 0.0, h);
        let size = [w, d, h];
        let mut far = [0.0; 3];
        far[axis] = size[axis];
        let id = dim(
            &mut doc,
            on(Some(o), Point3::new(0.0, 0.0, 0.0)),
            on(Some(o), Point3::new(far[0], far[1], far[2])),
            None,
        );
        let before = doc.save();
        let vertices_before: Vec<Point3> = {
            let mut v: Vec<Point3> = doc.object(o).unwrap().vertices().values().map(|v| v.position).collect();
            v.sort_by(|p, q| (p.x, p.y, p.z).partial_cmp(&(q.x, q.y, q.z)).unwrap());
            v
        };

        doc.set_linear_dimension_length(id, new_len).expect("drive");
        prop_assert!((length(&doc, id) - new_len).abs() < 1e-9);
        prop_assert_eq!(doc.object(o).unwrap().watertight(), WatertightState::Watertight);
        let mut want_hi = size;
        want_hi[axis] = new_len;
        assert_bounds(&doc, o, [0.0, 0.0, 0.0], want_hi);
        let after = doc.save();

        doc.undo().expect("undo");
        prop_assert_eq!(doc.save(), before.clone());
        doc.redo().expect("redo");
        prop_assert_eq!(doc.save(), after);

        doc.set_linear_dimension_length(id, size[axis]).expect("set back");
        let mut vertices_back: Vec<Point3> = doc.object(o).unwrap().vertices().values().map(|v| v.position).collect();
        vertices_back.sort_by(|p, q| (p.x, p.y, p.z).partial_cmp(&(q.x, q.y, q.z)).unwrap());
        prop_assert_eq!(vertices_back.len(), vertices_before.len());
        for (p, q) in vertices_back.iter().zip(&vertices_before) {
            prop_assert!((*p - *q).length() < 1e-9, "{p:?} vs {q:?}");
        }
        prop_assert_eq!(doc.object(o).unwrap().watertight(), WatertightState::Watertight);
    }

    /// Any refusal leaves the document byte-identical: a diagonal
    /// dimension of any slope, at any requested length.
    #[test]
    fn a_refusal_changes_nothing(
        t in 0.05f64..0.95,
        new_len in -1.0f64..5.0,
    ) {
        let mut doc = Document::new();
        let o = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
        let id = dim(
            &mut doc,
            on(Some(o), Point3::new(0.0, 0.0, 0.0)),
            on(Some(o), Point3::new(1.0, t, 0.0)),
            None,
        );
        let bytes = doc.save();
        let depth = doc.undo_depth();
        prop_assert!(doc.set_linear_dimension_length(id, new_len).is_err());
        prop_assert_eq!(doc.save(), bytes);
        prop_assert_eq!(doc.undo_depth(), depth);
    }
}
