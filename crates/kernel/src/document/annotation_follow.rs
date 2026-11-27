//! Annotations follow a Push/Pull (docs/design/dimensions-text.md,
//! "Associativity"): when a push or pull moves a flat face of a world
//! object, every anchor of a live annotation on that object that lies on the
//! moved face moves with it, so a dimension keeps measuring the model
//! instead of showing a stale number. A second `impl Document` block, kept
//! out of `document.rs` for size, the way `curves.rs` and
//! `dimension_drive.rs` are.
//!
//! ## The contract
//!
//! A face follow wraps one Push/Pull of `face` of a world `object` by
//! `distance` — the plain translate ([`KernelOp::PushPull`]), the boss or
//! recess of a flat imprinted sub-face ([`KernelOp::ExtrudeSubFace`]), the
//! move of a face beside blends with the blends re-applied
//! ([`Document::push_pull_with_blends`]), and the resize of a blend face
//! ([`Document::push_pull_blend`]). It considers every live annotation that
//! is not `detached` and that has at least one anchor naming `object` whose
//! point lies on the object's surface before the push (an anchor already
//! off the surface was stale before this edit and is left as it is):
//!
//! - **Which anchors move.** When `face` is flat — no analytic surface and
//!   not a blend face — every anchor naming `object` whose point lies on
//!   `face` (on its plane within [`tol::PLANE_DIST`], inside its outer loop
//!   and outside its holes, or on one of its loops within
//!   [`tol::POINT_MERGE`]: its boundary edges and corners count) moves by
//!   the face's translation, `normal · distance`. No other anchor moves. A
//!   cylinder wall's Push/Pull changes a radius and a blend face's resizes a
//!   blend: neither translates the face, so no anchor moves for them.
//! - **How the record moves.** Through the same rules as a whole-node move
//!   ([`Annotation::carry_anchors`]): a linear dimension with both ends on
//!   the face translates whole; one with one end on the face re-derives its
//!   offset and plane from the two new points (the one-anchor rule), except
//!   when that end moves along the dimension's own line (a face square to
//!   the dimension), where the line keeps its direction and the offset and
//!   plane are kept verbatim; a leader moves its anchor and keeps its text
//!   offset.
//! - **When it detaches.** The annotation is frozen at its values before
//!   the push and marked `detached` when its record cannot be carried (a
//!   linear dimension whose two points would coincide, or whose offset
//!   would fall on its new line), or when any of its anchors on `object`
//!   that lay on the surface before the push — moved or not — no longer
//!   lies on any face of the object after it (the push removed the material
//!   it sat on, or reshaped the face under it without translating it). Never
//!   a partial write: either every anchor follows or none does.
//! - **Undo.** Every annotation the follow changed is recorded as a
//!   [`DocAction::UpdatedAnnotation`] with its exact before and after values
//!   and `detached` flags, a followup of the Push/Pull's own entry in ONE
//!   [`DocAction::Compound`], so undo and redo restore it by verbatim replay
//!   ([`Document::reanchor_touched`]'s posture), never by re-deriving it.
//!
//! Out of scope, left as they were: radial dimensions (they are drawn on
//! sketch circles with free anchors; one anchored to an object is neither
//! moved nor detached by a face follow), and faces of objects inside a
//! component definition (`push_pull_in_component`; nothing in the world
//! anchors to a definition member). A push that becomes a cut-through or a
//! merge-through ([`Document::push_pull_through`]) consumes the object, and
//! the annotations on it detach the way every consumed node's do.

use super::*;

/// A face's region captured before an edit changes it: its plane and the
/// positions of its outer loop and holes.
pub(super) struct FaceRegion {
    plane: Plane,
    outer: Vec<Point3>,
    holes: Vec<Vec<Point3>>,
}

impl FaceRegion {
    /// `face` of `object` as it is now; `None` for a stale face.
    pub(super) fn of(object: &Object, face: FaceId) -> Option<FaceRegion> {
        let f = object.faces().get(face)?;
        Some(FaceRegion {
            plane: f.plane,
            outer: object.loop_positions(f.outer_loop).collect(),
            holes: f
                .inner_loops
                .iter()
                .map(|&l| object.loop_positions(l).collect())
                .collect(),
        })
    }

    /// Whether `point` lies on the region: on its plane within
    /// [`tol::PLANE_DIST`], and inside the outer loop and outside the holes,
    /// or on one of the loops within [`tol::POINT_MERGE`].
    pub(super) fn holds(&self, point: Point3) -> bool {
        self.plane.signed_distance(point).abs() <= tol::PLANE_DIST
            && crate::geom2d::point_on_region(point, &self.outer, &self.holes, self.plane.normal())
    }
}

/// Whether `point` lies on any face of `object`.
pub(super) fn lies_on_surface(object: &Object, point: Point3) -> bool {
    object
        .faces()
        .keys()
        .any(|f| FaceRegion::of(object, f).is_some_and(|r| r.holds(point)))
}

/// The anchors of `annotation` a face follow considers, in a fixed order: a
/// linear dimension's `a` and `b`, a leader's anchor. None for a radial
/// dimension (out of scope, see the module doc).
fn follow_anchors(annotation: &Annotation) -> Vec<Anchor> {
    match annotation {
        Annotation::LinearDimension { a, b, .. } => vec![*a, *b],
        Annotation::LeaderText { anchor, .. } => vec![*anchor],
        Annotation::RadialDimension { .. } => Vec::new(),
    }
}

