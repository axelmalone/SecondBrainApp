# TODOS

## P1 — Gate Milestone 1

### Two-apps-one-vault file-safety contract
- **What:** Atomic writes (write-temp-then-rename), conflict detection (mtime/hash check
  before write), and backup-before-write for the companion app sharing a vault with Obsidian.
- **Why:** Companion app and Obsidian both write the same markdown files. Concurrent writes
  corrupt notes. In a second brain, data loss is the highest-trust-cost failure possible.
- **Context:** Surfaced by the outside-voice review of the AI-second-brain CEO plan
  (2026-06-04). The design doc took "no clobbering" for granted; this makes it real.
- **Effort:** S/M (human) / S (CC). **Priority:** P1 (load-bearing for M1 being safe to
  daily-drive). **Depends on:** the M1 vault read/write layer.

### Demand-gate time-box + kill condition
- **What:** Write a 30-day time-box and an explicit kill/pivot condition for the demand gate
  ("5 power users try M1, 3 say they'd pay") before M1 ships.
- **Why:** With no deadline and no pre-committed "if not, then X," the founder-as-user builds
  forever and never runs the gate. The outside voice named this the most likely path to a
  polished tool-for-one nobody pays for.
- **Context:** Surfaced by the outside-voice review (2026-06-04). The plan had the gate but
  no failure mode.
- **Effort:** S (human) / S (CC). **Priority:** P1. **Depends on:** nothing — write it now.

### Demand-gate-vs-hardening sequencing (D11) — RESOLVED (D13, 2026-06-07)
- **RESOLVED → SPLIT SEQUENCE.** The 12 ★★★ rows split by what they protect:
  - **DATA-LOSS rows (pre-gate, blocking):** saveNote durability + reconcile-no-clobber.
    These protect the tester's REAL Obsidian notes; a bug here destroys their data and
    poisons the demand signal. MUST pass before any tester touches M1.
  - **SECURITY/AUTH rows (post-gate, deferred):** redaction boundary, keychain-missing,
    keys.enc tamper, gateway typed-error contract. These protect a BYO-key that already
    lives on the tester's own machine; a leak to a local log during a 5-person gate is far
    lower stakes. Land them after the gate confirms demand.
  - **Consequence:** "M1-safe-for-gate" ≠ "M1-fully-hardened." Do NOT widen the tester pool
    or ship publicly until the security/auth rows pass. Write this split into the
    "Demand-gate time-box + kill condition" doc as the sequencing of record.
- **What:** Decide the M1 execution order: harden the 12 ★★★ data-loss/security/auth rows
  FIRST (current plan), then run the demand gate — OR run the demand gate first and only do
  full hardening if demand is confirmed. Write the sequencing choice inside the "Demand-gate
  time-box + kill condition" document above when you write the 30-day time-box.
- **Why:** Hardening-first risks weeks of sunk cost on a tool nobody wants. Gate-first risks
  giving testers a corrupted first impression — real Obsidian notes are at stake, and one
  corruption event during the gate poisons the channel and gives a false "nobody wants this"
  signal. The sequencing determines whether the M1 hardening gate is a pre- or post-gate
  commitment. Getting it backwards is expensive to reverse mid-sprint.
- **Context:** Surfaced by D11 outside-voice adjudication (2026-06-04, /plan-eng-review).
  Outside voice argued gate-first; recommendation was hardening-first (corruption poisoning
  the demand signal is the costlier mistake when real notes are on the line). Axel deferred
  — to be resolved when writing the demand-gate time-box document.
- **Effort:** S (human decision, no build). **Priority:** P1. **Depends on:** "Demand-gate
  time-box + kill condition" above — write the sequencing decision inside that document.

### Multi-chat persistence location (D10) — RESOLVED (D14, 2026-06-07)
- **RESOLVED → OPTION A: app-private store, one append-only file per chatId, OUTSIDE the
  vault.** Vault holds only notes (clean separation); multi-chat isolation = filesystem
  boundary (explicit + auditable); a chat-storage bug can never corrupt a note; append-only
  gives crash durability for free (partial last line, never a lost session). The multi-chat
  isolation [→E2E] critical path in the test plan loses its "storage contract TBD"
  annotation — isolation is now a filesystem boundary.
