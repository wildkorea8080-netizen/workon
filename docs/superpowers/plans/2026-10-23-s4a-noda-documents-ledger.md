# SDD ledger — plan: docs/superpowers/plans/2026-10-23-s4a-noda-documents.md

Spec: docs/superpowers/specs/2026-10-21-s4-noda-document-layer-design.md
Branch: s4a-noda (from main 6eb17fc)

## Pre-flight scan

| Pair / Task | Produces → Consumes | Finding |
|---|---|---|
| T1→T2 | noda client, NodaListing, NodaError, nodaTenant | consistent |
| T1→T4 | nodaFilename, noda.deleteDocument (404→deleted:false) | consistent |
| T1→T6 | getContext, stripNodaPrefixes, documentIdFromNodaFilename, NodaSource | consistent |
| T2→T3 | startReadingFields, readDocument(id,{retry}) → ReadOutcome | consistent; read route maps not_found→404 |
| T2→T4 | reconcileReading(rows) → kick flag | consistent |
| T2→T6 | NodaStatus type in db.ts | consistent |
| T2↔T8 | 0031 header names `npm run noda:migrate`, script made in T8 | ordering ok (comment only) |
| T3/T4→T5 | confirm & assign return data.documentIds; read route body {retry} | consistent |
| T6→T7 | error.code 'documents_unavailable', source_references.documents_skipped, chunk page/cellRange/section/ocr | consistent; T7 keeps own prefix regex (noda.ts imports config) |
| T1 self | tests vs signatures | consistent |
| T2 self | decideReadState kick uses last_attempt, falls back to started_at when null | implicit in plan → Ruling A |
| T3 self | deletes /api/upload, moves 3 source-text tests | consistent |
| T4 self | tests read route source text (no route harness) | stated in plan; accepted |
| T5 self | config-public guard list extended | consistent |
| T6 self | "prepare-attachments.test.ts 또는 새 prepare-preflight.test.ts" ambiguous | Ruling B |
| T7 self | `next lint` "있으면" | conditional, fine |
| T8 self | scripts no unit tests; verified by tsc/build | fine |

Ruling A: decideReadState's 2-minute kick clock = noda_last_attempt_at, or noda_read_started_at when last_attempt is null — the plan's test row (last_attempt null, started 0, now 120_001 → kick) requires it — cost if wrong: a row never sent is kicked 2 min after confirm instead of immediately (harmless).
Ruling B: Task 6 puts the preflight test in a new file tests/prepare-preflight.test.ts — keeps prepare-attachments focused — cost if wrong: one more test file.

