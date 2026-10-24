# SDD ledger — plan: docs/superpowers/plans/2026-10-24-s4b-noda-verify-parse-cleanup.md

Spec: docs/superpowers/specs/2026-10-21-s4-noda-document-layer-design.md
Branch: s4b-noda (from main a9768f3)

## Pre-flight scan

| Pair / Task | Produces → Consumes | Finding |
|---|---|---|
| T1→T2 | verifyAnswer, NodaVerifyResult, VERIFY_TIMEOUT_MS | consistent |
| T1→T3 | parseDocument, NodaParsedDocument, NodaError | consistent |
| T3→T4 | isLikelyScanned moved to attachments/scan.ts before pdf-ocr.ts deleted | order ok (T3 before T4) |
| T2/T3/T4→T5 | docs describe final state | consistent |
| T1 self | tests vs interfaces | consistent |
| T2 self | timeout test via fake timers; streamTurn deps param new | consistent |
| T3 self | reader deps param; reason-code table given | consistent |
| T4 self | deleting pdf-ocr.test.ts — scan tests covered by T3 | consistent |
| T5 self | SQL only, user applies | consistent |

Scan clean.

## Tasks
Task 1: dispatched (base a9768f3, sonnet)
Task 1: minor (deferred → carry to Task 3): n_rows/n_cols not validated as non-negative ints — parsedToExtract must derive/clamp dims (cap MAX_TABLE_ROWS/COLS)
Task 1: minor (deferred): unknown_refs accepts non-integers; top-level array response normalized silently
Task 1: complete (commits a9768f3..12d350b, review clean)
Task 2: dispatched (base 12d350b)
Task 2: minor (deferred): no test for late rejection after timeout; no test timer cleared on success; persist numberCheck JSDoc stale
Task 2: complete (commits 12d350b..c98e46b, review clean)
Task 3: dispatched (base c98e46b)
Task 3: implementer interrupted by session end after commit 09224a9; resumed to write report (1409 passed)
Task 3: minor (deferred, FIX IN FINAL WAVE): scanned-attachment NodaError cause not logged (store.ts:380) — NODA 401/403 invisible to operators
Task 3: minor (deferred, FINAL REVIEW): parse 60s/attempt + 30s retry window vs attachments route maxDuration 60 → slow parse can be killed leaving row pending
Task 3: fix round 1 dispatched (FIX_BASE 09224a9) — covered-cell overwrite double count (Important); huge span inflates truncation
Task 3: fix round 1/5 (2 addressed, 0 open; commits 09224a9..bbf5cd2)
Task 3: minor (deferred, FIX IN FINAL WAVE): overlapped counts empty covered cells → noise warning if NODA emits explicit empty covered cells; count only non-empty text
Task 3: complete (commits c98e46b..bbf5cd2, review clean)
Task 4: dispatched (base bbf5cd2)
Task 4: minor (deferred): legacy-removed import ban only matches @/lib alias form; tables-sheet.ts comment wrap; no explicit cover-only scan case
Task 4: complete (commits bbf5cd2..a1cdaf9, review clean)
Task 5: dispatched (base a1cdaf9)
Task 5: minor (deferred): CLAUDE.md /parse retry list omits 502
Task 5: complete (commits a1cdaf9..0461054, review clean)
Final review: dispatched (a9768f3..0461054)
Final review: Ready after fixes — Important: attachments route maxDuration 60 kills scanned parse; scanned NodaError not logged; 0032 not MANUAL_ONLY; + overlapped noise one-liner
Ruling I: attachments route maxDuration → 300 (documents read route already runs 300 in prod); NODA client timeouts unchanged — cost if wrong: Vercel plan rejects 300 → deploy fails visibly (no silent harm)
Final fix wave: dispatched (FIX_BASE 0461054)
Final fix wave: 7/7 addressed (commit 534c2d3); re-review clean. Deferred minors: missing_key logs a warning on every scanned confirm (noisy if key absent); empty placed cell at same position drops a later text cell (pre-existing, warns)
