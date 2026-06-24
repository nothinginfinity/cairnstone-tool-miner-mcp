type Source = { type: string; name: string; content?: string; metadata?: Record<string, unknown> };
type Evidence = { kind: string; value: string; reason: string; confidence: number };

const toolNames = [
  "parse_source_for_tool_opportunities",
  "extract_existing_mcp_tools",
  "generate_blueprint_candidates",
  "score_tool_candidates",
  "compare_against_toolsmith_inventory",
  "create_build_plan"
];

const descriptions: Record<string, string> = {
  parse_source_for_tool_opportunities: "Parse source text/metadata into evidence-backed MCP candidates.",
  extract_existing_mcp_tools: "Detect existing MCP or JSON-RPC tools already present in source.",
  generate_blueprint_candidates: "Convert parsed candidates into build-factory-style blueprint candidates.",
  score_tool_candidates: "Rank candidates by utility, evidence, effort, safety, and duplication risk.",
  compare_against_toolsmith_inventory: "Compare recommendations against known Toolsmith tools.",
  create_build_plan: "Produce an ordered build plan for selected candidates."
};

const schema = {
  type: "object",
  required: ["source"],
  properties: {
    source: {
      type: "object",
      required: ["type", "name"],
      properties: {
        type: { type: "string" },
        name: { type: "string" },
        content: { type: "string" },
        metadata: { type: "object" }
      }
    }
  }
};

function sourceText(source: Source) {
  return `${source.name}\n${source.content ?? ""}\n${JSON.stringify(source.metadata ?? {})}`.toLowerCase();
}

function evidence(source: Source): Evidence[] {
  const raw = sourceText(source);
  const out: Evidence[] = [];
  const terms = ["stone", "chain", "head", "ref", "repo", "tool", "connector", "blueprint", "worker", "d1", "r2", "admin", "status", "receipt", "workflow", "jsonrpc", "tools/list", "tools/call", "inputschema"];
  for (const term of terms) {
    if (raw.includes(term)) {
      out.push({
        kind: ["stone", "chain", "head", "ref"].includes(term) ? "cairnstone" : term.includes("tool") || term.includes("jsonrpc") ? "mcp_tool" : "keyword",
        value: term,
        reason: `Detected ${term} signal in source.`,
        confidence: term.includes("tool") || term.includes("jsonrpc") ? 0.82 : 0.58
      });
    }
  }
  for (const match of raw.matchAll(/(?:get|post|put|patch|delete)\s+(\/[a-z0-9_./:{}-]+)/g)) {
    out.push({ kind: "route", value: match[1] ?? "", reason: "Detected route-like API surface.", confidence: 0.7 });
  }
  return out;
}

function parse(args: { source: Source; options?: { max_candidates?: number } }) {
  const e = evidence(args.source);
  const raw = sourceText(args.source);
  const candidates = [];

  if (["stone", "chain", "head", "ref"].some((t) => raw.includes(t))) {
    candidates.push(candidate("parse_cairnstone_chain_for_tools", "analysis", "Parse a CairnStone chain manifest and HEAD refs into MCP tool opportunities.", e));
  }
  if (["mcp", "tools/list", "tools/call", "inputschema", "jsonrpc"].some((t) => raw.includes(t))) {
    candidates.push(candidate("extract_existing_mcp_tools", "extraction", "Extract existing MCP tools from code, manifests, and JSON-RPC handlers.", e));
  }
  if (["blueprint", "worker", "wrangler", "d1", "r2"].some((t) => raw.includes(t))) {
    candidates.push(candidate("generate_mcp_blueprint_candidates", "build", "Generate build-factory-compatible MCP blueprint candidates.", e));
  }
  if (["admin", "status", "health", "deployment", "run"].some((t) => raw.includes(t))) {
    candidates.push(candidate("inspect_source_operational_surfaces", "admin", "Inspect admin, status, deployment, and operational surfaces.", e));
  }

  return {
    ok: true,
    source: args.source,
    summary: {
      evidence_count: e.length,
      candidate_count: candidates.length,
      existing_mcp_tool_count: existing(args.source).length
    },
    evidence: e,
    existing_mcp_tools_detected: existing(args.source),
    recommended_tools: candidates.slice(0, args.options?.max_candidates ?? 12)
  };
}

function candidate(name: string, category: string, description: string, e: Evidence[]) {
  return {
    name,
    description,
    category,
    priority: e.length > 6 ? "high" : e.length > 3 ? "medium" : "low",
    confidence: Math.min(0.95, 0.45 + e.length * 0.05),
    why_useful: "Candidate is backed by source evidence and maps to a repeatable MCP capability.",
    input_schema: { type: "object", properties: { source: { type: "object" }, limit: { type: "number", default: 25 } } },
    bindings_needed: [{ type: "github", binding: "GITHUB_TOKEN", reason: "May be needed for repo/source expansion.", required: false }],
    handler_plan: { type: category === "build" ? "factory_blueprint" : "custom", steps: ["Validate input.", "Collect evidence.", "Return strict JSON with confidence."] },
    evidence: e.slice(0, 8),
    tags: [category],
    effort: category === "build" ? "medium" : "small",
    safety_risk: "low"
  };
}

