# SES assessment classification hash root cause

This is PII-free evidence for the four U4 assessment cards in the 2026-07-28
sweep. It records read-only production evidence and keeps raw inputs out of the
repository.

## Read-only production method

Each current live snapshot was loaded through the same `buildSesAssemblerInput`
projection used by U4 and hashed with `sesSha256`. The input was then copied,
with only `classification.family_matrix_version` changed from the current v4
pin to the deployed v3 pin. Those recomputed v3 hashes were compared with the
observed production/deployed hashes.

| Card | Observed v3 | Recomputed v3 | Match |
| --- | --- | --- | --- |
| SWMS-26732 | `fac380cafdc5e79103d307de0ccaa769f765350a0ddf1a4f705d1d38f0f4a172` | `fac380cafdc5e79103d307de0ccaa769f765350a0ddf1a4f705d1d38f0f4a172` | exact |
| SWMS-26740 | `21f8bafc782f2c57988a0cf6eb4c4442aed917b27ab97ea139f4033d151b72c1` | `21f8bafc782f2c57988a0cf6eb4c4442aed917b27ab97ea139f4033d151b72c1` | exact |
| SWMS-26748 | `4617abf4021b788d9cbc91d5f90e8a91e71687734f1a7fc51894d05f76ed540a` | `4617abf4021b788d9cbc91d5f90e8a91e71687734f1a7fc51894d05f76ed540a` | exact |
| SWMS-26791 | `544d5077d89ec8e1b744a942a36e5c3c2735a0dec501144cbfad8a2d3b151b15` | `544d5077d89ec8e1b744a942a36e5c3c2735a0dec501144cbfad8a2d3b151b15` | exact |

All four current live inputs matched the observed v3 hashes exactly. That
rules out live content drift and canonicalizer mismatch for this comparison.

## Version and classification evidence

The v4 pre-fix hashes, after the restoration lane bumped the matrix version
but before correcting assessment portal delivery, were:

| Card | v4 pre-fix |
| --- | --- |
| SWMS-26732 | `3ee4f53c34fbceb6f1685b9b746e9a9e975ffead109afa685c9948b5be415385` |
| SWMS-26740 | `fa67ba04854b78375e08a8f15a5abd44e051b29a7bdb8829ad2eef3298628e82` |
| SWMS-26748 | `39ab46aea53e142ae60f6b48fdaaf9a464ead4d4cd2105ecf42e39e18bac4ffd` |
| SWMS-26791 | `b3d9329f5d6959f050810ad7bbd7c69753b0e3c8963d1c77f55c0efbcf90d623` |

The corrected v4 portal-delivery hashes are:

| Card | Corrected v4 |
| --- | --- |
| SWMS-26732 | `f5efd27409b39cca992b202cde59a3ad7626a7653a01b017679172c752f9b25f` |
| SWMS-26740 | `9eb5f9663009dc0b2ce4075946b924a33846714c1dc60623375d7094de7a526b` |
| SWMS-26748 | `f3414467da880f06840fde37b7b8168900347dcff9466fe77ad6b70b24c02d2b` |
| SWMS-26791 | `ee2dfc0e97d2d7aba7feb969a84d5181eca0fe85b9179e70b5acdb8dc0a3a4f8` |

The regression proves over all four sanitized live-shape fixtures that the
v3-to-v4 pre-fix structural diff contains only
`classification.family_matrix_version`, and that the correction from pre-fix
to current v4 contains only `classification.report_delivery`. It also proves
the canonical input hash is deterministic. The root cause was therefore a
stale v3 version pin combined with the separately incorrect portal-delivery
field, not canonicalization error or live content drift.