## Tasks
Task 1: dispatched (base 6eb17fc, implementer sonnet a2497d7517d67081c)
Task 1: minor (deferred): Retry-After: 0 → zero-wait hammering until window ends (noda.ts:270)
Task 1: minor (deferred): body-read timeout reported as http not timeout (noda.ts:328)
Task 1: minor (deferred): getContext sources elements not filtered to objects (noda.ts:421) — carry to Task 6
Task 1: minor (deferred): test id() helper redundant (tests/noda-client.test.ts:519)
Task 1: ⚠️ resolved — getEnv returns '' when unset (config.ts getEnv), Uint8Array fetch body OK on Node 18+
Ruling: NODA_API_URL uses `||` not `??` — empty env copied from .env.example must fall back to default — cost if wrong: none
Task 1: complete (commits 6eb17fc..195db41, review clean)
Task 2: dispatched (base 195db41)
Task 2: minor (deferred): give_up can race a still-running read → row failed while NODA holds readable copy (retry fixes)
Task 2: minor (deferred): NodaError branch doesn't best-effort delete NODA copy when row vanished
Task 2: minor (deferred): no default-store tests for finish/restart guards
Task 2: minor (deferred): reconcileReading throws on DB error — Task 4 list must catch (plan already says 맞추기 실패는 목록을 막지 않는다)
Ruling C: Task 6 documentsOf returns ALL this agent's rows (any status); sources of ready/deleting rows are used, sources of this agent's reading/failed/unreadable rows are dropped silently, only sources with NO row of this agent make sourcesToChunks null — Task 2 minor #1 shows a failed row can have a NODA copy, and plan R5 would otherwise log a false critical and drop all evidence — cost if wrong: a just-failed doc's chunk is hidden (correct anyway)
Task 2: complete (commits 195db41..d7343fe, review clean)
Task 3: dispatched (base d7343fe)
Task 3: minor (deferred, FIX IN FINAL WAVE): ext not in allowed list (MIME-only pass, no dot, long ext) → documentStoragePath throws → 500; require hasAllowedUploadExtension → 415 (NODA needs extension)
Task 3: minor (deferred, FIX IN FINAL WAVE): concurrent confirms can duplicate rows — add UNIQUE (agent_id, storage_path) to 0031 (not yet applied) + map 23505 → 409
Task 3: minor (deferred): confirm branches only source-text tested (403 foreign path, 410, 409 order, ext mismatch, missing size)
Task 3: minor (deferred, DECIDE IN FINAL WAVE): suspended org no longer blocked at upload (old checkTokenLimit was for OCR) — Ruling D pending
Task 3: minor (deferred): orphan storage objects on refused/never-confirmed uploads — no purge
Task 3: minor (deferred): title no length cap; size 0 accepted; stale '/upload' in tests/route-auth.test.ts list
Ruling: confirm checks duplicate (409) before window/size deletes — never deletes an object a live row uses — cost if wrong: none
Ruling: PERMISSION_CALL regex accepts checkUploadTargets( — it loops canEditAgent over every agent and a test pins that — cost if wrong: a future helper could satisfy the regex without checking
Task 3: ⚠️ resolved — createSignedUploadUrl upsert defaults false; route-auth '/upload' entry is a stale allowlist line (harmless, cleanup deferred)
Task 3: complete (commits d7343fe..3f6167d, review clean)
Task 4: dispatched (base 3f6167d)
Task 4: minor (deferred, FIX IN FINAL WAVE): GET list reconcile does up to 5 sequential NODA list calls with 10s retry windows on page load — NODA outage slows the list up to ~50s; use a short no-retry list for reconcile
Task 4: fix round 1 dispatched (FIX_BASE 7516648) — deleting update error unchecked; comment; weak regex test; assign comment inaccurate
Task 4: fix round 1/5 (4 addressed, 0 open; commits 7516648..f14e753)
Task 4: minor (deferred, FIX IN FINAL WAVE): DELETE uses `if (nodaError)` — a falsy rejection value would read as success (route.ts:123-129); restore boolean flag
Task 4: minor (deferred): comments say read route won't revive 'deleting' — not true when markError set; assign comment cites plan task number
Task 4: complete (commits 3f6167d..f14e753, review clean)
Task 5: dispatched (base f14e753)
Task 5: minor (deferred): retry click can be overwritten by in-flight poll returning failed → polling stops (sequence ref fix)
Task 5: minor (deferred): loadData vs poll out-of-order; refresh after unmount; failed chip doesn't show noda_reason (READ_TIMEOUT_REASON useful); CreateAgentModal ignores edits on resubmit after agent created; trailing spaces in format hint
Task 5: ⚠️ resolved — confirm rows carry startReadingFields (Task 3 review confirmed noda_status 'reading')
Task 5: complete (commits f14e753..26a3b75, review clean)
Task 6: dispatched (base 26a3b75)
Ruling E: keep NODA context text when some sources come from this agent's non-ready rows (only their citations drop) — same agent's own uploaded content, isolation unaffected, and dropping all evidence while one document is mid-retry would hide valid answers — cost if wrong: a sentence may rest on a failed document's previous copy without a citation
Task 6: minor (deferred): preflight runs before bad conversation_id 404 / checkAttachable — may waste up to 10s
Task 6: minor (deferred, FIX IN FINAL WAVE): rag-test mixed-evidence critical log has orgId null — pass agent org
Task 6: minor (deferred): rag-test lets any org admin test any agent incl. others' personal agents (pre-existing wider gap)
Task 6: minor (deferred, FIX IN FINAL WAVE): mixed-evidence test doesn't assert category 'security'
Task 6: ⚠️ resolved — tsc passing implies loadAgentAccess fields exist; screen side is Task 7
Task 6: complete (commits 26a3b75..026373c, review clean)
Task 7: dispatched (base 026373c)
Task 7: minor (deferred, FIX IN FINAL WAVE): resend after refusal passes [] chips; a non-refusal failure on resend loses the request and attachments (re-arm ref / restore chips)
Task 7: minor (deferred): refusals leave sent attachments unbound (count toward 20 cap until purge)
Task 7: minor (deferred): NODA chunk with no page/cell/section shows legacy '청크 N • 유사도: 0.0%'
Task 7: minor (deferred): refusal/resend flow untested (manual check by user)
Task 7: complete (commits 026373c..7804ca7, review clean)
Task 8: dispatched (base 7804ca7)
Ruling F: noda:check irrelevant-query and location steps are WARN (with --strict → FAIL); relevant-query stays FAIL — 0.80 filters only ~53% of unrelated questions by design, a FAIL there would make the deploy gate flaky — cost if wrong: a real relevance regression shows only as WARN
Task 8: fix round 1 dispatched (FIX_BASE 6da4b49) — roundtrip orphan cleanup; WARN steps; migrate reason label; migrate exit codes/key precheck; CLAUDE.md route count & stale lines
Task 8: fix round 1/5 (5 addressed, 0 open; commits 6da4b49..4fcbb9c)
Task 8: ⚠️ resolved — 'missing_key' exists in noda.ts; 99 route.ts files confirmed
Task 8: minor (deferred): noda-check fixed filename → concurrent roundtrip runs collide (operator script)
Task 8: minor (deferred, FIX IN FINAL WAVE): noda-migrate catch prints raw e.message (could carry NODA text)
Task 8: complete (commits 7804ca7..4fcbb9c, review clean)
Final review: dispatched (merge-base 6eb17fc..4fcbb9c)
Final review: Ready after fixes — Important: (1) list reconcile hangs on NODA outage + overlapping polls; (2) employee-agent reads stranded (sequential startReading; outside admin lists); (3) orphans blank search + false critical; deploy order creates orphans
Ruling D: block organizations with status 'suspended' at upload-url and confirm (org status only, no token budget — no OCR cost now) — suspended orgs shouldn't create NODA work — cost if wrong: a suspended org admin can't upload until reactivated (intended)
Ruling G: deploy order becomes 0031 → push → noda:migrate — old code's DELETE between migrate and push would orphan NODA copies; cost: the 2 legacy docs unsearchable for minutes
Ruling H: in sourcesToChunks, a source doc id with NO documents row anywhere = orphan → this turn uses no evidence (context dropped, since it is deleted content), best-effort NODA delete of that filename in this agent's tenant, warning log; a doc id whose row belongs to ANOTHER agent = mixing → null + critical (R5) — self-heals orphans without hiding real cross-agent leaks — cost if wrong: one turn without evidence when an orphan appears
Final fix wave: dispatched (FIX_BASE 4fcbb9c)
Final fix wave: 14/14 addressed (commit 2301247); re-review clean. Deferred minors: deleteOrphans sync log throw; race-found row dropped without log; isOrganizationSuspended uses console.error; ALLOWED_UPLOAD_MIME_TYPES unused