function existing(source: Source) {
  const raw = `${source.name}\n${source.content ?? ""}`;
  const names = Array.from(raw.matchAll(/(?:server\.tool|registerTool)\(\s*["']([a-zA-Z0-9_.-]+)["']/g)).map((m) => m[1]);
  return Array.from(new Set(names)).map((name) => ({ name, confidence: 0.8, evidence: [{ kind: "mcp_tool", value: name, reason: "Detected existing tool registration.", confidence: 0.8 }] }));
}

function blueprints(args: { source: Source; candidates?: any[]; project_name?: string; namespace?: string }) {
  const parsed = args.candidates?.length ? { recommended_tools: args.candidates, evidence: evidence(args.source) } : parse({ source: args.source });
  const project = args.project_name ?? `${args.source.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-tools-mcp`;
  return [{
    metadata: { project_name: project, version: "0.1.0", namespace: args.namespace ?? "com.agentfeedoptimization", description: `Generated from ${args.source.type}:${args.source.name}` },
    options: { auto_status_tool: true, compatibility_date: "2024-11-01", execution_logging: true, r2_payload_offload: false, vector_embedding: false, write_receipt: true },
    bindings: { d1_databases: [], secrets: [{ name: "GITHUB_TOKEN", description: "Optional GitHub source expansion token.", required: false }] },
    tools: parsed.recommended_tools
  }];
}

function score(args: { candidates: any[]; existing_tool_names?: string[] }) {
  const existingNames = new Set((args.existing_tool_names ?? []).map((x) => x.toLowerCase()));
  return args.candidates.map((c) => {
    const dup = existingNames.has(c.name.toLowerCase());
    const total = Math.max(0, Math.min(1, (c.confidence ?? 0.5) - (dup ? 0.25 : 0)));
    return { ...c, scores: { total, duplication_penalty: dup ? 0.25 : 0 }, recommended_action: dup ? "merge_with_existing" : total > 0.62 ? "build" : "defer" };
  }).sort((a, b) => b.scores.total - a.scores.total);
}

function compare(args: { candidates: any[]; existing_tools?: Array<{ name?: string }> }) {
  const existingTools = args.existing_tools ?? [];
  const overlaps = args.candidates.filter((c) => existingTools.some((t) => (t.name ?? "").toLowerCase() === c.name.toLowerCase()));
  const gaps = args.candidates.filter((c) => !overlaps.includes(c));
  return { ok: true, counts: { candidates: args.candidates.length, existing_tools: existingTools.length, overlaps: overlaps.length, gaps: gaps.length }, overlaps, gaps };
}

function plan(args: { candidates: any[]; mode?: string }) {
  const selected = score({ candidates: args.candidates }).filter((c) => c.recommended_action === "build").slice(0, args.mode === "full" ? 10 : 3);
  return {
    ok: true,
    selected_tools: selected.map((c) => c.name),
    phases: [
      { phase: 1, name: "Evidence lock", steps: ["Attach candidates to source evidence.", "Create a tool-opportunity-report stone."] },
      { phase: 2, name: "Schema hardening", steps: selected.map((c) => `Finalize input_schema for ${c.name}.`) },
      { phase: 3, name: "Blueprint compile dry-run", steps: ["Generate blueprint candidate.", "Call compile_blueprint."] },
      { phase: 4, name: "Stamp and index", steps: ["Stamp approved worker.", "Stone generated files.", "Index in Toolsmith."] }
    ],
    scored_candidates: selected
  };
}

export function listTools() {
  return toolNames.map((name) => ({ name, description: descriptions[name], inputSchema: schema }));
}

export function callTool(name: string, args: any) {
  const table: Record<string, () => unknown> = {
    parse_source_for_tool_opportunities: () => parse(args),
    extract_existing_mcp_tools: () => ({ ok: true, tools: existing(args.source) }),
    generate_blueprint_candidates: () => ({ ok: true, blueprints: blueprints(args) }),
    score_tool_candidates: () => ({ ok: true, candidates: score(args) }),
    compare_against_toolsmith_inventory: () => compare(args),
    create_build_plan: () => plan(args)
  };
  const result = table[name]?.();
  if (!result) throw new Error(`Unknown tool: ${name}`);
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type, authorization" } });
}

async function rpc(request: Request) {
  const payload: any = await request.json();
  const id = payload.id ?? null;
  try {
    if (payload.method === "initialize") return json({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "cairnstone-tool-miner-mcp", version: "0.1.0" } } });
    if (payload.method === "tools/list") return json({ jsonrpc: "2.0", id, result: { tools: listTools() } });
    if (payload.method === "tools/call") return json({ jsonrpc: "2.0", id, result: callTool(payload.params?.name, payload.params?.arguments ?? {}) });
    return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown method" } }, 404);
  } catch (error) {
    return json({ jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : "Tool execution failed" } }, 400);
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({});
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "cairnstone-tool-miner-mcp", tools: toolNames });
    if (request.method === "GET" && url.pathname === "/") return json({ ok: true, name: "cairnstone-tool-miner-mcp", endpoints: ["/health", "/mcp"], tools: toolNames });
    if (request.method === "POST" && url.pathname === "/mcp") return rpc(request);
    return json({ ok: false, error: "not_found" }, 404);
  }
};
