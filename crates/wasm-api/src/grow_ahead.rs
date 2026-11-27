//! The WebAssembly build's global allocator: the standard one, made to grow
//! linear memory in 16 MiB steps instead of a page at a time.
//!
//! The standard allocator asks for more memory in as many `memory.grow`
//! calls as there are small allocations that miss its free space, each
//! rounded up to a 64 KiB page. Each call costs the browser milliseconds
//! once memory is large (measured in V8: about 1.5 ms per call at 800 MB,
//! 3.5 ms at 900 MB, whether it grows by one page or by a hundred
//! megabytes), so saving a million-triangle document that had to grow
//! memory spent most of its time in those calls.
//!
//! [`GrowAhead`] passes every request to [`System`] unchanged. When a small
//! one made memory grow, it then allocates one 16 MiB block and frees it
//! again: one `memory.grow`, and the freed block joins the allocator's free
//! space at the top of memory, where the next small allocations are carved
//! from without growing. A large request already grows memory in one call
//! of its own size and is left alone. Linear memory never shrinks either
//! way, so nothing is spent that later allocations do not use; a reserve
//! that does not fit under the 4 GiB ceiling is skipped, and the allocation
//! that triggered it has already succeeded.

use std::alloc::{GlobalAlloc, Layout, System};
use std::arch::wasm32::memory_size;

/// What one growth step claims ahead.
const RESERVE: usize = 16 * 1024 * 1024;
/// Requests at least this large grow memory in one call of their own size
/// already; only growth caused by smaller ones is followed by a reserve.
const SMALL: usize = 1024 * 1024;

pub(crate) struct GrowAhead;

impl GrowAhead {
    /// After a small request grew memory: claim the next stretch in one call.
    fn after(pages_before: usize, size: usize) {
        if size >= SMALL || memory_size(0) == pages_before {
            return;
        }
        let Ok(layout) = Layout::from_size_align(RESERVE, 16) else {
            return;
        };
        // SAFETY: `layout` has a non-zero size; the block is freed at once
        // with the layout it was allocated with, and never read or written.
        unsafe {
            let p = System.alloc(layout);
            if !p.is_null() {
                System.dealloc(p, layout);
            }
        }
    }
}

// SAFETY: every method forwards to `System` with the caller's arguments
// unchanged and returns its result; the reserve step allocates and frees a
// block of its own and touches nothing the caller holds.
unsafe impl GlobalAlloc for GrowAhead {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let before = memory_size(0);
        let p = unsafe { System.alloc(layout) };
        Self::after(before, layout.size());
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let before = memory_size(0);
        let p = unsafe { System.alloc_zeroed(layout) };
        Self::after(before, layout.size());
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let before = memory_size(0);
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        Self::after(before, new_size);
        p
    }
}
