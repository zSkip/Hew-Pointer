//! Executable specs for the face follow (`document/annotation_follow.rs`):
//! a Push/Pull of a flat face of a world object carries every anchor of a
//! live annotation on that object that lies on the face, by the face's
//! translation; anchors anywhere else never move; an annotation that can no
//! longer sit on the geometry is frozen and `detached`; undo and redo
//! restore anchors and the flag exactly, in the Push/Pull's own undo step.

use crate::common;
use common::curves::*;
use kernel::{
    Anchor, Annotation, AnnotationId, BlendProfile, BlendSpec, CornerStyle, Document, EdgeId,
    KernelOp, NodeId, ObjectId, Plane, Point3, Vec3,
};
use proptest::prelude::*;

// ----------------------------------------------------------------- helpers

/// Extrudes the axis-aligned box `[x0, x1] × [y0, y1] × [0, h]`.
fn make_box(doc: &mut Document, x0: f64, y0: f64, x1: f64, y1: f64, h: f64) -> ObjectId {
    let s = doc.add_sketch(ground());
    let c = [
        p3(x0, y0, 0.0),
        p3(x1, y0, 0.0),
        p3(x1, y1, 0.0),
        p3(x0, y1, 0.0),
    ];
    let sk = doc.sketch_mut(s).expect("sketch");
    for i in 0..4 {
        sk.add_segment(c[i], c[(i + 1) % 4]).expect("segment");
    }
    let regions = doc.extrudable_regions(s).expect("sketch");
    assert_eq!(regions.len(), 1);
    doc.extrude_region(s, regions[0], h).expect("extrude").0
}

fn on(o: ObjectId, p: Point3) -> Anchor {
    Anchor {
        node: Some(NodeId::Object(o)),
        point: p,
    }
}

fn dim(doc: &mut Document, a: Anchor, b: Anchor) -> AnnotationId {
    doc.add_linear_dimension(
        a,
        b,
        Vec3::new(0.0, -0.5, 0.0),
        Plane::from_point_normal(a.point, Vec3::new(0.0, 0.0, 1.0)).expect("plane"),
        None,
    )
    .expect("dimension")
}

fn leader(doc: &mut Document, anchor: Anchor) -> AnnotationId {
    doc.add_leader_text(anchor, Vec3::new(0.2, 0.0, 0.2), "note".to_string())
        .expect("leader")
}

/// The face of `o` whose outward normal is `n`.
fn face(doc: &Document, o: ObjectId, n: Vec3) -> kernel::FaceId {
    face_with_normal(doc.object(o).expect("live object"), n)
}

fn push(doc: &mut Document, o: ObjectId, n: Vec3, distance: f64) {
    let face = face(doc, o, n);
    doc.apply_object_op(o, KernelOp::PushPull { face, distance })
        .expect("push/pull");
}

/// A dimension's or a leader's anchor points, in order (`a`, `b` / the
/// leader's anchor).
fn points(doc: &Document, id: AnnotationId) -> Vec<Point3> {
    match doc.annotation(id).expect("live annotation") {
        Annotation::LinearDimension { a, b, .. } => vec![a.point, b.point],
        Annotation::LeaderText { anchor, .. } => vec![anchor.point],
        other => panic!("unexpected annotation {other:?}"),
    }
}

fn near(p: Point3, q: Point3) -> bool {
    (p - q).length() < 1e-9
}

fn detached(doc: &Document, id: AnnotationId) -> bool {
    doc.annotation_detached(id).expect("live annotation")
}

/// Undo restores `before` byte for byte, redo `after`.
fn assert_undo_redo_exact(doc: &mut Document, before: &[u8], after: &[u8]) {
    doc.undo().expect("undo");
    assert_eq!(
        doc.save(),
        before,
        "one undo restores geometry and annotations"
    );
    doc.redo().expect("redo");
    assert_eq!(doc.save(), after, "redo re-applies both");
}

const X: Vec3 = Vec3::new(1.0, 0.0, 0.0);
const Z: Vec3 = Vec3::new(0.0, 0.0, 1.0);

// ------------------------------------------------------------------ specs

