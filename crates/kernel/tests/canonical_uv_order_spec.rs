//! Executable spec for the canonical geometry writer's face-sort totality
//! (HEW_FILE_FORMAT.md §3.1): the UV frame participates in the canonical
//! face key. Two coincident shells give a valid object whose faces tie on
//! outer ring, holes, and material; if one of a coincident pair carries a UV
//! frame and the other does not, the tie must be broken by the frame — not
//! by storage order — or the same document decoded from differently ordered
//! (but semantically identical) inputs re-encodes to different bytes,
//! exactly the slot-history drift the canonical writer exists to remove.
//!
//! The buffers are hand-crafted per the spec so the two inputs really do
//! present the faces in opposite orders.

use kernel::Object;

const NO_MATERIAL: u32 = 0xFFFF_FFFF;

/// One face record for the crafted buffer: outer indices plus an optional
/// UV frame payload (8 f64s).
struct FaceRec {
    outer: Vec<u32>,
    uv: Option<[f64; 8]>,
}

/// Hand-encode a v3 geometry buffer (HEW_FILE_FORMAT.md §3.1).
fn craft(positions: &[[f64; 3]], faces: &[FaceRec]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(b"HEWG");
    b.extend_from_slice(&3u32.to_le_bytes()); // version
    b.push(1u8); // watertight
    b.extend_from_slice(&NO_MATERIAL.to_le_bytes()); // base material
    b.push(0u8); // imported flag
    b.extend_from_slice(&(positions.len() as u32).to_le_bytes());
    for p in positions {
        for c in p {
            b.extend_from_slice(&c.to_le_bytes());
        }
    }
    b.extend_from_slice(&(faces.len() as u32).to_le_bytes());
    for f in faces {
        b.extend_from_slice(&NO_MATERIAL.to_le_bytes()); // face material
        match &f.uv {
            None => b.push(0u8),
            Some(frame) => {
                b.push(1u8);
                for c in frame {
                    b.extend_from_slice(&c.to_le_bytes());
                }
            }
        }
        b.extend_from_slice(&(f.outer.len() as u32).to_le_bytes());
        for &i in &f.outer {
            b.extend_from_slice(&i.to_le_bytes());
        }
        b.extend_from_slice(&0u32.to_le_bytes()); // hole count
    }
    b
}

/// The six faces of a unit cube whose vertices start at index `base`.
/// `uv_on_top` puts a UV frame on the +z face.
fn cube_faces(base: u32, uv_on_top: bool) -> Vec<FaceRec> {
    let idx = |list: [u32; 4]| list.iter().map(|&i| base + i).collect::<Vec<u32>>();
    let frame = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.25, 0.5];
    vec![
        FaceRec {
            outer: idx([0, 3, 2, 1]),
            uv: None,
        },
        FaceRec {
            outer: idx([4, 5, 6, 7]),
            uv: uv_on_top.then_some(frame),
        },
        FaceRec {
            outer: idx([0, 1, 5, 4]),
            uv: None,
        },
        FaceRec {
            outer: idx([1, 2, 6, 5]),
            uv: None,
        },
        FaceRec {
            outer: idx([2, 3, 7, 6]),
            uv: None,
        },
        FaceRec {
            outer: idx([3, 0, 4, 7]),
            uv: None,
        },
    ]
}

#[test]
fn uv_frame_breaks_canonical_face_ties_deterministically() {
    let cube: Vec<[f64; 3]> = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [1.0, 1.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 1.0],
        [1.0, 1.0, 1.0],
        [0.0, 1.0, 1.0],
    ];
    // Two coincident shells: 16 vertices, 12 faces. Shell "plain" has no UV
    // frames; shell "textured" carries one on its top face. Every face of
    // one shell ties with its counterpart on ring, holes, and material.
    let positions: Vec<[f64; 3]> = cube.iter().chain(cube.iter()).copied().collect();

    let mut faces_a = cube_faces(0, false); // plain shell first
    faces_a.extend(cube_faces(8, true));
    let mut faces_b = cube_faces(8, true); // textured shell first
    faces_b.extend(cube_faces(0, false));

    let decode = |bytes: &[u8]| {
        let obj = Object::decode(bytes, &|_| None).expect("crafted buffer decodes");
        obj.validate().expect("decoded object validates");
        obj
    };
    let obj_a = decode(&craft(&positions, &faces_a));
    let obj_b = decode(&craft(&positions, &faces_b));

    let encode = |o: &Object| o.encode(&|_| unreachable!("no materials in this spec"));
    assert_eq!(
        encode(&obj_a),
        encode(&obj_b),
        "face input order leaked into the canonical encoding: the UV frame \
         must participate in the face sort key"
    );
}

