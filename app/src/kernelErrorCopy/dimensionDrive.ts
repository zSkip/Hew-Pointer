/**
 * Plain-language copy for the kernel refusals of a driving dimension:
 * typing a length into a linear dimension to move the model
 * (`set_linear_dimension_length`). Spread into `DESCRIPTIONS` by
 * `kernelErrors.ts`.
 */

import { msg } from '@lingui/core/macro'
import type { MessageDescriptor } from '@lingui/core'

export const DIMENSION_DRIVE_ERRORS: Record<string, MessageDescriptor> = {
  NotLinearDimension: msg`Only a straight dimension can change the model. Type a label instead, or measure with a straight dimension.`,
  DimensionDetached: msg`This dimension is no longer attached to the model, so it can't move it. Draw the dimension again.`,
  FreeAnchors: msg`Neither end of this dimension is on an object, so there is nothing to move.`,
  AnchorNotOnObject: msg`This dimension ends on a group or component, which a dimension can't resize yet. Open it for editing and dimension the object inside.`,
  AnchorOffGeometry: msg`An end of this dimension is no longer on its object. Draw the dimension again.`,
  NoSquareFace: msg`No flat face is square to this dimension at either end, so the model can't be moved to match it. Dimension along an edge, between faces that face each other.`,
  AmbiguousFace: msg`This dimension ends where two faces meet, so which one to move is unclear. Dimension to a point inside one face.`,
  InvalidDimensionLength: msg`A dimension needs a length greater than zero.`,
  WouldCutThrough: msg`That length would push the face into other parts of the object. Use Push/Pull to cut or join through it.`,
}
