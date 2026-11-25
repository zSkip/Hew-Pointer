//! Driving dimensions: setting a linear dimension's length moves the model
//! so the dimension measures the new length (docs/design/dimensions-text.md,
//! "Associativity"). Hew is a direct modeler with no constraint solver, so a
//! drive is a one-time edit made of the ordinary operations a person would
//! use by hand — a Push/Pull of the face the dimension ends on, or a Move of
//! the object it ends on — plus the matching edit to the dimension itself,
//! recorded as ONE undo entry. A second `impl Document` block, kept out of
//! `document.rs` for size, the way `curves.rs` holds the true-curves
//! operations.

use super::*;

/// Which end of a [`Annotation::LinearDimension`] a drive moved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DimensionEnd {
    /// Anchor `a`, the dimension's first endpoint.
    A,
    /// Anchor `b`, the dimension's second endpoint.
    B,
}

/// What a drive moved to set the length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DimensionDriveMove {
    /// The flat face of `object` the moved end lies on was pushed or pulled
    /// along its normal, the way the Push/Pull tool moves it.
    Face {
        /// The object whose face moved.
        object: ObjectId,
        /// The face that moved, as it was named before the move.
        face: FaceId,
    },
    /// The whole object the moved end lies on was translated along the
    /// dimension (the two ends lie on different objects).
    Object {
        /// The object that moved.
        object: ObjectId,
    },
    /// The dimension already measured the requested length: no geometry
    /// moved (a `text_override` may still have been cleared).
    Nothing,
}

/// The outcome of [`Document::set_linear_dimension_length`].
#[derive(Debug, Clone, PartialEq)]
pub struct DimensionDrive {
    /// The end that moved. With [`DimensionDriveMove::Nothing`] it is the
    /// end a real change would have moved.
    pub end: DimensionEnd,
    /// What moved.
    pub moved: DimensionDriveMove,
    /// The dimension's length before the drive, in meters.
    pub old_length: f64,
}

/// Why [`Document::set_linear_dimension_length`] refused. Every refusal
/// leaves the document byte-identical, with no undo entry added.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DimensionDriveError {
    /// The annotation is a radial dimension or a leader, not a linear
    /// dimension.
    NotLinearDimension,
    /// The dimension is `detached`: it no longer follows the geometry it
    /// was drawn on, so there is nothing trustworthy to move.
    DimensionDetached,
    /// Neither anchor names an object (both are free points in space).
    FreeAnchors,
    /// An anchor names a group or a component instance. Driving geometry
    /// inside a group's or a component's own frame is not supported yet;
    /// only objects in the world are moved.
    AnchorNotOnObject,
    /// An anchor names an object but its point no longer lies on any of that
    /// object's faces (the geometry moved since the dimension was drawn).
    AnchorOffGeometry,
    /// Neither end lies on a flat face square to the dimension (a diagonal
    /// dimension, or one ending on a curved wall or a blend).
    NoSquareFace,
    /// The moving end lies on more than one flat face square to the
    /// dimension (two coplanar faces meeting at the anchor), so which face
    /// to move is a guess the kernel will not make.
    AmbiguousFace,
    /// The requested length is not finite, or not longer than
    /// [`tol::POINT_MERGE`] (a dimension cannot be zero or negative).
    InvalidDimensionLength,
    /// Moving the face would carry it through other material of the same
    /// object, which the Push/Pull tool turns into a cut or a merge that
    /// can split or replace the object. A dimension cannot follow that, so
    /// the drive refuses instead.
    WouldCutThrough,
}

impl std::fmt::Display for DimensionDriveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DimensionDriveError::NotLinearDimension => {
                write!(f, "only a linear dimension can be driven")
            }
            DimensionDriveError::DimensionDetached => {
                write!(f, "the dimension is detached from the geometry")
            }
            DimensionDriveError::FreeAnchors => {
                write!(f, "neither end of the dimension is on an object")
            }
            DimensionDriveError::AnchorNotOnObject => write!(
                f,
                "an end of the dimension is on a group or component, which cannot be driven yet"
            ),
            DimensionDriveError::AnchorOffGeometry => {
                write!(f, "an end of the dimension is no longer on its object")
            }
            DimensionDriveError::NoSquareFace => {
                write!(f, "no flat face is square to the dimension at either end")
            }
            DimensionDriveError::AmbiguousFace => {
                write!(f, "the dimension ends on more than one face square to it")
            }
            DimensionDriveError::InvalidDimensionLength => {
                write!(f, "a dimension length must be a positive number")
            }
            DimensionDriveError::WouldCutThrough => write!(
                f,
                "the face would pass through other material of the object"
            ),
        }
    }
}

