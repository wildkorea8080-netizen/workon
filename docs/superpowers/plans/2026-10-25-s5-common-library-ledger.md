# SDD ledger — plan: docs/superpowers/plans/2026-10-25-s5-common-library.md
Spec: docs/superpowers/specs/2026-10-25-s5-common-library-design.md
Branch: s5-common-library (from main adcb4d7). Execution: subagent-driven (user said "그냥 진행해" — chosen by controller like S1~S4)

## Preflight scan
| Pair / task | Produces → consumes | Found |
|---|---|---|
| T1→T2 | NodaStatus 'retired', StoredDocument.org_type | agrees |
| T2→T3 | ReadingDeps.tenantOf/afterReady | agrees; T3 changes applyNodaEvent deps to {agent?,common?} — T2 must not change webhook behavior (agrees) |
| T1→T3 | commonTenant/orgTypeFromCommonTenant/isOrgType/CommonDocument | agrees |
| T3→T6 | commonReadingDeps, deleteCommonDocument | agrees |
| T4→T5 | shiftContext, maxCitationNumber, commonSourcesToChunks, chunkFromSource, CONTEXT_BUDGET_* | agrees |
| T1→T5 | OrgType/isOrgType/commonTenant; CommonSearchDoc.org_type OrgType vs DB text | fine (cast at boundary) |
| T6→T7 | upload-url {path, token}; confirm {id}; read; list; delete | agrees |
| T5→T8 | RetrievedChunk.scope/editionYear persisted | agrees |
| T1 self | tests match functions | ok |
| T2 self | test helper names (worldWith/uploads) may not exist | brief says adapt to file's helpers — ok |
| T3 self | tests + webhook test signature change | ok |
| T4 self | chunkFromSource extraction must keep doc-search-noda tests green | ok |
| T5 self | large multi-file | ok, standard model |
| T6 self | route-auth AUTH_CALL includes getSuperAdminFromRequest | verified |
| T7/T8/T9 self | ok | ok |
No rulings needed at preflight.
Task 1: dispatched (BASE aabfdf2, implementer sonnet)
Task 1: ⚠️ resolved — users.id is uuid (0001), gen_random_uuid used since 0005, organizations.type written by super UI with same ORG_TYPES list
Task 1: minor (deferred): commonNodaFilename extension uncleaned (Task 6 confirm runs checkUploadFile extension allowlist — verify there)
Task 1: minor (deferred): title filter lacks \p{Zl}\p{Zp}; trailing spaces after 80-char cut; literal RLO char in test file
Task 1: complete (commits aabfdf2..e10bf92, review clean)
Task 2: dispatched (BASE e10bf92)
Task 2: ⚠️ resolved — webhook afterReady is in Task 3 brief (carry in dispatch)
Task 2: minor (deferred): lost-write afterReady test lacks row-state assertion; runAfterReady assumes deps.log never throws
Task 2: complete (commits e10bf92..354ebcb, review clean)
Task 3: dispatched (BASE 354ebcb)
Task 3: ⚠️ resolved — afterReady on read/reconcile verified in Task 2 review; types via tsc
Task 3: minor (deferred): retired old edition copy can be re-created by an in-flight read of the old edition (doc search drops retired rows; optional webhook cleanup for ready-on-retired)
Task 3: minor (deferred): markDeleting unconditional — racing afterReady can turn retired into deleting (add retired_at IS NULL guard in retire path)
Task 3: minor (deferred): row-delete failure returns 502 without system_logs entry
Task 3: minor (deferred): webhook orphan cleanup uses event tenant string instead of commonTenant(orgType)
Task 3: complete (commits 354ebcb..2b66261, review clean)
Task 4: dispatched (BASE 2b66261)
Task 4: ⚠️ resolved — RetrievedChunk scope/editionYear exist (Task 1, reviewed); tests pass per report
Task 4: minor (deferred): commonSourcesToChunks ignores org_type (caller must pass only this type's rows; mixing detected via findCommonDocuments in Task 5); shiftContext no guard for negative/NaN offset; no test of ocr/cellRange on common path
Task 4: complete (commits 2b66261..0f5ebe7, review clean)
Task 5: dispatched (BASE 0f5ebe7, implementer opus)
Task 5: Ruling: agent-side 섞임 (another agent's doc in agent vault evidence) must also drop common evidence — mixing is a vault-mixup/security signal and the spec's failure criterion forbids mixed evidence; spec 5.3 only spelled out the common side — cost if wrong: a turn with an agent-side mix answers with no evidence instead of common-only evidence (rare, logged critical)
Task 5: review — spec ❌ (agent-side mixing doesn't drop shared evidence, per ruling); Important 1
Task 5: minor (deferred): same-type row missing from preflight list drops shared evidence silently; doc-search ↔ doc-search-common mutual import; double 1.5s orphan wait worst case; agent-only header changed to '참고 자료(이 기관 문서):' (tests updated)
Task 5: ⚠️ — org_type values must equal ORG_TYPES (0033 CHECK enforces); getContext budget passthrough verified in Task 4 review
Task 5: fix round 1/5 dispatched (resume implementer; FIX_BASE 5a3b7e0)
Task 5: fix round 1/5 (1 addressed, 0 open; commits 5a3b7e0..2d4766d)
Task 5: complete (commits 0f5ebe7..2d4766d, review clean)
Task 6: dispatched (BASE 2d4766d)
Task 6: ⚠️ resolved — readDocument only acts on reading (or failed+retry), so retired rows can't restart; documents bucket has no prefix policy / limit Unset (memory)
Task 6: minor (deferred): failed new edition blocks same-title upload until deleted (screen should explain — carried into Task 7); delete log after_data lacks usage_terms; route tests source-text only
Task 6: complete (commits 2d4766d..460c9a7, review clean)
Task 7: dispatched (BASE 460c9a7)
Task 7: ⚠️ resolved — kick passes through reconcileReading (Task 6 review traced); real rendering needs browser check by user
Task 7: minor (deferred): tab switch during upload can paint old type's rows (disable tabs while uploading or guard orgType); kickedRef never cleared; optimistic retry; error/status messages persist across tabs; labels without htmlFor
Task 7: complete (commits 460c9a7..2dbef65, review clean)
Task 8: dispatched (BASE 2dbef65)
Task 8: ⚠️ resolved — persist of scope/editionYear done in Task 5 (reviewed, tested in message-persistence)
Task 8: minor (deferred): editionYear 0/negative not guarded in label; require('fs') style in test; RAGSearchTester has no [공통] (rag-test is agent-vault only by plan ruling, so it never receives common chunks)
Task 8: complete (commits 2dbef65..a8fa4c0, review clean)
Task 9: dispatched (BASE a8fa4c0)
Task 9: review — ❌ trailer Sonnet 5.5 (Critical), machine workaround in CLAUDE.md (Important)
Task 9: minor (deferred): long S5 suffixes in test-table rows; CLAUDE.md header claims next build passed (build unverified on this machine — OOM)
Task 9: fix round 1/5 dispatched (resume implementer; amend 88f89e7 — local unpushed tip)
Task 9: fix round 1/5 (2 addressed, 0 open; amended 88f89e7 → 905d6ed; scoped check by controller: trailer exact, maxWorkers removed, fix diff = CLAUDE.md 1 line)
Task 9: complete (commits a8fa4c0..905d6ed, review clean)
Final review: dispatched (MERGE_BASE adcb4d7)
Final review: With fixes — Important 1 (non-citable common passages still in prompt), Important 2 (failed retire never retried); minors 3 (deploy-order blast radius), 4 (CLAUDE.md stale NODA-outage line), 5 (same-title race)
Ruling: final fix wave = Important 1, Important 2 (a)+(b), Minor 4, T9 header build claim softened, T6 delete log usage_terms — cheap and spec-backed; Minor 3 not hardened (deploy order documented: 0033 before code) — cost if wrong: a deploy-order slip makes doc_search agents of typed orgs answer 503 until 0033 is applied
Ruling: Minor 5 same-title race accepted (single operator team, spec puts uniqueness in route) — cost if wrong: two current editions with same title, visible in operator list, fixable by delete
Final fix wave: dispatched (FIX_BASE 905d6ed)
Final fix wave: re-review — all 5 addressed, no new Critical/Important (commits 905d6ed..4253407)
Final review: residual minor (deferred): accepted common chunk without numeric n would drop common header (NODA always sends n); first list GET after failed retirement during NODA outage waits on delete retry window once
Branch complete: adcb4d7..4253407
