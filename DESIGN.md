# Design System — Second Brain

> "The Annotated Brain." A scholar's annotated manuscript, not a chat app.
> The memorable thing: **the AI actually knows MY notes** — so provenance is the
> protagonist, not a footnote.

## Product Context
- **What this is:** An AI-native, local-first second brain. An Electron desktop app
  that reads and writes your existing Obsidian vault (markdown + wikilinks + tags).
- **Who it's for:** Power users who already live in Obsidian and want an AI layer on
  top without giving up local-first control. BYO-API-key; nothing leaves the machine
  by default.
- **Space/industry:** Personal knowledge management / tools for thought. Peers:
  Obsidian, Notion, Reflect, Mem.
- **Project type:** Desktop app (three-pane: vault tree · editor · AI).
- **The moat, stated as design:** Every competitor styles the AI as a *guest* — a
  chatbot in a corner. Here the AI is a research partner that annotates in the margins
  of your notes and shows its sources. Grounding/provenance is promoted from a hidden
  status line to the signature visual element.

## Aesthetic Direction
- **Direction:** The Annotated Brain — literary editorial. Warm paper, ink, real
  margins, Tufte-style sidenotes.
- **Decoration level:** intentional — typography and margins do the work; one accent
  carries all the meaning. No floating cards, no heavy shadows, no decorative blobs.
- **Mood:** Calm enough to trust with your brain; a distinct serif voice and a
  signature way of showing where an answer came from.
- **Signature motif — provenance-as-hero:** When the AI grounds an answer, each claim
  gets a numbered margin sidenote with a thin evergreen thread back to the exact
  source note. The marker (`¹`) appears inline in the prose; the annotation lives in
  the margin; a source chip (`↳ SUMMARY.md · D1–D15`) names the origin.

## Typography
- **Display / voice:** **Fraunces** (variable, optical sizing) — weights 400–600, use
  italic for emphasis moments. Warm, intelligent, opinionated. Titles, hero, note
  headings, "in the margin" labels.
- **Body / UI / editor:** **Geist** — weights 400/500/600. Clean, modern, crisp at
  13–15px, supports `tabular-nums` for data. The editor surface uses Geist (user chose
  sans over serif for the writing surface): 15px / line-height 1.7, calm and bookish.
- **Mono / wikilinks / tags / code:** **Geist Mono** (fallback: JetBrains Mono, then
  `ui-monospace`). Used for `[[wikilinks]]`, `#tags`, file paths, sidenote markers,
  section kickers.
- **Loading:** Google Fonts (or self-host for offline-first per D17). Families:
  `Fraunces:opsz,wght@9..144,400;500;600`, `Geist:wght@400;500;600`, `Geist Mono`.
- **Scale (px):** display 56–86 (Fraunces, clamp for hero) · h2 34 · h3 22 ·
  body 15.5 · editor 15 · ui-label 14 · small 13 · mono-meta 11–12 · kicker 12 (mono,
  letter-spacing .12–.14em, uppercase). Letter-spacing -.02em on large Fraunces.

## Color
**Approach:** monochromatic + a single evergreen. Evergreen is the only chromatic
color in the chrome; it earns its place by carrying meaning (provenance threads,
sidenote markers, active links, the "grounded" dot, primary buttons). Ember is
reserved for tags only.

### Light — "Cool Linen"
| Token | Hex | Use |
|-------|-----|-----|
| `--paper` | `#F6F6F3` | app canvas |
| `--paper-2` | `#ECECE8` | tree / panel fills, mock bar |
| `--card` | `#FFFFFF` | raised surfaces |
| `--ink` | `#1B1B18` | primary text |
| `--ink-2` | `#5A5852` | secondary text |
| `--ink-3` | `#918F86` | tertiary / meta |
| `--teal` (evergreen) | `#0F6E5A` | accent — provenance, links, primary action |
| `--teal-soft` | `#0F6E5A1C` | accent tint (chips, sidenote field, selection) |
| `--amber` (ember) | `#B8430F` | tags only |
| `--hair` | `rgba(27,27,24,0.11)` | dividers / borders |
| `--hair-2` | `rgba(27,27,24,0.06)` | faint dividers |