/// The offset and plane of a linear dimension whose end moves along the
/// dimension's own line are kept verbatim — the line's direction did not
/// change, so the placement is still exact — even when the offset was drawn
/// along the line (no perpendicular part to re-derive a placement from).
/// Pushing the face back restores the record exactly.
#[test]
fn an_end_moving_along_the_line_keeps_offset_and_plane() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 2.0, 3.0);
    let plane = Plane::from_point_normal(p3(0.0, 0.0, 7.0), Z).unwrap();
    let id = doc
        .add_linear_dimension(
            on(o, p3(0.0, 0.0, 0.0)),
            on(o, p3(1.0, 0.0, 0.0)),
            Vec3::new(0.3, 0.0, 0.0),
            plane,
            None,
        )
        .unwrap();
    let original = doc.annotation(id).unwrap().clone();
    push(&mut doc, o, X, 0.75);
    assert!(!detached(&doc, id));
    match doc.annotation(id).unwrap() {
        Annotation::LinearDimension {
            b,
            offset,
            plane: p,
            ..
        } => {
            assert_eq!(b.point, p3(1.75, 0.0, 0.0));
            assert_eq!(*offset, Vec3::new(0.3, 0.0, 0.0));
            assert_eq!(*p, plane);
        }
        other => panic!("{other:?}"),
    }
    push(&mut doc, o, X, -0.75);
    assert_eq!(doc.annotation(id).unwrap(), &original);
}

/// The core case: a dimension along a box's bottom front edge, its `b` end
/// at a corner of the +X face. Pulling that face carries `b` with it, so the
/// dimension measures the new length; `a` stays; ONE undo restores the
/// solid and the dimension; redo re-applies both.
#[test]
fn a_pull_carries_the_dimension_end_on_the_face() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 2.0, 3.0);
    let id = dim(&mut doc, on(o, p3(0.0, 0.0, 0.0)), on(o, p3(1.0, 0.0, 0.0)));
    let before = doc.save();
    let depth = doc.undo_depth();

    push(&mut doc, o, X, 0.5);
    let p = points(&doc, id);
    assert_eq!(
        p[0],
        p3(0.0, 0.0, 0.0),
        "the end off the face does not move"
    );
    assert!(near(p[1], p3(1.5, 0.0, 0.0)), "{:?}", p[1]);
    assert!(!detached(&doc, id));
    assert_eq!(doc.undo_depth(), depth + 1, "one undo step");
    let after = doc.save();
    assert_undo_redo_exact(&mut doc, &before, &after);
}

/// A push inward works the same way, and an anchor inside the face (not on
/// its boundary) is carried too; a leader keeps its text offset.
#[test]
fn a_push_carries_an_anchor_inside_the_face() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 2.0, 3.0);
    let id = leader(&mut doc, on(o, p3(1.0, 1.0, 1.5)));
    push(&mut doc, o, X, -0.25);
    assert!(near(points(&doc, id)[0], p3(0.75, 1.0, 1.5)));
    match doc.annotation(id).unwrap() {
        Annotation::LeaderText { offset, .. } => assert_eq!(*offset, Vec3::new(0.2, 0.0, 0.2)),
        other => panic!("{other:?}"),
    }
    assert!(!detached(&doc, id));
}

/// Both ends on the moved face: the whole dimension translates, its offset
/// unchanged.
#[test]
fn both_ends_on_the_face_translate_the_whole_dimension() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 2.0, 3.0);
    let id = dim(&mut doc, on(o, p3(1.0, 0.0, 0.0)), on(o, p3(1.0, 2.0, 0.0)));
    push(&mut doc, o, X, 0.5);
    let p = points(&doc, id);
    assert!(near(p[0], p3(1.5, 0.0, 0.0)) && near(p[1], p3(1.5, 2.0, 0.0)));
    match doc.annotation(id).unwrap() {
        Annotation::LinearDimension { offset, plane, .. } => {
            assert_eq!(*offset, Vec3::new(0.0, -0.5, 0.0));
            assert!(plane.signed_distance(p3(1.5, 0.0, 0.0)).abs() < 1e-9);
        }
        other => panic!("{other:?}"),
    }
}

/// Anchors that are not on the moved face never move, and a push that
/// moves no anchor records nothing beyond its own step.
#[test]
fn anchors_off_the_face_never_move() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 2.0, 3.0);
    let id = dim(&mut doc, on(o, p3(0.0, 2.0, 0.0)), on(o, p3(0.0, 2.0, 3.0)));
    let value = doc.annotation(id).unwrap().clone();
    push(&mut doc, o, X, 0.5);
    assert_eq!(doc.annotation(id).unwrap(), &value);
    assert!(!detached(&doc, id));
}

