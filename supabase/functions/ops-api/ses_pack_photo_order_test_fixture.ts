// Privacy-safe adversarial pack-photo order shared by bind and assembler tests.
// ID order intentionally disagrees with chronology; equal and null timestamps
// pin the deterministic `id` tiebreak in both timestamp classes.
export const PACK_PHOTO_ORDER_MEDIA = [
  {
    id: "aaa",
    type: "photo",
    phase: "completion",
    created_at: "2026-07-30T02:24:07Z",
    storage_url: "https://storage.example.test/a.jpg",
  },
  {
    id: "zzz",
    type: "photo",
    phase: "completion",
    created_at: "2026-07-30T02:23:53Z",
    storage_url: "https://storage.example.test/z.jpg",
  },
  {
    id: "mmm",
    type: "photo",
    phase: "completion",
    created_at: "2026-07-30T02:24:01Z",
    storage_url: "https://storage.example.test/m.jpg",
  },
  {
    id: "bbb",
    type: "photo",
    phase: "completion",
    created_at: "2026-07-30T02:24:01Z",
    storage_url: "https://storage.example.test/b.jpg",
  },
  {
    id: "fff",
    type: "photo",
    phase: "completion",
    created_at: "2026-07-30T02:24:03.500Z",
    storage_url: "https://storage.example.test/f.jpg",
  },
  {
    id: "ppp",
    type: "photo",
    phase: "completion",
    created_at: "2026-07-30T02:24:03Z",
    storage_url: "https://storage.example.test/p.jpg",
  },
  {
    id: "nnn",
    type: "photo",
    phase: "completion",
    created_at: null,
    storage_url: "https://storage.example.test/n.jpg",
  },
  {
    id: "ccc",
    type: "photo",
    phase: "completion",
    created_at: null,
    storage_url: "https://storage.example.test/c.jpg",
  },
] as const;

export const PACK_PHOTO_ORDER_EXPECTED_IDS = [
  "zzz",
  "bbb",
  "mmm",
  "ppp",
  "fff",
  "aaa",
  "ccc",
  "nnn",
] as const;
