# AI-Native Second Brain — Planning Summary

> Status: **PLANNING / DESIGN ONLY** — no code written yet. This document summarizes the design, strategy, and architecture decisions produced across the gstack planning sequence (office-hours → CEO review → eng review).

---

## 1. The Product

A from-scratch, **local-first, Obsidian-shaped, AI-native "second brain" notes app**.

- Same file model as Obsidian: plain **markdown + wikilinks + tags** on disk.
- **AI is first-class throughout**, not bolted on.
- Monetized as a **cloud subscription**.
- Architecturally a **"companion cockpit"**: it reads/writes the user's **EXISTING Obsidian vault** on disk and **coexists** with Obsidian (two apps, one vault).

### Build order vs. destination
- **Approach A — Companion Cockpit** = the chosen *build order* (first commits).
- **Approach B — Full from-scratch app** = the chosen *destination*.
- **Approach C — Vault-agnostic** = rejected.
- Guiding principle: *"B is the destination, not the first commit; sequencing is the survival mechanism."* Build in the order of A, aim at B.

---

## 2. Design Doc (APPROVED)

**Five frustrations driving the product:**
1. No TTS (text-to-speech).
2. No clean model switching.
3. Context not grounded in the vault.
4. Clunky multi-chat UI.
5. Out-of-app token tracking.

**Demand evidence: WEAK / founder-only** ("honestly, mostly just me right now").
→ This is the **#1 risk: tool-for-one.**

**Success criteria:**
- Axel abandons Claudian and daily-drives the app for 2+ weeks.
- **Demand gate** = 5 real power users (not Axel), of whom 3 say they'd pay.

---

## 3. CEO Plan (ACTIVE — Mode: SELECTIVE EXPANSION)

**Moat thesis:** *"Features are the demo; local-first is the moat."*

**Premise challenges & resolutions:**
- Two games, one plan (indie vs. venture) — still open (deferred to TODO).
- No structural moat — RESOLVED by Bet 1: local-first + BYO-key.
- 3-star vs. 10-star product — RESOLVED by Bet 2: proactive second brain as the v2 north star.

**Paid layer (reframed):** NOT plain file sync, but:
- (a) zero-knowledge / E2E-encrypted sync, and
- (b) an AI-native server-side feature that BYO-key local can't do alone.
- The **core is never paywalled**.

**Sync stance:** *"Sync is a first-class hard problem, NOT a bolt-on layer — spike early or buy an engine (Automerge/Yjs)."*

---

## 4. Locked M1 Architecture (10 decisions)

1. **Automerge CRDT** as in-memory canonical edit buffer; plain markdown on disk. Hydrate-on-open, serialize-on-save. *(confirmed via D5)*
2. **reload-or-prompt reconciliation:** atomic write-temp-then-rename; mtime+hash conflict detection captured at load; backup-before-write. External Obsidian write → silent reload if no unsaved edits, else prompt **keep-mine / take-theirs / keep-both**. NEVER auto-merges text (auto 3-way → M2).
   - *Amended by D7:* (a) re-stat + re-hash the on-disk file IMMEDIATELY before rename in the same critical section, abort to prompt if changed (closes TOCTOU); (b) typed `NoteDeleted` and rename branches.
3. **Automerge doc = single source of truth** feeding BOTH the editor UI and the retrieval index (DRY).
4. **model-gateway = the ONLY module talking to provider APIs.** Holds BYO-keys. Typed error contract: `Timeout`, `RateLimited (429)`, `BadResponse`, `Refusal`, `AuthFailed (401)`, `QuotaExceeded`. Retry/backoff ONLY on `Timeout` + `RateLimited`. No catch-all.
5. **keys.enc** = AES-GCM storage; OS keychain holds a single AES master key decrypted to memory at startup. Keychain-missing → typed `AuthFailed` but **app STILL opens**. keys.enc tamper → **fail closed, no crash**.
6. **Single redaction boundary** in the gateway; errors carry `{variant, status}` only.
7. **Grounding index freshness** = incremental re-index of only the changed note + ~500ms debounce; per-note dirty flag set by reconcile AND save.
   - *Amended by D6:* PLUS a vault-wide file watcher (fs.watch/chokidar) marking ANY externally-changed note dirty; dedupe against the app's OWN atomic writes; ignore `.obsidian/`.