/// Only anchors naming the pushed object follow: another object's anchor
/// at a point of the moved face's plane stays where it is.
#[test]
fn an_anchor_on_another_object_does_not_follow() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 2.0, 3.0);
    let other = make_box(&mut doc, 1.0, 0.0, 2.0, 2.0, 3.0);
    let id = leader(&mut doc, on(other, p3(1.0, 1.0, 1.0)));
    push(&mut doc, o, X, -0.5);
    assert_eq!(points(&doc, id)[0], p3(1.0, 1.0, 1.0));
    assert!(!detached(&doc, id));
}

/// A push that removes the material an anchor sat on (the top pushed down
/// past it) cannot be followed: the dimension is frozen at its old values
/// and marked `detached`. Undo restores it attached; redo detaches it again.
#[test]
fn a_push_that_removes_an_anchors_material_detaches_it() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 2.0, 3.0);
    let id = dim(&mut doc, on(o, p3(0.0, 0.0, 2.5)), on(o, p3(1.0, 0.0, 2.5)));
    let value = doc.annotation(id).unwrap().clone();
    let before = doc.save();
    push(&mut doc, o, Z, -1.0);
    assert!(detached(&doc, id));
    assert_eq!(doc.annotation(id).unwrap(), &value, "frozen, not moved");
    let after = doc.save();
    doc.undo().expect("undo");
    assert!(!detached(&doc, id));
    assert_eq!(doc.save(), before);
    doc.redo().expect("redo");
    assert!(detached(&doc, id));
    assert_eq!(doc.save(), after);
}

/// A detached annotation is never touched by a later push, even with its
/// anchor on the moved face: a detach is only ever cleared by re-picking.
#[test]
fn a_detached_annotation_is_left_alone() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 2.0, 3.0);
    let other = make_box(&mut doc, 3.0, 0.0, 4.0, 2.0, 3.0);
    let id = dim(
        &mut doc,
        on(o, p3(1.0, 0.0, 0.0)),
        on(other, p3(3.0, 0.0, 0.0)),
    );
    doc.delete_node(NodeId::Object(other)).expect("delete");
    assert!(detached(&doc, id));
    let value = doc.annotation(id).unwrap().clone();
    push(&mut doc, o, X, 0.5);
    assert_eq!(doc.annotation(id).unwrap(), &value);
    assert!(detached(&doc, id));
}

/// A driven length (`set_linear_dimension_length`) moves a face like a
/// Push/Pull, so every other annotation on that face rides along, in the
/// drive's one undo step.
#[test]
fn a_drive_carries_other_annotations_on_the_face() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 2.0, 3.0);
    let driven = dim(&mut doc, on(o, p3(0.0, 0.0, 0.0)), on(o, p3(1.0, 0.0, 0.0)));
    let rider = dim(&mut doc, on(o, p3(1.0, 0.0, 3.0)), on(o, p3(1.0, 2.0, 3.0)));
    let note = leader(&mut doc, on(o, p3(1.0, 1.0, 1.0)));
    let before = doc.save();
    let depth = doc.undo_depth();
    doc.set_linear_dimension_length(driven, 1.5).expect("drive");
    let p = points(&doc, rider);
    assert!(near(p[0], p3(1.5, 0.0, 3.0)) && near(p[1], p3(1.5, 2.0, 3.0)));
    assert!(near(points(&doc, note)[0], p3(1.5, 1.0, 1.0)));
    assert!(near(points(&doc, driven)[1], p3(1.5, 0.0, 0.0)));
    assert_eq!(doc.undo_depth(), depth + 1);
    let after = doc.save();
    assert_undo_redo_exact(&mut doc, &before, &after);
}

fn round(radius: f64, edges: Vec<EdgeId>) -> BlendSpec {
    BlendSpec {
        edges,
        profile: BlendProfile::Round {
            radius,
            segments: 6,
        },
        primary: None,
        corners: CornerStyle::Default,
        stops: None,
        handles: Vec::new(),
    }
}