/// One end of the dimension, resolved against the document.
#[derive(Debug, Clone, Copy)]
enum EndKind {
    /// A free point in space.
    Free,
    /// A point on a live world object.
    Object(ObjectId),
}

/// The face a drive will move: the object, the face, and the signed
/// Push/Pull distance that moves the end by the requested change.
#[derive(Debug, Clone, Copy)]
struct FacePlan {
    end: DimensionEnd,
    object: ObjectId,
    face: FaceId,
    distance: f64,
}

impl Document {
    /// Sets the length of the linear dimension `id` to `length` meters by
    /// moving the model, then the dimension with it — a driving dimension
    /// edit, recorded as ONE undo entry that restores both the geometry and
    /// the dimension exactly (and one redo that re-applies both).
    ///
    /// Let `d` be the unit direction from anchor `a` to anchor `b`, and
    /// `delta = length − |b − a|`.
    ///
    /// - **Two different objects** (each anchor names a different world
    ///   object): `b`'s object is translated by `d · delta`, as the Move
    ///   tool would ([`Document::transform_object`]). Every annotation
    ///   anchored to that object rides along, this one included.
    /// - **Otherwise** (both anchors on one object, or one anchor free and
    ///   the other on an object): the end that moves is `b` when `b` lies
    ///   on exactly one flat face of its object whose plane normal is
    ///   parallel to `d` (either sign — the face can face away from `a`, or
    ///   toward it across a gap); else `a`, under the same test. That face
    ///   is moved with the same Push/Pull the tool applies: a face beside a
    ///   blend is moved with its blends re-applied when they can be
    ///   ([`Document::push_pull_with_blends`]), a flat imprinted sub-face
    ///   becomes a boss or recess ([`KernelOp::ExtrudeSubFace`]), any other
    ///   face is translated ([`KernelOp::PushPull`]). The distance is signed
    ///   so the moved end travels `d · delta` (for `b`) or `−d · delta`
    ///   (for `a`). The dimension's anchor rides with the face, as every
    ///   annotation on a pushed face does (`annotation_follow.rs`): by the
    ///   face's translation, which is `d · delta` up to the
    ///   [`tol::NORMAL_DIRECTION`] by which the face's normal may differ
    ///   from `d`.
    ///   "Flat" excludes blend faces and facets of an analytic surface (a
    ///   cylinder wall's Push/Pull changes its radius, it does not translate
    ///   the facet).
    ///
    /// In every case the dimension's `text_override` is cleared, so its
    /// label shows the measured value again. Its `offset` and `plane` come
    /// from the move's own re-anchoring, the one every annotation on the
    /// moved geometry gets: a face move keeps them verbatim (it moves an end
    /// along the dimension's own line), a whole-object move carries them as
    /// any Move does. Should the move leave the
    /// dimension unable to follow, that re-anchoring freezes it and marks
    /// it `detached`, and its override is kept (a plain translate never
    /// does this: the other end lies outside the swept slab). When the
    /// dimension already measures `length` within
    /// [`tol::POINT_MERGE`], no geometry moves; the override is cleared if
    /// there was one (one undo entry), and nothing at all is recorded when
    /// there was none. The end and face are still resolved first, so a
    /// dimension that could not be driven refuses even then.
    ///
    /// Scope: world objects only. Every other annotation anchored to the
    /// moved face or object rides along too, in the same undo entry.
    ///
    /// # Errors
    /// Refusals are checked before anything changes, and the geometry step
    /// has the strong guarantee of the operation it uses, so on `Err` the
    /// document is byte-identical and no undo entry is added:
    /// - [`DocumentError::UnknownAnnotation`] — stale, hidden or foreign id.
    /// - [`DocumentError::DimensionDrive`] with a [`DimensionDriveError`]:
    ///   `NotLinearDimension`, `DimensionDetached`, `InvalidDimensionLength`, `FreeAnchors`,
    ///   `AnchorNotOnObject`, `AnchorOffGeometry` (checked for every anchor
    ///   that names an object), `NoSquareFace`, `AmbiguousFace`,
    ///   `WouldCutThrough`.
    /// - [`DocumentError::DegenerateAnnotation`] — the stored anchors
    ///   coincide (no direction to drive along).
    /// - Any refusal of the Push/Pull or Move itself, passed through
    ///   unchanged (for example [`DocumentError::Op`] when the push would
    ///   make the solid vanish, or [`DocumentError::LockedNode`]).
    pub fn set_linear_dimension_length(
        &mut self,
        id: AnnotationId,
        length: f64,
    ) -> Result<(DimensionDrive, DocChange), DocumentError> {
        let drive_err = DocumentError::DimensionDrive;
        let rec = match self.annotations.get(id) {
            Some(rec) if !rec.hidden => rec,
            _ => return Err(DocumentError::UnknownAnnotation),
        };
        let Annotation::LinearDimension {
            a,
            b,
            text_override,
            ..
        } = rec.annotation.clone()
        else {
            return Err(drive_err(DimensionDriveError::NotLinearDimension));
        };
        if rec.detached {
            return Err(drive_err(DimensionDriveError::DimensionDetached));
        }
        if !length.is_finite() || length <= tol::POINT_MERGE {
            return Err(drive_err(DimensionDriveError::InvalidDimensionLength));
        }
        let span = b.point - a.point;
        let old_length = span.length();
        let dir = span
            .normalized()
            .map_err(|_| DocumentError::DegenerateAnnotation)?;
        let delta = length - old_length;

        let kind_a = self.drive_end_kind(&a)?;
        let kind_b = self.drive_end_kind(&b)?;

        // Resolve what moves, without touching anything.
        let plan = match (kind_a, kind_b) {
            (EndKind::Free, EndKind::Free) => {
                return Err(drive_err(DimensionDriveError::FreeAnchors));
            }
            (EndKind::Object(oa), EndKind::Object(ob)) if oa != ob => None,
            _ => {
                let at_b = match kind_b {
                    EndKind::Object(o) => {
                        self.square_face_at(o, b.point, dir, delta, DimensionEnd::B)?
                    }
                    EndKind::Free => None,
                };
                let plan = match at_b {
                    Some(p) => p,
                    None => match kind_a {
                        EndKind::Object(o) => self
                            .square_face_at(o, a.point, dir, delta, DimensionEnd::A)?
                            .ok_or(drive_err(DimensionDriveError::NoSquareFace))?,
                        EndKind::Free => return Err(drive_err(DimensionDriveError::NoSquareFace)),
                    },
                };
                Some(plan)
            }
        };
        let end = plan.map_or(DimensionEnd::B, |p| p.end);
        let unchanged = delta.abs() <= tol::POINT_MERGE;
        if unchanged && text_override.is_none() {
            let moved = DimensionDriveMove::Nothing;
            return Ok((
                DimensionDrive {
                    end,
                    moved,
                    old_length,
                },
                DocChange::default(),
            ));
        }

        let start_len = self.undo.actions.len();
        let epoch_at_start = self.document_epoch;
        let mut change = DocChange::default();
        let moved = if unchanged {
            DimensionDriveMove::Nothing
        } else {
            match plan {
                Some(p) => {
                    change = self.drive_face(p)?;
                    DimensionDriveMove::Face {
                        object: p.object,
                        face: p.face,
                    }
                }
                None => {
                    let EndKind::Object(object) = kind_b else {
                        unreachable!("two different objects resolved above");
                    };
                    change = self.transform_object(object, &Transform::translation(dir * delta))?;
                    DimensionDriveMove::Object { object }
                }
            }
        };

        // The move has already carried the dimension, the way it carries
        // every annotation on the moved geometry: a face move through the
        // face follow (`annotation_follow.rs`), a whole-object move through
        // `reanchor_touched`. What is left is the label: back to the
        // measured value. A dimension the move could not carry is frozen
        // and `detached`, and stays exactly so.
        let rec = &self.annotations[id];
        if let Annotation::LinearDimension {
            text_override: Some(_),
            ..
        } = &rec.annotation
            && !rec.detached
        {
            let mut new = rec.annotation.clone();
            if let Annotation::LinearDimension { text_override, .. } = &mut new {
                *text_override = None;
            }
            self.update_annotation(id, new)
                .expect("the annotation is live and the kind is unchanged");
        }

        // Bundle what was recorded into one step, as a compound's end does.
        if self.undo.actions.len() > start_len + 1 {
            let actions: Vec<DocAction> = self.undo.actions.drain(start_len..).collect();
            self.change_ring.drop_after_epoch(epoch_at_start);
            self.undo.push(DocAction::Compound {
                actions,
                meta: None,
            });
            self.commit_new_action();
        }
        self.debug_validate();
        Ok((
            DimensionDrive {
                end,
                moved,
                old_length,
            },
            change,
        ))
    }