### Dark — "Cool Linen at night" (real dark, not dim grey)
| Token | Hex | Use |
|-------|-----|-----|
| `--paper` | `#0C0D0F` | near-black canvas |
| `--paper-2` | `#131418` | tree / panel fills |
| `--card` | `#141519` | lifted surfaces (read as panels) |
| `--ink` | `#F1EFE8` | primary text |
| `--ink-2` | `#9D9A90` | secondary text |
| `--ink-3` | `#6A6860` | tertiary / meta |
| `--teal` (evergreen) | `#15795F` | accent — deep pine, matches the light-mode green |
| `--teal-soft` | `rgba(21,121,95,0.22)` | accent tint |
| `--amber` (ember) | `#EC8A52` | tags only |
| `--hair` | `rgba(241,239,232,0.11)` | dividers |
| `--hair-2` | `rgba(241,239,232,0.05)` | faint dividers |

- **Both modes are first-class.** Dark is a real near-black with lifted surfaces, not
  a washed charcoal. The evergreen stays a deep pine in dark (`#0F6E5A` light →
  `#15795F` dark) — close to the light value, moody rather than glowing.
- **Semantic colors:** reuse the system — `--teal` for success/grounded, `--amber`
  for warnings/tags. Error: `#D6453A` (light) / `#FF6B5E` (dark). Keep semantic color
  rare.

## Spacing
- **Base unit:** 8px.
- **Density:** comfortable — it's a reading app; give it air.
- **Scale (px):** 2xs(2) xs(4) sm(8) md(16) lg(24) xl(32) 2xl(48) 3xl(64).
- Editor padding generous (≈36–40px horizontal); margins/sidenotes get real room.

## Layout
- **Approach:** flat editorial — evolve away from the old "floating cards on a tinted
  canvas." Use hairline dividers (`--hair-2`) to separate regions, not shadows.
- **Three regions:** LEFT vault file tree (≈200–240px, collapsible) · CENTER the note
  (the manuscript) · RIGHT the margin where the AI annotates (≈300px). The margin is
  part of the editor surface, not a separate chat card.
- **Max content width (note prose):** ~60ch for comfortable reading.
- **Border radius:** sm 7px (tree items, chips) · md 9–12px (inputs, cards) ·
  lg 16px (outer mock/app frame) · full 999px (pills, buttons). Restrained, not the
  uniform-bubble AI-slop radius.
- **Surfaces:** light = white cards on linen; dark = lifted `#141519` panels on
  near-black. Soft shadow allowed only on the outermost app frame, never on inner
  chrome.

## Motion
- **Approach:** minimal-functional + one signature.
- **Signature:** provenance threads draw in (~250ms ease-out) when the AI grounds an
  answer — the connection between a claim and its source note animates into place.
  This is the one expressive moment; everything else is calm.
- **Easing:** enter `ease-out` · exit `ease-in` · move `ease-in-out`.
- **Duration:** micro 50–100ms · short 150–250ms (theme swap ~350ms) · medium
  250–400ms · long 400–700ms (reserve for the thread draw-in).

## Anti-slop guardrails (do NOT introduce)
- No system-ui / `-apple-system` as the display or body voice (that's the old look we
  left behind).
- No Apple blue `#007aff` — evergreen is the accent now.
- No purple/violet gradients, no 3-column icon-in-circle feature grids, no
  centered-everything, no uniform bubble-radius, no gradient CTA buttons, no
  decorative blobs.
- The AI must not look like a guest chatbot. It annotates the manuscript.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-06-08 | Initial design system created | /design-consultation. Memorable thing: "the AI actually knows MY notes." |
| 2026-06-08 | Direction: "The Annotated Brain" (WILD-2) | Provenance-as-hero; AI writes in the margins with Tufte sidenotes. Chosen over Terminal-for-Thought and Living-Graph. |
| 2026-06-08 | Fonts: Fraunces (voice) + Geist (body/editor) + Geist Mono | Serif voice for memorability; clean sans editor surface (user chose sans over serif reading mode). |
| 2026-06-08 | Accent: single evergreen, "Cool Linen" palette | Monochromatic + one meaningful accent. Cool Linen (neutral paper #F6F6F3, pine #0F6E5A) chosen over Crisp / High-contrast after live comparison. |
| 2026-06-08 | Real dark mode (near-black #0C0D0F + lifted #141519) | First dark attempt read as dim grey; reworked to true dark with lifted surfaces. Both modes first-class. |
| 2026-06-08 | Dark evergreen → deep pine #15795F | User preferred the original deep pine; #45C79F and #33A082 both read too bright on near-black. Settled on #15795F, close to the light-mode #0F6E5A. |
