# Roadmap: URL-to-Anything Pipeline

This repo (`cairnstone-tool-miner-mcp`) started as a narrow MCP-tool miner.
The actual goal is bigger: take a URL (or any source), classify what it's
best turned into, and route it to the right generator — MCP tool, video,
song, video game, software program, document, etc. This doc is the build
order to get there without skipping steps that break later phases.

## Where we actually are (honest baseline)

**Verified working (2026-06-30, commit `c3c8e36`):**
- End-to-end plumbing: source → evidence → candidates → score → compare →
  build plan → no-auth MCP app blueprint → wrangler contract with the
  `CAIRNSTONE_V5` service binding correctly inherited.
- `mine_cairnstone_chain` reads a real CairnStone chain (manifest, HEAD,
  query-expand) over the service binding — confirmed live via the
  `bridge_source` field, not falling back to broken HTTP.
- Article→mini-repo ingestion (`article_url_to_safe_mini_repo`) produces a
  real, copyright-safe, stoned mini-repo from a URL.

**Not actually solving the stated goal yet:**
- `evidence()` is a flat keyword-presence scanner against ~25 hardcoded
  terms. It detects whether words like `mcp`, `wrangler`, `admin`,
  `article` appear in the text — it does not understand what the source
  is *about*.
- The candidate generator is exactly 5 fixed if-this-keyword-set-matches
  templates. Every source that trips enough buckets gets back the same
  5 candidates, nearly word-for-word (same `why_useful`, same
  `input_schema`, same boilerplate `handler_plan`). This is why mining
  our own STONEYARD/build-plan scaffolding produced "MCP tool mining
  tools" — it pattern-matched our own vocabulary, not the source's
  actual content.
- There is no output-type decision at all. Every candidate this miner
  can produce is an MCP tool. There's no path to "this should become a
  video," "this should become a song," etc.

## Build order

Each phase only starts once the prior phase is real-content-tested, not
just unit-tested against the keywords it was written to catch.

### Phase 1 — Real content classification (replaces keyword bag)
Goal: given arbitrary source content, produce an actual understanding of
what it's about, not a term-presence checklist.
- Replace `evidence()`'s flat term list with a real classification step
  (LLM-based summarization + topic/intent extraction is the right tool
  here — regex keyword matching cannot generalize to "what is this
  article actually proposing").
- Confidence should reflect semantic relevance to a candidate capability,
  not raw keyword hit count.
- Acceptance test: feed the miner 5 genuinely different source types
  (a recipe blog post, a SaaS API doc, a research paper, a product
  landing page, a GitHub repo) and confirm the candidates it proposes
  are visibly different and actually relevant to each, not the same 5
  templates every time.

### Phase 2 — Output-type router
Goal: before generating any candidates, decide what kind of output the
source is best suited to become.
- Define the output taxonomy explicitly: `mcp_tool`, `document`,
  `audio_song`, `video`, `software_app`, `game` (extend as needed).
- Build a classifier step that scores source content against this
  taxonomy and returns ranked output-type recommendations with
  reasoning — not a forced single choice, since some sources legitimately
  fit more than one lane (e.g., a tutorial article could become both a
  document and an MCP tool).
- This sits between Phase 1's content understanding and any
  type-specific generator — it's the fork point, and it should be the
  only place that decision gets made (no duplicating classification logic
  inside each lane).

### Phase 3 — Per-output-type generator lanes
Goal: one real generator pipeline per output type, built in order of
proximity to what already works (cheapest to build on existing
infrastructure first):
1. **`mcp_tool`** (this repo) — already has plumbing; needs Phase 1's
   real classification wired in so candidates stop being templated.
2. **`document`** — closest lane to existing code (docx/pdf/md skills
   already exist in the AFO toolchain); mostly an output-formatting
   problem once Phase 1 produces real content understanding.
3. **`software_app`** — natural extension of the existing no-auth MCP
   app blueprint pattern, generalized beyond MCP-only apps.
4. **`audio_song`** — net-new generator, needs its own model/tool
   integration.
5. **`video`** — net-new generator, higher production complexity than
   audio.
6. **`game`** — highest complexity, likely composes outputs from
   multiple other lanes (code + audio + video + narrative).
Each lane gets its own `candidate → blueprint → build → verify → stone`
cycle mirroring the pattern already proven in this repo, not a
from-scratch design each time.

### Phase 4 — Orchestration entry point
Goal: a single "paste a URL, get the routed output" front door.
- Wires Phase 2's router to whichever Phase 3 lane(s) it selects.
- Every step (classification, routing decision, generated output) gets
  stoned with proper `documents`/`patches`/`supersedes` edges so the
  full provenance chain — from raw URL to final artifact — survives
  across sessions, the same discipline already used in this repo.

## Working rule for this build

Don't start a phase until the previous phase has been tested against
content it wasn't specifically written to handle. A phase that only
passes on the examples used to design it isn't done — it's demoed.