    /// Classifies one anchor of a dimension being driven.
    fn drive_end_kind(&self, anchor: &Anchor) -> Result<EndKind, DocumentError> {
        match anchor.node {
            None => Ok(EndKind::Free),
            Some(NodeId::Object(o)) => {
                if !self.node_is_live(NodeId::Object(o)) {
                    // A live dimension on a dead node is `detached`; this
                    // only guards a record that was never re-evaluated.
                    return Err(DocumentError::DimensionDrive(
                        DimensionDriveError::DimensionDetached,
                    ));
                }
                let object = &self.objects[o].object;
                if !super::annotation_follow::lies_on_surface(object, anchor.point) {
                    return Err(DocumentError::DimensionDrive(
                        DimensionDriveError::AnchorOffGeometry,
                    ));
                }
                Ok(EndKind::Object(o))
            }
            Some(NodeId::Group(_) | NodeId::Instance(_)) => Err(DocumentError::DimensionDrive(
                DimensionDriveError::AnchorNotOnObject,
            )),
        }
    }

    /// The one flat face of `object` holding `point` whose normal is
    /// parallel to `dir`, with the Push/Pull distance that moves `point` by
    /// `dir · delta` (end `B`) or `−dir · delta` (end `A`). `Ok(None)` when
    /// no face qualifies; [`DimensionDriveError::AmbiguousFace`] when more
    /// than one does.
    fn square_face_at(
        &self,
        object: ObjectId,
        point: Point3,
        dir: Vec3,
        delta: f64,
        end: DimensionEnd,
    ) -> Result<Option<FacePlan>, DocumentError> {
        let obj = &self.objects[object].object;
        let mut found: Option<FacePlan> = None;
        for (fid, f) in obj.faces() {
            if f.surface().is_some() || obj.blend_of_face(fid).is_some() {
                continue;
            }
            let normal = f.plane.normal();
            let sign = if (normal - dir).length() <= tol::NORMAL_DIRECTION {
                1.0
            } else if (normal + dir).length() <= tol::NORMAL_DIRECTION {
                -1.0
            } else {
                continue;
            };
            if !face_holds_point(obj, fid, point) {
                continue;
            }
            if found.is_some() {
                return Err(DocumentError::DimensionDrive(
                    DimensionDriveError::AmbiguousFace,
                ));
            }
            // The point moves by `normal · distance`; it must move by
            // `±dir · delta`, and `normal = sign · dir`.
            let along = match end {
                DimensionEnd::B => delta,
                DimensionEnd::A => -delta,
            };
            found = Some(FacePlan {
                end,
                object,
                face: fid,
                distance: sign * along,
            });
        }
        Ok(found)
    }