/// Carries `annotation`'s anchors chosen by `moves` by the translation `v`,
/// with [`Annotation::carry_anchors`]'s return contract. One case is kept
/// out of its one-anchor rule: a linear dimension with exactly one end
/// moving ALONG its own line (a face square to the dimension pushed, which
/// is what a driven length does). The line keeps its direction, so the
/// stored `offset` and `plane` still place the dimension exactly as before
/// and are kept verbatim rather than re-derived — re-deriving could only
/// lose information (an offset drawn along the line has no perpendicular
/// part to re-derive from) or flip the plane's sign. Only the moved point
/// changes; the record is degenerate (`Some(false)`) if the two points would
/// coincide.
fn carry(annotation: &mut Annotation, moves: &dyn Fn(&Anchor) -> bool, v: Vec3) -> Option<bool> {
    if let Annotation::LinearDimension { a, b, .. } = annotation
        && moves(a) != moves(b)
        && let Ok(dir) = (b.point - a.point).normalized()
        && (v - dir * v.dot(dir)).length() <= tol::NORMAL_DIRECTION * v.length()
    {
        let (new_a, new_b) = if moves(a) {
            (a.point + v, b.point)
        } else {
            (a.point, b.point + v)
        };
        if (new_b - new_a).normalized().is_err() {
            return Some(false);
        }
        a.point = new_a;
        b.point = new_b;
        return Some(true);
    }
    annotation.carry_anchors(moves, &Transform::translation(v))
}

/// One annotation a face follow will carry or check: the indices (into
/// [`follow_anchors`]) of its anchors naming the object that lay on the
/// object's surface before the push.
struct FollowEntry {
    annotation: AnnotationId,
    on_surface: Vec<usize>,
}

/// A face follow planned before its Push/Pull runs
/// ([`Document::plan_face_follow`]) and finished after it
/// ([`Document::finish_face_follow`]).
pub(super) struct FaceFollow {
    object: ObjectId,
    /// The moved face as it was, and its translation; `None` when the face
    /// does not translate (a cylinder wall, a blend face).
    moved: Option<(FaceRegion, Vec3)>,
    entries: Vec<FollowEntry>,
}

impl Document {
    /// Plans the face follow of a Push/Pull of `face` of `object` by
    /// `distance`, before it runs (see the module doc for the contract).
    /// Pure. `None` when no annotation is to be considered: the object is
    /// not a live world object, the face is stale, or nothing live and
    /// attached anchors on the object's surface.
    pub(super) fn plan_face_follow(
        &self,
        object: ObjectId,
        face: FaceId,
        distance: f64,
    ) -> Option<FaceFollow> {
        if !self.node_is_live(NodeId::Object(object)) {
            return None;
        }
        let node = Some(NodeId::Object(object));
        let obj = &self.objects[object].object;
        let entries: Vec<FollowEntry> = self
            .annotations
            .iter()
            .filter(|(_, rec)| !rec.hidden && !rec.detached)
            .filter_map(|(id, rec)| {
                let on_surface: Vec<usize> = follow_anchors(&rec.annotation)
                    .iter()
                    .enumerate()
                    .filter(|(_, anchor)| anchor.node == node && lies_on_surface(obj, anchor.point))
                    .map(|(i, _)| i)
                    .collect();
                (!on_surface.is_empty()).then_some(FollowEntry {
                    annotation: id,
                    on_surface,
                })
            })
            .collect();
        if entries.is_empty() {
            return None;
        }
        let f = obj.faces().get(face)?;
        let flat = f.surface().is_none() && obj.blend_of_face(face).is_none();
        let moved = flat
            .then(|| FaceRegion::of(obj, face).map(|r| (r, f.plane.normal() * distance)))
            .flatten();
        Some(FaceFollow {
            object,
            moved,
            entries,
        })
    }

    /// Finishes a planned face follow after its Push/Pull committed: carries
    /// or detaches each planned annotation and returns the
    /// [`DocAction::UpdatedAnnotation`] records of the ones that changed,
    /// for the caller to push as followups of the Push/Pull's own entry.
    /// Empty when `follow` is `None` or nothing changed.
    pub(super) fn finish_face_follow(&mut self, follow: Option<FaceFollow>) -> Vec<DocAction> {
        let Some(follow) = follow else {
            return Vec::new();
        };
        let node = Some(NodeId::Object(follow.object));
        let mut records = Vec::new();
        for entry in follow.entries {
            let before = self.annotations[entry.annotation].annotation.clone();
            let anchors_before = follow_anchors(&before);
            let moving: Vec<Point3> = match &follow.moved {
                Some((region, _)) => entry
                    .on_surface
                    .iter()
                    .map(|&i| anchors_before[i].point)
                    .filter(|&p| region.holds(p))
                    .collect(),
                None => Vec::new(),
            };
            let mut after = before.clone();
            let carried = match &follow.moved {
                Some((_, v)) if !moving.is_empty() => carry(
                    &mut after,
                    &|anchor: &Anchor| anchor.node == node && moving.contains(&anchor.point),
                    *v,
                ),
                _ => None,
            };
            let obj = &self.objects[follow.object].object;
            let anchors_after = follow_anchors(&after);
            let survives = carried != Some(false)
                && entry
                    .on_surface
                    .iter()
                    .all(|&i| lies_on_surface(obj, anchors_after[i].point));
            let (after, after_detached) = if survives {
                (after, false)
            } else {
                (before.clone(), true)
            };
            if after == before && !after_detached {
                continue;
            }
            let rec = &mut self.annotations[entry.annotation];
            rec.annotation = after.clone();
            rec.detached = after_detached;
            records.push(DocAction::UpdatedAnnotation {
                annotation: entry.annotation,
                before,
                before_detached: false,
                after,
                after_detached,
            });
        }
        records
    }
}