- **What:** Decide where M1 multi-chat sessions are stored on disk: (A) app-private store,
  one append-only file per chatId (vault isolation = filesystem boundary; recommended option
  from /plan-eng-review); (B) inside the vault as markdown notes (expands ★★★ data-loss
  surface — NOT recommended); (C) in-memory only, no persistence (sessions lost on quit or
  crash — NOT recommended); or (D) a different scheme entirely. Lock the choice before the
  multi-chat UI module is built.
- **Why:** The multi-chat isolation E2E critical path currently carries a "storage contract
  TBD" annotation. Building isolation guarantees without knowing the storage contract means
  the guarantees may not hold. Getting it wrong either silently expands the data-loss surface
  (option B) or means every session restart loses chat history (option C). Option A is the
  recommended starting point: vault holds only notes (clean separation), one file per chatId
  (isolation = filesystem boundary), explicit and auditable.
- **Context:** Surfaced by D10 outside-voice adjudication (2026-06-04, /plan-eng-review).
  Recommendation was option A (app-private store). Axel deferred for later decision. The
  multi-chat-isolation [→E2E] critical path in the test plan is annotated "storage contract
  TBD — see TODO."
- **Effort:** S (human decision) / S (CC, once location is chosen). **Priority:** P1.
  **Depends on:** M1 multi-chat UI spec — decide before building persistence layer.

### M1 ★★★ hardening test pass — explicit exit gate (D1, split by D13)
- **SPLIT BY D13 (2026-06-07):** the 12 rows now have two gates, not one.
  - **Pre-gate (blocking the demand gate):** saveNote durability + reconcile-no-clobber
    (incl. D7 TOCTOU re-hash-before-rename, NoteDeleted, rename branches). No tester touches
    M1 until these pass — they protect the tester's real notes.
  - **Post-gate (blocking public/wider release, NOT the 5-person gate):** redaction boundary,
    keychain-missing → typed AuthFailed app-still-opens, keys.enc tamper → fail-closed,
    gateway typed-error contract. "M1-safe-for-gate" ≠ "M1-fully-hardened."
- **What:** A single P1 TODO that names the 12 ★★★ data-loss/security/auth rows as the
  non-negotiable M1 exit gate: M1 is NOT "done" until all 12 pass. The rows: saveNote
  durability (atomic write + kill-9 crash → note whole), reconcile-no-clobber (incl. the
  D7 TOCTOU re-hash-before-rename, NoteDeleted, rename branches), redaction boundary (no
  raw key in any error/log/event), keychain-missing → typed AuthFailed but app STILL
  opens, keys.enc tamper → fail closed no crash, and the gateway typed-error contract.
- **Why:** D1 set the build order to happy-path-first. Without a named exit gate, happy-
  path-first quietly becomes happy-path-only and the ★★★ rows ship half-done. These rows
  currently live only in the test-plan artifact; nothing in the founder-facing TODO list
  says "the core is not safe to daily-drive until they all pass." In a second brain, a
  single data-loss event is the highest-trust-cost failure possible.
- **Context:** Surfaced by D1 (build order) + the test-plan ★★★ rows, adjudicated
  2026-06-04 (/plan-eng-review). The 12 rows are enumerated in the eng-review test plan:
  ~/.gstack/projects/Claude/axelmalone-unknown-eng-review-test-plan-20260604-171305.md.
