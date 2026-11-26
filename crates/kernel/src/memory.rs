//! Whether a large step fits in the memory left, asked before it starts.
//!
//! In WebAssembly an allocation that linear memory cannot grow for ends the
//! module ("unreachable"): there is no unwinding to catch it, and the
//! document is lost with the kernel. A step that may need gigabytes (an
//! import, a document load, an export) therefore asks [`has_room`] first,
//! with an estimate of its peak, and refuses with its own typed error when
//! the answer is no.
//!
//! [`has_room`] answers by allocating what the step will need: its largest
//! single buffer whole, the rest in blocks of [`BLOCK`], all at once, then
//! freeing them. Memory that grew for them stays with the allocator
//! (WebAssembly memory never shrinks), so the step then runs in it.
//! Natively the same test fails only when the system will not commit that
//! much, so it rarely refuses there.
//!
//! The estimates themselves live with the steps (`stl-import`,
//! [`crate::Document::load`], `mesh-export`); this module only answers.

use std::cell::Cell;

/// What [`has_room`] allocates at a time beyond the largest buffer. Large
/// on purpose: a step's big buffers (tables, packages) are hundreds of
/// megabytes each, and smaller blocks would count holes those cannot use.
/// Measured on the WebAssembly build: after a 4M-triangle import, room
/// tested in 64 or 256 MiB blocks let Save grow memory another 500 MB
/// past the tested amount; tested in 1 GiB blocks, it grew no further.
pub const BLOCK: usize = 1 << 30;

thread_local! {
    /// The test ceiling [`with_limit`] sets; `None` outside it.
    static LIMIT: Cell<Option<usize>> = const { Cell::new(None) };
}

/// What a step needs at its peak, above what is already allocated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Need {
    /// Every byte the step holds at once at its peak.
    pub total: usize,
    /// The largest single buffer among them (part of `total`).
    pub largest: usize,
}

impl Need {
    /// `total` bytes, of which `largest` in one buffer (clamped to `total`).
    pub fn new(total: usize, largest: usize) -> Need {
        Need {
            total,
            largest: largest.min(total),
        }
    }
}

/// Whether `need` can be allocated now: its largest buffer whole and the
/// rest in [`BLOCK`]s, all held together and then freed (see the module
/// doc). Inside [`with_limit`] nothing is allocated: the answer is whether
/// `need.total` is at most the limit.
pub fn has_room(need: Need) -> bool {
    if let Some(limit) = LIMIT.with(Cell::get) {
        return need.total <= limit;
    }
    let mut held: Vec<Vec<u8>> = Vec::new();
    if held
        .try_reserve_exact(1 + (need.total - need.largest).div_ceil(BLOCK))
        .is_err()
    {
        return false;
    }
    let mut take = |bytes: usize| -> bool {
        let mut block: Vec<u8> = Vec::new();
        let ok = block.try_reserve_exact(bytes).is_ok();
        held.push(block);
        ok
    };
    if !take(need.largest) {
        return false;
    }
    let mut rest = need.total - need.largest;
    while rest > 0 {
        let bytes = rest.min(BLOCK);
        if !take(bytes) {
            return false;
        }
        rest -= bytes;
    }
    true
}

/// Runs `f` with [`has_room`] answering against `limit` bytes instead of
/// allocating, on this thread: how tests make a step refuse without
/// gigabytes. Restores the previous limit afterwards, panic or not.
#[doc(hidden)]
pub fn with_limit<R>(limit: usize, f: impl FnOnce() -> R) -> R {
    struct Restore(Option<usize>);
    impl Drop for Restore {
        fn drop(&mut self) {
            LIMIT.with(|l| l.set(self.0));
        }
    }
    let _restore = Restore(LIMIT.with(|l| l.replace(Some(limit))));
    f()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_small_need_has_room() {
        assert!(has_room(Need::new(5 << 20, 1 << 20)));
        assert!(has_room(Need::new(0, 0)));
    }

    #[test]
    fn a_need_no_allocator_can_meet_has_no_room() {
        // More than any address space holds: the test allocation fails
        // instead of ending the process.
        assert!(!has_room(Need::new(usize::MAX / 2, usize::MAX / 2)));
        assert!(!has_room(Need::new(usize::MAX / 2, 0)));
    }

    #[test]
    fn largest_is_clamped_to_total() {
        assert_eq!(Need::new(10, 20), Need::new(10, 10));
    }

    #[test]
    fn with_limit_answers_against_the_limit_and_restores() {
        let need = Need::new(1000, 10);
        with_limit(999, || {
            assert!(!has_room(need));
            with_limit(1000, || assert!(has_room(need)));
            assert!(!has_room(need));
        });
        assert!(has_room(need));
    }
}