/// A face beside blends moves with the blends re-applied
/// (`push_pull_with_blends`): an anchor on it rides along, in that step.
#[test]
fn a_push_with_blends_reapplied_carries_the_anchor() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 1.0);
    let c = [
        p3(0.0, 0.0, 1.0),
        p3(1.0, 0.0, 1.0),
        p3(1.0, 1.0, 1.0),
        p3(0.0, 1.0, 1.0),
    ];
    let rim: Vec<EdgeId> = (0..4)
        .map(|i| edge_between(doc.object(o).unwrap(), c[i], c[(i + 1) % 4]))
        .collect();
    doc.blend_edges(o, &round(0.1, rim)).expect("fillet");
    let id = leader(&mut doc, on(o, p3(0.5, 0.5, 1.0)));
    let before = doc.save();
    let top = face(&doc, o, Z);
    doc.push_pull_with_blends(o, top, 0.1).expect("push");
    assert!(near(points(&doc, id)[0], p3(0.5, 0.5, 1.1)));
    assert!(!detached(&doc, id));
    let after = doc.save();
    assert_undo_redo_exact(&mut doc, &before, &after);
}

/// The centroid of a face's outer loop.
fn centroid(doc: &Document, o: ObjectId, f: kernel::FaceId) -> Point3 {
    let obj = doc.object(o).unwrap();
    let pts: Vec<Point3> = obj.loop_positions(obj.faces()[f].outer_loop).collect();
    let sum = pts.iter().fold(Vec3::new(0.0, 0.0, 0.0), |acc, p| {
        acc + (*p - p3(0.0, 0.0, 0.0))
    });
    p3(0.0, 0.0, 0.0) + sum * (1.0 / pts.len() as f64)
}

/// Resizing a blend does not translate the face pushed: an anchor on the
/// blend face cannot follow and detaches; undo restores it.
#[test]
fn pushing_a_blend_face_detaches_an_anchor_on_it() {
    let mut doc = Document::new();
    let o = make_box(&mut doc, 0.0, 0.0, 1.0, 1.0, 1.0);
    let edge = edge_between(doc.object(o).unwrap(), p3(0.0, 0.0, 1.0), p3(1.0, 0.0, 1.0));
    let (report, _) = doc.blend_edges(o, &round(0.1, vec![edge])).expect("fillet");
    let mid = report.new_faces[2];
    let at = centroid(&doc, o, mid);
    let id = leader(&mut doc, on(o, at));
    let before = doc.save();
    doc.push_pull_blend(o, mid, -0.01).expect("resize");
    assert!(detached(&doc, id));
    doc.undo().expect("undo");
    assert_eq!(doc.save(), before);
}

/// A cylinder wall's Push/Pull changes its radius: an anchor on the wall
/// detaches, an anchor on the cap (which only grows in its plane) stays.
#[test]
fn a_cylinder_wall_push_detaches_only_anchors_off_the_new_surface() {
    let mut doc = Document::new();
    let s = doc.add_sketch(ground());
    add_circle(doc.sketch_mut(s).unwrap(), p3(0.0, 0.0, 0.0), Z, 1.0, 24);
    let r = doc.extrudable_regions(s).unwrap()[0];
    let o = doc.extrude_region(s, r, 1.0).unwrap().0;
    let wall = doc
        .object(o)
        .unwrap()
        .faces()
        .iter()
        .find(|(_, f)| f.surface.is_some())
        .map(|(id, _)| id)
        .expect("a wall facet");
    let at = centroid(&doc, o, wall);
    let on_wall = leader(&mut doc, on(o, at));
    let on_cap = leader(&mut doc, on(o, p3(0.0, 0.0, 1.0)));
    doc.apply_object_op(
        o,
        KernelOp::PushPull {
            face: wall,
            distance: 0.1,
        },
    )
    .expect("radial push");
    assert!(detached(&doc, on_wall));
    assert!(!detached(&doc, on_cap));
    assert_eq!(points(&doc, on_cap)[0], p3(0.0, 0.0, 1.0));
}

// ----------------------------------------------------------- properties