    /// Moves the planned face the way the Push/Pull tool routes a push: a
    /// face beside blends with the blends re-applied when they can be
    /// (falling back to the ordinary push), a flat imprinted sub-face as a
    /// boss or recess, any other face translated. Where the tool would turn
    /// the push into a cut-through or merge-through, this refuses
    /// ([`DimensionDriveError::WouldCutThrough`]) instead. Strong
    /// guarantee: on `Err` nothing changed.
    fn drive_face(&mut self, p: FacePlan) -> Result<DocChange, DocumentError> {
        if self.objects[p.object].object.face_borders_blend(p.face)
            && let Ok(change) = self.push_pull_with_blends(p.object, p.face, p.distance)
        {
            return Ok(change);
        }
        let obj = &self.objects[p.object].object;
        if obj.push_pull_overshoots(p.face, p.distance) {
            return Err(DocumentError::DimensionDrive(
                DimensionDriveError::WouldCutThrough,
            ));
        }
        let op = if obj.is_flat_sub_face(p.face) {
            KernelOp::ExtrudeSubFace {
                sub_face: p.face,
                distance: p.distance,
            }
        } else {
            KernelOp::PushPull {
                face: p.face,
                distance: p.distance,
            }
        };
        self.apply_object_op(p.object, op).map(|(_, change)| change)
    }
}

/// Whether `point` lies on `face` of `object`: on its plane within
/// [`tol::PLANE_DIST`], and inside its outer loop and outside its holes, or
/// on one of its loops within [`tol::POINT_MERGE`] (an anchor snapped to an
/// edge or a corner lies on every face meeting there).
fn face_holds_point(object: &Object, face: FaceId, point: Point3) -> bool {
    super::annotation_follow::FaceRegion::of(object, face).is_some_and(|r| r.holds(point))
}