/// Hand-encode a v6 geometry buffer: each face is (outer indices, SOFT flag
/// per outer edge), with no UV frame, surface, holes or circle claims.
fn craft_v6(positions: &[[f64; 3]], faces: &[(Vec<u32>, Vec<bool>)]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(b"HEWG");
    b.extend_from_slice(&6u32.to_le_bytes()); // version
    b.push(1u8); // watertight
    b.extend_from_slice(&NO_MATERIAL.to_le_bytes()); // base material
    b.push(0u8); // imported flag
    b.extend_from_slice(&(positions.len() as u32).to_le_bytes());
    for p in positions {
        for c in p {
            b.extend_from_slice(&c.to_le_bytes());
        }
    }
    b.extend_from_slice(&(faces.len() as u32).to_le_bytes());
    for (outer, soft) in faces {
        b.extend_from_slice(&NO_MATERIAL.to_le_bytes()); // face material
        b.push(0u8); // no UV frame
        b.push(0u8); // no surface
        b.extend_from_slice(&(outer.len() as u32).to_le_bytes());
        for &i in outer {
            b.extend_from_slice(&i.to_le_bytes());
        }
        b.extend_from_slice(&0u32.to_le_bytes()); // hole count
        if soft.iter().any(|&f| f) {
            b.push(1u8);
            b.extend(soft.iter().map(|&f| u8::from(f)));
        } else {
            b.push(0u8);
        }
        b.push(0u8); // no circle claims
    }
    b
}

/// The per-edge payloads are part of the face key too: two coincident
/// cubes that differ only in one SOFT edge tie on ring, holes, material, UV
/// frame and surface, and the soft flags must order them, so either input
/// order encodes to the same bytes.
#[test]
fn soft_flags_break_canonical_face_ties_deterministically() {
    let cube: Vec<[f64; 3]> = vec![
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [1.0, 1.0, 0.0],
        [0.0, 1.0, 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 1.0],
        [1.0, 1.0, 1.0],
        [0.0, 1.0, 1.0],
    ];
    let positions: Vec<[f64; 3]> = cube.iter().chain(cube.iter()).copied().collect();
    // A cube's faces; `soft` marks the edge 5→6 on the top face and its
    // twin 6→5 on the +x face.
    let cube_faces = |base: u32, soft: bool| -> Vec<(Vec<u32>, Vec<bool>)> {
        let idx = |list: [u32; 4]| list.iter().map(|&i| base + i).collect::<Vec<u32>>();
        let plain = vec![false; 4];
        let marked = |k: usize| (0..4).map(|i| soft && i == k).collect::<Vec<bool>>();
        vec![
            (idx([0, 3, 2, 1]), plain.clone()),
            (idx([4, 5, 6, 7]), marked(1)),
            (idx([0, 1, 5, 4]), plain.clone()),
            (idx([1, 2, 6, 5]), marked(2)),
            (idx([2, 3, 7, 6]), plain.clone()),
            (idx([3, 0, 4, 7]), plain),
        ]
    };
    let mut faces_a = cube_faces(0, false);
    faces_a.extend(cube_faces(8, true));
    let mut faces_b = cube_faces(8, true);
    faces_b.extend(cube_faces(0, false));

    let decode = |bytes: &[u8]| {
        let obj = Object::decode(bytes, &|_| None).expect("crafted buffer decodes");
        obj.validate().expect("decoded object validates");
        obj
    };
    let obj_a = decode(&craft_v6(&positions, &faces_a));
    let obj_b = decode(&craft_v6(&positions, &faces_b));
    assert_eq!(
        obj_a.edges().values().filter(|e| e.soft).count(),
        1,
        "one soft edge, on one of the two cubes"
    );

    let encode = |o: &Object| o.encode(&|_| unreachable!("no materials in this spec"));
    assert_eq!(
        encode(&obj_a),
        encode(&obj_b),
        "face input order leaked into the canonical encoding: the per-edge \
         SOFT flags must participate in the face sort key"
    );
}
