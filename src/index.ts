type Source = { type: string; name: string; content?: string; metadata?: Record<string, unknown> };
type Evidence = { kind: string; value: string; reason: string; confidence: number };
type Env = { MCP_SERVER_NAME?: string; CAIRNSTONE_API_URL?: string; CAIRNSTONE_MCP_URL?: string };

type CairnstoneNode = {
  hash?: string;
  short_hash?: string;
  title?: string;
  is_head?: boolean;
  lod5?: string;
  lod4?: string;
  path?: string;
  repo?: string;
  chain?: string;
};

type CairnstoneManifest = {
  ok?: boolean;
  chain?: string;
  head_hash?: string | null;
  head_updated_at?: string | null;
  stone_count?: number;
  nodes?: CairnstoneNode[];
  edges?: unknown[];
  fallback?: unknown;
};

const DEFAULT_CAIRNSTONE_API_URL = "https://cairnstone-v5.jaredtechfit.workers.dev";

const toolNames = [
  "parse_source_for_tool_opportunities",
  "extract_existing_mcp_tools",
  "generate_blueprint_candidates",
  "score_tool_candidates",
  "compare_against_toolsmith_inventory",
  "create_build_plan",
  "mine_cairnstone_chain"
];

const descriptions: Record<string, string> = {
  parse_source_for_tool_opportunities: "Parse source text/metadata into evidence-backed MCP candidates.",
  extract_existing_mcp_tools: "Detect existing MCP or JSON-RPC tools already present in source.",
  generate_blueprint_candidates: "Convert parsed candidates into build-factory-style blueprint candidates.",
  score_tool_candidates: "Rank candidates by utility, evidence, effort, safety, and duplication risk.",
  compare_against_toolsmith_inventory: "Compare recommendations against known Toolsmith tools.",
  create_build_plan: "Produce an ordered build plan for selected candidates.",
  mine_cairnstone_chain: "Read a CairnStone chain through the CairnStone API/MCP, mine HEAD/LOD/query-expanded context, and return tool recommendations."
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

const mineChainSchema = {
  type: "object",
  required: ["chain"],
  properties: {
    chain: { type: "string", description: "CairnStone chain name to mine." },
    query: { type: "string", description: "Optional focused query for query-expand." },
    max_stones: { type: "number", default: 12 },
    top_k: { type: "number", default: 5 },
    context_lines: { type: "number", default: 40 },
    cairnstone_api_url: { type: "string", description: "Optional override for CAIRNSTONE_API_URL." },
    cairnstone_mcp_url: { type: "string", description: "Optional override for CAIRNSTONE_MCP_URL." }
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
      { phase: 4, name: "Stamp and index", steps: ["Stamp approved worker.", "Index in Toolsmith."] }
    ],
    scored_candidates: selected
  };
}

function normalizeCairnstoneBase(args: any, env?: Env) {
  const raw = args?.cairnstone_api_url ?? args?.cairnstone_mcp_url ?? env?.CAIRNSTONE_API_URL ?? env?.CAIRNSTONE_MCP_URL ?? DEFAULT_CAIRNSTONE_API_URL;
  return String(raw).replace(/\/mcp\/?$/, "").replace(/\/+$/, "");
}

function mcpUrl(base: string) {
  return `${base}/mcp`;
}

async function getJson(base: string, path: string) {
  const response = await fetch(`${base}${path}`, { method: "GET", headers: { "accept": "application/json" } });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`CairnStone REST GET ${path} failed with HTTP ${response.status}`);
  return payload;
}

async function postJson(base: string, path: string, body: Record<string, unknown>) {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify(body)
  });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`CairnStone REST POST ${path} failed with HTTP ${response.status}`);
  return payload;
}

function unwrapTextJson(payload: any) {
  if (typeof payload?.text === "string") {
    try {
      return JSON.parse(payload.text);
    } catch {
      return payload;
    }
  }
  return payload;
}

function normalizeStoneList(payload: any, chain: string): CairnstoneNode[] {
  const unwrapped = unwrapTextJson(payload);
  const raw = Array.isArray(unwrapped?.stones) ? unwrapped.stones : Array.isArray(unwrapped?.data?.stones) ? unwrapped.data.stones : Array.isArray(unwrapped) ? unwrapped : [];
  return raw
    .filter((stone: any) => !stone?.chain || stone.chain === chain)
    .map((stone: any) => ({
      hash: stone.hash,
      short_hash: stone.short_hash,
      title: stone.title,
      is_head: stone.is_head === true,
      lod5: stone.lod5,
      lod4: stone.lod4,
      path: stone.path,
      repo: stone.repo,
      chain: stone.chain
    }));
}