/// A point on the box `[0, s.x] × [0, s.y] × [0, s.z]`'s face `(axis,
/// side)` at in-face parameters `(u, v)` (0 and 1 land on its edges).
fn face_point(s: [f64; 3], axis: usize, side: bool, u: f64, v: f64) -> Point3 {
    let mut c = [0.0; 3];
    c[axis] = if side { s[axis] } else { 0.0 };
    let (i, j) = ((axis + 1) % 3, (axis + 2) % 3);
    c[i] = u * s[i];
    c[j] = v * s[j];
    p3(c[0], c[1], c[2])
}

fn axis_normal(axis: usize, side: bool) -> Vec3 {
    let mut n = [0.0; 3];
    n[axis] = if side { 1.0 } else { -1.0 };
    Vec3::new(n[0], n[1], n[2])
}

/// Snaps a parameter to an edge now and then, so boundary anchors are
/// exercised as often as interior ones.
fn param() -> impl Strategy<Value = f64> {
    prop_oneof![Just(0.0), Just(1.0), 0.1f64..0.9]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]

    /// For a box with one leader on each face and a dimension spanning the
    /// pushed axis: a push or pull moves exactly the anchors on the moved
    /// face, by `normal · distance`; every other anchor keeps its point, or
    /// — when the push removed the material under it — its annotation is
    /// frozen and detached. Undo and redo are byte-exact, and pulling the
    /// face back restores every attached anchor.
    #[test]
    fn push_then_pull_back_restores_anchors(
        sx in 0.5f64..3.0,
        sy in 0.5f64..3.0,
        sz in 0.5f64..3.0,
        axis in 0usize..3,
        side in any::<bool>(),
        frac in -0.9f64..1.5,
        uv in prop::collection::vec((param(), param()), 6),
    ) {
        let s = [sx, sy, sz];
        let mut doc = Document::new();
        let o = make_box(&mut doc, 0.0, 0.0, sx, sy, sz);
        let mut notes = Vec::new();
        for (k, (u, v)) in uv.iter().enumerate() {
            let p = face_point(s, k / 2, k % 2 == 1, *u, *v);
            notes.push((leader(&mut doc, on(o, p)), p));
        }
        let a = on(o, face_point(s, axis, !side, 0.5, 0.5));
        let span = doc
            .add_linear_dimension(
                a,
                on(o, face_point(s, axis, side, 0.5, 0.5)),
                axis_normal((axis + 1) % 3, true) * 0.5,
                Plane::from_point_normal(a.point, axis_normal((axis + 2) % 3, true)).unwrap(),
                None,
            )
            .expect("dimension");
        let span_points = points(&doc, span);
        let distance = frac * s[axis];
        prop_assume!(distance.abs() > 1e-3);
        let n = axis_normal(axis, side);
        let start = doc.save();

        push(&mut doc, o, n, distance);
        // The moved face's new coordinate on the axis, and the box's
        // extent along it after the push.
        let (lo, hi) = if side { (0.0, s[axis] + distance) } else { (-distance, s[axis]) };
        for (id, p) in &notes {
            let c = [p.x, p.y, p.z][axis];
            let on_face = if side { (c - s[axis]).abs() < 1e-12 } else { c.abs() < 1e-12 };
            let got = points(&doc, *id)[0];
            if on_face {
                prop_assert!(!detached(&doc, *id));
                prop_assert!(near(got, *p + n * distance), "{got:?} vs {p:?}");
            } else {
                prop_assert_eq!(got, *p, "an anchor off the face never moves");
                let inside = c >= lo - 1e-12 && c <= hi + 1e-12;
                prop_assert_eq!(detached(&doc, *id), !inside);
            }
        }
        prop_assert!(!detached(&doc, span));
        let moved = points(&doc, span);
        prop_assert_eq!(moved[0], span_points[0]);
        prop_assert!(near(moved[1], span_points[1] + n * distance));
        let after = doc.save();

        doc.undo().expect("undo");
        prop_assert_eq!(doc.save(), start.clone());
        doc.redo().expect("redo");
        prop_assert_eq!(doc.save(), after);

        push(&mut doc, o, n, -distance);
        for (id, p) in &notes {
            let got = points(&doc, *id)[0];
            prop_assert!(near(got, *p), "{got:?} vs {p:?}");
        }
        let back = points(&doc, span);
        prop_assert!(near(back[0], span_points[0]) && near(back[1], span_points[1]));

        doc.undo().expect("undo the pull back");
        doc.undo().expect("undo the push");
        prop_assert_eq!(doc.save(), start);
    }
}
