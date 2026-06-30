# Stone-Doc Template: Writing Plans/PRDs That Compress Well

CairnStone's LOD ladder is **mechanical, not authored**. Before using this
template, know what you're actually optimizing:

- `lod5` = stats line: `"<title>: N lines, M refs, X ratio, Y flags"`.
  The only authored content in it is whatever `title` you pass at stone
  creation time — there is no auto-generated summary sentence.
- `lod4` = `lod5` + `top=<keywords>` — a term-frequency extraction across
  the whole document. Common/repeated words win, not "important" words.
- `lod3` = per-ref preview — each ref is a fixed **~80-line window** of
  raw content, sliced mechanically with no awareness of your headers.
  Its keywords are frequency-extracted from just that 80-line slice.
- `lod2`/`lod1` = full ref index / raw content — always complete, no
  optimization needed here.

Nothing here changes what the compressor does. The only lever you have
is **how you write the source document** so that mechanical slicing and
mechanical word-counting happen to produce something legible. That's
what this template is for.

## The four rules

1. **The stone title is your only authored summary — make it count.**
   `cairnstone_create_github_file_stone` / `cairnstone_create_stone`
   take a `title` argument that becomes `lod5`'s text verbatim. Write it
   as a real one-line summary of the document's conclusion or purpose,
   not a filename. Bad: `"roadmap.md"`. Good: `"PRD: replace keyword
   scanner with real content classification, Phase 1 of 4"`.

2. **Size sections to ~80 lines and make each one self-contained.**
   Refs don't know where your `##` headers are. If a section runs
   longer than ~80 lines, it gets split mid-thought across two refs and
   both summaries come out incoherent. If a section is much shorter,
   it gets merged with whatever comes next, polluting both keyword
   sets. Aim each major section at roughly one ref's worth of content,
   and make sure it would still make sense if someone only ever saw
   that one chunk.

3. **Use distinctive vocabulary once per section, not synonyms scattered
   everywhere.** Frequency extraction rewards words that repeat *within
   a chunk*. If you describe the same concept five different ways
   across a section, none of those words rank — pick the term you want
   to surface (e.g. "classifier", not alternating "classifier" /
   "router" / "decision engine" / "dispatcher" for the same thing) and
   use it consistently within that section.

4. **Front-load the point.** Both the doc-level preview (used in
   search/list views) and each ref's preview show the *first* ~250
   characters of that chunk. Open each section with its conclusion or
   the single most important fact, not throat-clearing context.

## Template

```markdown
# <Document title — this is also your stone title, keep them identical>

<One sentence: what this document is and what decision/state it
captures. This sentence is what a reader sees before opening anything.>

## <Section 1 name — distinctive, not generic ("Background")>

<~60-80 lines. Open with the conclusion or key fact. Use one consistent
term per concept throughout this section. Self-contained: assume the
reader only sees this chunk.>

## <Section 2 name>

<Same constraints. If you find this section running past ~90 lines,
split it — don't let it bleed into a second ref incoherently.>

## <Section N name>
...
```

## Quick self-test after stoning

After creating the stone, pull `lod4`/`lod3` and check:
- Does `lod5`'s text actually tell you what the doc is about, or is it
  generic stats? (If generic, your `title` argument wasn't a real
  summary.)
- Do `lod4`'s `top=` keywords look like the document's real subject, or
  like filler words (`the`, `and`, boilerplate phrases repeated across
  every section)?
- Does each `lod3` ref's keyword list map to one coherent idea, or does
  it look like two unrelated topics mashed together? (If mashed, a
  section boundary landed mid-ref — resize and re-stone.)

If any of those look wrong, the content needs adjusting — not the
compressor. Re-stone (new stone, `supersedes` edge, `set_head: true`)
once fixed.