async function cairnstoneManifest(base: string, chain: string): Promise<CairnstoneManifest> {
  try {
    return await cairnstoneTool(base, "cairnstone_get_chain_manifest", { chain }) as CairnstoneManifest;
  } catch (mcpError) {
    const listPayload = await getJson(base, `/v1/stones?chain=${encodeURIComponent(chain)}&limit=200`);
    const nodes = normalizeStoneList(listPayload, chain);
    const head = nodes.find((node) => node.is_head) ?? nodes[0];
    return {
      ok: true,
      chain,
      head_hash: head?.hash ?? null,
      head_updated_at: null,
      stone_count: nodes.length,
      nodes,
      edges: [],
      fallback: {
        used: "rest_list_stones",
        mcp_error: mcpError instanceof Error ? mcpError.message : String(mcpError)
      }
    };
  }
}

async function cairnstoneLod(base: string, hash: string, level: "lod4" | "lod5") {
  try {
    return await cairnstoneTool(base, "cairnstone_get_lod", { hash, level });
  } catch (mcpError) {
    try {
      return await getJson(base, `/v1/stones/${encodeURIComponent(hash)}/lod/${level}`);
    } catch (restError) {
      return {
        ok: false,
        mcp_error: mcpError instanceof Error ? mcpError.message : String(mcpError),
        rest_error: restError instanceof Error ? restError.message : String(restError)
      };
    }
  }
}

async function cairnstoneQueryExpand(base: string, hash: string, query: string, topK: number, contextLines: number) {
  const body = { stone_hash: hash, query, top_k: topK, context_lines: contextLines, include_metadata: true };
  try {
    return await cairnstoneTool(base, "cairnstone_query_and_expand", body);
  } catch (mcpError) {
    try {
      return await postJson(base, "/v1/query-expand", body);
    } catch (restError) {
      return {
        ok: false,
        mcp_error: mcpError instanceof Error ? mcpError.message : String(mcpError),
        rest_error: restError instanceof Error ? restError.message : String(restError)
      };
    }
  }
}

function decodeMcpToolResult(result: any) {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.find?.((item: any) => item?.type === "text")?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return { ok: true, text };
    }
  }
  return result;
}