- **Effort:** S (human, it's a gate definition + CI wiring) / S (CC). **Priority:** P1
  (load-bearing for M1 being safe to daily-drive). **Depends on:** the M1 vault read/write
  layer and the model-gateway redaction boundary existing.

### Grounding-unavailable visible-fail contract (D12)
- **What:** When vault-grounded retrieval fails or returns garbage (empty/failed embedding,
  zero usable chunks, index not yet built), the cockpit must surface a typed
  `GroundingUnavailable` state and answer with an inline "answering without vault context"
  badge — NEVER silently answer ungrounded as if it were grounded. Add an eval fixture: a
  note that fails to embed → the answer MUST show the badge, never a silent ungrounded reply.
- **Why:** Auto-grounding is the design doc's sharpest single differentiator ("kill the
  manual context feed"). The Failure Modes Registry flagged this as CRITICAL GAP #1:
  grounding retrieval garbage/empty embedding currently has RESCUED=N, TEST=N, and the
  failure is SILENT — the user gets a confident ungrounded answer believing it was grounded
  in their vault. In a second brain, a silently-ungrounded answer is a trust-eroding failure:
  the user acts on it thinking it reflects their notes when it does not.
- **Context:** Surfaced by the Failure Modes Registry (CRITICAL GAP #1) during the M1
  eng review, adjudicated 2026-06-04 (/plan-eng-review) as D12. The fix adds net-new M1
  surface (a new typed variant + a new UI badge + a new eval fixture), so Axel chose to
  DEFER it to a TODO rather than bake it into the M1 gate (overriding the bake-in-now
  recommendation) — keeping M1 minimal and focused. This is the visible-fail twin of the
  D9 retrieval-quality eval gate: D9 proves grounding lands when it works; this proves the
  user is never fooled when it does not. Sequence it close to the D9 eval work — they share
  the vault fixture.
- **Effort:** S (human) / S (CC). **Priority:** P1 (load-bearing for the differentiator
  being trustworthy, but explicitly NOT an M1 exit gate per D12 — the M1 gate is the 12
  ★★★ rows). **Depends on:** the M1 grounding retrieval path (D9 locked: local embeddings
  over the Automerge doc + top-k chunk injection) and the gateway typed-error contract
  (the badge fires through the same boundary).

## P1.5 — After M1 daily-drives (from D8)

### Text-to-speech (TTS) in the cockpit (D8)
- **What:** Bring TTS to the cockpit — the one frustration Claudian cannot do at all.
  Audio plays on demand; on gateway error, fails soft inline (no crash, no silent fail).
- **Why:** TTS is the design doc's #1 named frustration. D8 CUT it from M1 so M1 ships
  text-only (multi-model switch, clean multi-chat UI, auto vault-grounded retrieval,
  in-app token/usage meter) and the data-safety core gate is not diluted by an audio
  feature. But TTS is a real differentiator and the founder's own daily pain, so it is
  the FIRST thing after M1 earns daily use — not a vague "someday."
- **Context:** Surfaced by D8 outside-voice adjudication (2026-06-04, /plan-eng-review).
  Axel chose to cut TTS from M1 (overriding the keep-in-M1 default). The test plan's TTS
  rows move from M1 to M1.5. A TTS provider good enough to fix frustration #1 is a
  dependency (named in the design doc).
- **Effort:** M (human) / S (CC). **Priority:** P1.5 (first post-M1 feature).
  **Depends on:** M1 shipping and daily-driving; a chosen TTS provider; the gateway
  typed-error contract (TTS errors must fail soft through the same boundary).

### Persistent disk-backed grounding index + launch reconcile (D16, 2026-06-08)
- **What:** Persist the grounding vector index to an app-private file (OUTSIDE the vault,
  like the chat store) so it survives quit instead of living in memory only. On launch, do a
  CHEAP reconcile — compare each note's mtime/size/hash against the saved index and re-embed
  ONLY the notes that changed while the app was closed — rather than re-embedding the whole
  vault. The file watcher already keeps the index live while the app runs; first index stays
  explicit (or auto-triggers the first time grounding is toggled on — clear user intent).
- **Why:** Today the index is in-memory only, so it dies on quit and must be fully rebuilt
  every session — the friction the "should it be automatic?" question was really pointing at.
  Persisting + launch reconcile makes grounding FEEL automatic and always-current without the
  cost of a full re-embed and WITHOUT doing heavy work on app close (rejected: quitting must be
  instant, and shutdown work is the most likely to be killed half-done for zero user benefit).
- **Context:** Raised by Axel 2026-06-08 ("should embedding be automatic, e.g. on close?").
  Adjudicated: NOT on close — persist + reconcile is the correct shape. Net-new surface beyond
  M1 (new on-disk index format + reconcile path), so explicitly deferred to a future version.
- **Effort:** M (human) / M (CC). **Priority:** P1.5. **Depends on:** the M1 grounding layer
  (D9 index + incremental reindexNote/removeNote) and the DiskBaseline mtime/size/sha256 helper
  already used by the vault I/O layer (reuse for the change-detection reconcile).

### Bundle the local embedding model with the app (D17, 2026-06-08)
- **What:** Ship the ~90MB embedding model (Xenova/all-MiniLM-L6-v2 onnx weights) inside the
  packaged app's resources and point TransformersEmbedder at the local path, instead of lazily
  downloading it from the HuggingFace CDN on first index.
- **Why:** The app's whole promise is "nothing leaves your machine by default." A surprise
  network fetch on first index is off-brand; bundling means no surprise call, works offline /
  air-gapped from the first click, and the first index isn't blocked on a download. Cost is a
  bigger installer (~90MB) — the right trade for a local-first privacy tool. (Auto-downloading
  DURING install is rejected: installers shouldn't pull weights; bundle them, or fetch on first
  use behind a clear one-time prompt — which the UI already half-does.)
- **Context:** Raised by Axel 2026-06-08 ("should the model download automatically on install?").
  This is a packaging task, naturally done when the Electron installer is set up. Does NOT remove
  the open npm vulnerabilities in @xenova/transformers' transitive deps — that's a separate
  pre-release cleanup.
- **Effort:** S (human) / S (CC). **Priority:** P1.5 (do alongside installer setup).
  **Depends on:** an Electron packaging/installer pipeline existing.

### Index progress reads as a note count, not chunks (UI clarity, 2026-06-08)
- **What:** The index progress line shows a bare number ("Indexing your vault… 43% (620/1450)")
  that is a CHUNK count, not a note count. Relabel it to name the unit and ideally show notes
  too, e.g. "Indexing… 43% · 1620/3788 sections (210 notes)".
- **Why:** A ~210-note vault produced "3788 things to index" and reasonably read as phantom
  notes. Each note splits into ~18 chunks (one per heading + ~1000-char packing in
  `chunkMarkdown`), so the chunk count dwarfs the note count. The number is correct; only the
  label is ambiguous. Cheap trust fix — an opaque "3788" makes the index look broken.
- **Context:** Raised by Axel 2026-06-08 watching the new progress readout (added with the
  batched indexer). Cosmetic; deliberately deferred — fold into the next grounding-UX change.
- **Effort:** XS (human) / XS (CC). **Priority:** P1.5 (do with the indexing-speed work below).

### Speed up first-index throughput: pipeline batches + multi-thread ONNX (2026-06-08)
- **What:** The batched indexer still under-saturates the CPU. Two levers: (1) PIPELINE — let
  the host queue several embed batches ahead so the single-threaded model never waits for the
  next batch over the stdio round-trip; (2) enable multi-threaded ONNX intra-op so inference
  uses more than one core. A larger batch size to amortize per-call overhead is worth testing.
- **Why:** Diagnosed by sampling the embedder child during a live index: it sat at ~33% of ONE
  core on an 8-core machine, idle between awaited batches — so a first index of a ~210-note
  (3788-chunk) vault takes minutes. Batching removed the per-note round-trip waste; pipelining +
  threads attack what's left of raw first-index speed. NOTE: D16 (persist + reconcile) is higher
  leverage — it removes the RECURRING cost (re-embedding the whole vault every launch). Do D16
  first; do this to make the one-time / changed-note index fast.
- **Context:** Diagnosed 2026-06-08 after the batching + progress change. The embedder runs in a
  stock-Node child (`src/grounding/childEmbedder.ts` + `embedderChild.ts`), so the ONNX threading
  config lives there.
- **Effort:** S (human) / S–M (CC). **Priority:** P1.5. **Depends on:** the child-process
  embedder (done); best paired with D16.

## P2 — Deferred (from CEO plan 2026-06-04)

> CONFIRMED DEFERRED (D15, 2026-06-07): indie-vs-venture, open-core distribution, and
> managed-inference-vs-BYO-key are all post-demand-gate founder calls. Each resolves
> differently depending on demand-gate data (would-they-pay + do-they-balk-at-BYO-key)
> that does not exist yet. Deciding now is false precision; the gate is the unlock. None
> block M1. Re-open only after the demand gate produces signal.

### Automatic 3-way text merge into the Automerge doc (D3 / D7)
- **What:** When Obsidian and the cockpit both edit the SAME note and both have changes,
  auto-merge the two text versions into the Automerge doc instead of prompting the user
  to pick keep-mine / take-theirs / keep-both. The M1 reconcile path deliberately NEVER
  auto-merges text — it always prompts on a real conflict. This TODO is the M2 upgrade to
  silent, correct 3-way merge for the common non-overlapping-edit case.
- **Why:** Prompting on every concurrent edit is safe but annoying once the app is a
  daily driver; most concurrent edits touch different parts of the note and could merge
  cleanly. Auto-merge removes that friction. It is explicitly M2, not M1, because a
  WRONG auto-merge silently corrupts a note — the exact highest-trust-cost failure the
  M1 gate exists to prevent. Earn the prompt-free path only after the prompt-based path
  is proven safe.
- **Context:** Surfaced by D3 (reconcile design) and reinforced by D7 (reconcile
  hardening), adjudicated 2026-06-04 (/plan-eng-review). M1 ships reload-or-prompt only;
  auto 3-way merge REJECTED for M1, deferred to M2. Automerge's CRDT merge is the
  mechanism, but the M1 design uses it only as an in-memory edit buffer, never to merge
  two divergent on-disk versions without user review.
- **Effort:** M (human) / M (CC). **Priority:** P2 (M2 — after M1 daily-drives).
  **Depends on:** the M1 reconcile + Automerge layer; a quality eval/fixture proving the
  merge never silently drops or duplicates a side before it's allowed to run prompt-free.


### Proactive second brain (v2 north star)
- Continuous vault indexing that surfaces connections, contradictions, and forgotten notes
  without being asked. Generalizes "kill the manual context feed" from reactive to proactive.
  Decide a thin v1 taste-slice ("related notes you forgot," surfaced on open) only after M1
  proves the reactive cockpit. Effort L (human) / M (CC).

### Open-core distribution strategy
- Open-source the local-first core, sell the closed cloud layer, build in public to the
  Obsidian/AI-power-user community. Decide at launch once M1 works. Reversible. Effort M / S.

### Managed-inference proxy vs BYO-key-only
- Outside voice flagged BYO-key as an adoption tax. Build managed-inference default (proxy +
  margin) with BYO-key as the privacy escape hatch IF the demand gate shows testers balk at
  bringing their own keys. Second revenue line via inference margin. Decide post-demand-gate.
  Effort M (human) / S (CC).

### Which game: indie vs venture
- Make this explicit before raising or hiring. Founder decision, not a build task

### Deferred design polish (from /design-review 2026-06-08)
- **FINDING-004 — sub-44px hit targets:** ☰ ⋯ + Key Index send all fall under the 44px
  touch guideline. Low priority on a mouse-driven desktop app; nudge ⋯/+ up if a
  touch/trackpad-heavy audience emerges. Polish.
- **FINDING-005 — native `<select>` model picker:** off the custom-pill aesthetic of the
  adjacent segmented control. A custom listbox is a larger change for marginal gain. Polish.
- (Fixed same session: composer placeholder clip 001, editor focus ring 002, button font 003.)

### Deferred QA finding (from /qa 2026-06-08)
- **QA-001 — default model is Sonnet 4.5, not 4.6:** `MODELS.anthropic` lists 4.5 first
  (renderer.ts:369) so it auto-selects as default; 4.6 is one entry down. OpenAI list
  (gpt-4o/o1) is also a generation behind. Product decision (which model new users land on),
  not a bug — reorder the array if you want 4.6 as default. Low.
