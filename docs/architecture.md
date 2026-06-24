# Architecture

CairnStone Tool Miner MCP is a post-stone analyzer.

```text
source
  ↓
CairnStone stone / chain / HEAD
  ↓
evidence extractor
  ↓
capability candidates
  ↓
Toolsmith duplicate check
  ↓
build-factory blueprint candidate
  ↓
compile / stamp / index
```

## Initial responsibilities

- Parse CairnStone chain summaries, HEAD refs, raw stone snippets, repo docs, websites, and MCP repos.
- Detect existing MCP tools from `server.tool`, `registerTool`, `tools/list`, `tools/call`, JSON-RPC, and input schemas.
- Recommend strict MCP tool candidates with evidence, confidence, input schema, handler plan, and bindings.
- Generate build-factory-style blueprint candidates.
- Score, compare, and create a build plan before stamping anything.

## Build-out phases

1. Evidence-first lexical parser.
2. GitHub/CairnStone expansion adapters.
3. AST route/function extraction.
4. Toolsmith inventory comparison.
5. Build-factory compile dry-run integration.
6. Report-stoning and graph-edge updates.