async function cairnstoneTool(base: string, name: string, args: Record<string, unknown>) {
  const response = await fetch(mcpUrl(base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `${name}-${Date.now()}`, method: "tools/call", params: { name, arguments: args } })
  });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    const message = payload?.error?.message ?? `CairnStone ${name} failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return decodeMcpToolResult(payload.result);
}

function nodeSummary(node: CairnstoneNode) {
  return [
    `hash=${node.hash ?? ""}`,
    `head=${node.is_head === true}`,
    `title=${node.title ?? ""}`,
    `lod5=${node.lod5 ?? ""}`
  ].join(" | ");
}

async function mineChain(args: { chain: string; query?: string; max_stones?: number; top_k?: number; context_lines?: number; cairnstone_api_url?: string; cairnstone_mcp_url?: string }, env?: Env) {
  if (!args.chain) throw new Error("mine_cairnstone_chain requires a chain name.");

  const base = normalizeCairnstoneBase(args, env);
  const maxStones = Math.max(1, Math.min(50, args.max_stones ?? 12));
  const topK = Math.max(1, Math.min(10, args.top_k ?? 5));
  const contextLines = Math.max(0, Math.min(200, args.context_lines ?? 40));
  const query = args.query ?? "mcp tool tools/list tools/call endpoint route schema blueprint worker cairnstone chain head ref bindings deploy status admin";

  const manifest = await cairnstoneManifest(base, args.chain);
  const nodes = manifest.nodes ?? [];
  const headHash = manifest.head_hash ?? nodes.find((node) => node.is_head)?.hash ?? nodes[0]?.hash;
  if (!headHash) throw new Error(`No HEAD or stones found for chain: ${args.chain}`);

  const selectedNodes = [
    ...nodes.filter((node) => node.hash === headHash),
    ...nodes.filter((node) => node.hash !== headHash)
  ].slice(0, maxStones);

  const [headLod5, headLod4, queryExpand] = await Promise.all([
    cairnstoneLod(base, headHash, "lod5"),
    cairnstoneLod(base, headHash, "lod4"),
    cairnstoneQueryExpand(base, headHash, query, topK, contextLines)
  ]);

  const content = [
    `CHAIN ${args.chain}`,
    `HEAD ${headHash}`,
    `HEAD_UPDATED_AT ${manifest.head_updated_at ?? ""}`,
    `STONE_COUNT ${manifest.stone_count ?? nodes.length}`,
    "",
    "LOD_SUMMARIES",
    ...selectedNodes.map(nodeSummary),
    "",
    "HEAD_LOD5",
    JSON.stringify(headLod5),
    "",
    "HEAD_LOD4",
    JSON.stringify(headLod4),
    "",
    "QUERY_EXPAND",
    JSON.stringify(queryExpand),
    "",
    "GRAPH_EDGES",
    JSON.stringify(manifest.edges ?? [])
  ].join("\n");

  const minedSource: Source = {
    type: "cairnstone_chain",
    name: args.chain,
    content,
    metadata: {
      chain: args.chain,
      head_hash: headHash,
      node_count: nodes.length,
      selected_node_count: selectedNodes.length,
      cairnstone_api_url: base,
      query
    }
  };

  const parsed = parse({ source: minedSource });

  return {
    ...parsed,
    chain: args.chain,
    cairnstone: {
      api_url: base,
      mcp_url: mcpUrl(base),
      head_hash: headHash,
      node_count: nodes.length,
      selected_node_count: selectedNodes.length
    },
    mining_steps: ["get_chain_manifest", "resolve_HEAD", "collect_LOD_summaries", "query_expand_HEAD", "parse_source_for_tool_opportunities"],
    manifest_summary: {
      head_hash: manifest.head_hash,
      head_updated_at: manifest.head_updated_at,
      stone_count: manifest.stone_count,
      edges_count: Array.isArray(manifest.edges) ? manifest.edges.length : 0
    },
    head_lod5: headLod5,
    head_lod4: headLod4,
    query_expand: queryExpand,
    source_summary: minedSource
  };
}

export function listTools() {
  const schemaForTool = (name: string) => name === "mine_cairnstone_chain" ? mineChainSchema : schema;
  return toolNames.map((name) => ({ name, description: descriptions[name], inputSchema: schemaForTool(name) }));
}

export function callTool(name: string, args: any) {
  const env = (arguments.length > 2 ? arguments[2] : undefined) as Env | undefined;
  const table: Record<string, () => unknown | Promise<unknown>> = {
    parse_source_for_tool_opportunities: () => parse(args),
    extract_existing_mcp_tools: () => ({ ok: true, tools: existing(args.source) }),
    generate_blueprint_candidates: () => ({ ok: true, blueprints: blueprints(args) }),
    score_tool_candidates: () => ({ ok: true, candidates: score(args) }),
    compare_against_toolsmith_inventory: () => compare(args),
    create_build_plan: () => plan(args),
    mine_cairnstone_chain: () => mineChain(args, env)
  };
  const result = table[name]?.();
  if (!result) throw new Error(`Unknown tool: ${name}`);
  return Promise.resolve(result).then((resolved) => ({ content: [{ type: "text", text: JSON.stringify(resolved, null, 2) }], structuredContent: resolved }));
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type, authorization" } });
}

async function rpc(request: Request) {
  const env = (arguments.length > 1 ? arguments[1] : undefined) as Env | undefined;
  const payload: any = await request.json();
  const id = payload.id ?? null;
  try {
    if (payload.method === "initialize") return json({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "cairnstone-tool-miner-mcp", version: "0.1.0" } } });
    if (payload.method === "tools/list") return json({ jsonrpc: "2.0", id, result: { tools: listTools() } });
    if (payload.method === "tools/call") return json({ jsonrpc: "2.0", id, result: await (callTool as any)(payload.params?.name, payload.params?.arguments ?? {}, env) });
    return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown method" } }, 404);
  } catch (error) {
    return json({ jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : "Tool execution failed" } }, 400);
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const env = (arguments.length > 1 ? arguments[1] : {}) as Env;
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({});
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "cairnstone-tool-miner-mcp", tools: toolNames, cairnstone_api_url_configured: Boolean(env?.CAIRNSTONE_API_URL ?? env?.CAIRNSTONE_MCP_URL ?? DEFAULT_CAIRNSTONE_API_URL) });
    if (request.method === "GET" && url.pathname === "/") return json({ ok: true, name: "cairnstone-tool-miner-mcp", endpoints: ["/health", "/mcp"], tools: toolNames });
    if (request.method === "POST" && url.pathname === "/mcp") return (rpc as any)(request, env);
    return json({ ok: false, error: "not_found" }, 404);
  }
};