8. *(D8)* **TTS CUT from M1 → M1.5.** M1 cockpit is **TEXT-ONLY.**
9. *(D9)* **M1 grounding retrieval method LOCKED** = local embeddings over the Automerge doc + top-k chunk injection. Quality eval against a fixed vault fixture is an **M1 GATE.**
10. *(D10 → RESOLVED by D14)* **Multi-chat persistence = app-private store, one append-only file per chatId, OUTSIDE the vault.** Isolation = filesystem boundary; chat bugs can never corrupt a note; append-only = crash durability for free.

---

## 5. Decision Log (D1–D12)

| # | Decision |
|---|----------|
| D1 | Happy-path-first (crash durability restored via D4) |
| D2 | Incremental re-index + ~500ms debounce |
| D3 | Auto 3-way merge → M2 |
| D4 | Restore a single kill-9 crash-durability sim into M1 |
| D5 | Keep Automerge in M1 |
| D6 | Add vault-wide file watcher |
| D7 | Full reconcile hardening (TOCTOU re-hash-before-rename, NoteDeleted, rename branches) |
| D8 | Cut TTS to M1.5 |
| D9 | Lock retrieval method + eval gate |
| D10 | Defer multi-chat persistence to TODO |
| D11 | Defer demand-gate-vs-hardening sequencing to TODO *(now resolved by D13)* |
| D12 | Defer grounding-garbage fix to TODO *(user OVERRODE the "bake in" recommendation)* |
| D13 | **Resolves D11 → SPLIT SEQUENCE:** data-loss rows (saveNote durability + reconcile-no-clobber) are pre-gate/blocking; security/auth rows (redaction, keychain, keys.enc, gateway typed-errors) are post-gate. "M1-safe-for-gate" ≠ "M1-fully-hardened." |
| D14 | **Resolves D10 → app-private store**, one append-only file per chatId, outside the vault (isolation = filesystem boundary) |
| D15 | **Confirm P2 deferral:** indie-vs-venture, open-core, managed-inference-vs-BYO-key all stay post-demand-gate (decide on gate data, not vibes) |

---

## 6. Milestone Ladder

| Milestone | Scope |
|-----------|-------|
| **M1** | Vault read/write + AI cockpit (**text-only**) |
| **M1.5** | TTS |
| **M2** | Live preview polish; fast search at 10k+ notes; backlinks / unlinked mentions; auto 3-way text merge |
| **M3** | Graph view; sync; mobile |
| **v3** | Email / calendar |

---

## 7. The 12 ★★★ M1 Gate Rows (non-negotiable)

Data-loss / security / auth. **Split by D13 into two gates:**

**Pre-gate (blocks the 5-person demand gate — protect testers' real notes):**
1. saveNote durability (atomic write + kill-9).
2. reconcile-no-clobber (incl. D7 TOCTOU re-hash-before-rename, `NoteDeleted`, rename branches).

**Post-gate (blocks public/wider release, NOT the 5-person gate — BYO-key lives on tester's own machine):**
3. redaction boundary (no raw key in any error / log / event).
4. keychain-missing → typed `AuthFailed` but **app STILL opens**.
5. keys.enc tamper → **fail closed, no crash**.
6. gateway typed-error contract.

*(34 total SPEC rows in the test plan; 0/34 implemented. "M1-safe-for-gate" = the pre-gate rows pass; "M1-fully-hardened" = all 12 pass.)*

---

## 8. Current TODOS

**P1 — Gate Milestone 1**
- (a) Two-apps-one-vault file-safety contract.
- (b) Demand-gate time-box + kill condition (30-day box).
- (c) Demand-gate-vs-hardening sequencing *(D11 → RESOLVED by D13: split sequence — data-loss rows pre-gate, security/auth post-gate)*.
- (d) Multi-chat persistence location *(D10 → RESOLVED by D14: option A, app-private, one append-only file per chatId)*.
- (e) M1 ★★★ hardening test-pass exit gate *(D1, 12 rows)*.
- (f) Grounding-unavailable visible-fail contract *(D12: typed `GroundingUnavailable` + inline badge + eval fixture; explicitly NOT an M1 exit gate)*.

**P1.5**
- TTS in cockpit *(D8)*.

**P2 — Deferred**
- Automatic 3-way text merge *(D3/D7, M2)*.
- Proactive second brain *(v2 north star)*.
- Open-core distribution strategy.
- Managed-inference proxy vs. BYO-key-only.
- Which game (indie vs. venture).
