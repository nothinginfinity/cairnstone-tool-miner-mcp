type Source = { type: string; name: string; content?: string; metadata?: Record<string, unknown> };
type Evidence = { kind: string; value: string; reason: string; confidence: number };
type Candidate = Record<string, any>;
type Env = {
  MCP_SERVER_NAME?: string;
  CAIRNSTONE_API_URL?: string;
  CAIRNSTONE_MCP_URL?: string;
  CAIRNSTONE_V5?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
};
type CairnstoneNode = { hash?: string; title?: string; is_head?: boolean; lod5?: string; lod4?: string; path?: string; repo?: string; chain?: string };
type CairnstoneManifest = { ok?: boolean; chain?: string; head_hash?: string | null; head_updated_at?: string | null; stone_count?: number; nodes?: CairnstoneNode[]; edges?: unknown[]; fallback?: unknown };

const DEFAULT_CAIRNSTONE_API_URL = "https://cairnstone-v5.jaredtechfit.workers.dev";
const DEFAULT_NAMESPACE = "com.agentfeedoptimization";
const DEFAULT_COMPATIBILITY_DATE = "2024-11-01";

const toolNames = [
  "parse_source_for_tool_opportunities",
  "extract_existing_mcp_tools",
  "generate_blueprint_candidates",
  "generate_no_auth_dev_mcp_app",
  "score_tool_candidates",
  "compare_against_toolsmith_inventory",
  "create_build_plan",
  "mine_cairnstone_chain"
];

const descriptions: Record<string, string> = {
  parse_source_for_tool_opportunities: "Parse source text/metadata into evidence-backed MCP candidates.",
  extract_existing_mcp_tools: "Detect existing MCP or JSON-RPC tools already present in source.",
  generate_blueprint_candidates: "Convert parsed candidates into build-factory-style blueprint candidates.",
  generate_no_auth_dev_mcp_app: "Generate a complete no-auth developer Cloudflare Worker MCP app contract from mined candidates.",
  score_tool_candidates: "Rank candidates by utility, evidence, effort, safety, and duplication risk.",
  compare_against_toolsmith_inventory: "Compare recommendations against known Toolsmith tools.",
  create_build_plan: "Produce an ordered build plan for selected candidates.",
  mine_cairnstone_chain: "Read a CairnStone chain through the CairnStone V5 service binding, mine HEAD/LOD/query-expanded context, and return tool recommendations."
};

const sourceSchema = {
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
    },
    candidates: { type: "array", items: { type: "object" } },
    existing_tools: { type: "array", items: { type: "object" } },
    existing_tool_names: { type: "array", items: { type: "string" } },
    project_name: { type: "string" },
    namespace: { type: "string" },
    worker_slug: { type: "string" },
    owner: { type: "string" },
    repo: { type: "string" },
    base_path: { type: "string" },
    mode: { type: "string", enum: ["minimal", "full"] }
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
    cairnstone_api_url: { type: "string", description: "Optional fallback override when no CAIRNSTONE_V5 service binding is present." },
    cairnstone_mcp_url: { type: "string", description: "Optional fallback override when no CAIRNSTONE_V5 service binding is present." }
  }
};

function slugify(value: string, fallback = "generated-tool") {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug || fallback;
}

function displayName(value: string) {
  return value.split(/[_-]+/g).map((part) => part ? `${part.charAt(0).toUpperCase()}${part.slice(1)}` : part).join(" ");
}

function sourceText(source: Source) {
  return `${source.name}\n${source.content ?? ""}\n${JSON.stringify(source.metadata ?? {})}`.toLowerCase();
}

function evidence(source: Source): Evidence[] {
  const raw = sourceText(source);
  const terms = ["stone", "chain", "head", "ref", "repo", "tool", "connector", "blueprint", "worker", "d1", "r2", "admin", "status", "receipt", "workflow", "jsonrpc", "tools/list", "tools/call", "inputschema", "auth", "no-auth", "developer", "wrangler", "mcp", "article", "provenance", "permission"];
  const out: Evidence[] = [];
  for (const term of terms) {
    if (!raw.includes(term)) continue;
    out.push({
      kind: ["stone", "chain", "head", "ref"].includes(term) ? "cairnstone" : term.includes("tool") || term.includes("jsonrpc") || term === "mcp" ? "mcp_tool" : "keyword",
      value: term,
      reason: `Detected ${term} signal in source.`,
      confidence: term.includes("tool") || term.includes("jsonrpc") || term === "mcp" ? 0.82 : 0.58
    });
  }
  for (const match of raw.matchAll(/(?:get|post|put|patch|delete)\s+(\/[a-z0-9_./:{}-]+)/g)) {
    out.push({ kind: "route", value: match[1] ?? "", reason: "Detected route-like API surface.", confidence: 0.7 });
  }
  return out;
}

function candidate(name: string, category: string, description: string, sourceEvidence: Evidence[], overrides: Candidate = {}): Candidate {
  const safeName = slugify(name).replace(/-/g, "_");
  return {
    name: safeName,
    display_name: displayName(name),
    description,
    category,
    priority: sourceEvidence.length > 8 ? "high" : sourceEvidence.length > 3 ? "medium" : "low",
    confidence: Math.min(0.95, 0.45 + sourceEvidence.length * 0.05),
    why_useful: "Candidate is backed by source evidence and maps to a repeatable MCP capability.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        source: { type: "object", description: "Source object, chain summary, repo artifact, or structured payload." },
        limit: { type: "number", default: 25 }
      }
    },
    output_schema: { type: "object", properties: { ok: { type: "boolean" }, result: { type: "object" }, evidence: { type: "array", items: { type: "object" } } } },
    bindings_needed: [{ type: "secret_text", binding: "GITHUB_TOKEN", reason: "Optional GitHub source expansion token.", required: false }],
    routes: [{ method: "POST", path: "/mcp", purpose: "JSON-RPC tools/call dispatch." }],
    handler_plan: { type: category === "build" ? "factory_blueprint" : "custom", steps: ["Validate JSON input against input_schema.", "Collect source evidence and provenance.", "Return strict JSON with ok/result/evidence.", "Emit a compact receipt when execution_logging is enabled."] },
    evidence: sourceEvidence.slice(0, 8),
    tags: [category, "no_auth_dev_mcp", "cloudflare_worker"],
    effort: category === "build" ? "medium" : "small",
    safety_risk: "low",
    auth: { mode: "none", intended_surface: "developer_app", note: "No end-user auth. Use optional secrets only for upstream service calls." },
    ...overrides
  };
}

function existing(source: Source) {
  const raw = `${source.name}\n${source.content ?? ""}`;
  const patterns = [/(?:server\.tool|registerTool)\(\s*["']([a-zA-Z0-9_.-]+)["']/g, /name\s*:\s*["']([a-zA-Z0-9_.-]+)["']\s*,\s*description\s*:/g, /tools\/call[\s\S]{0,240}name["']?\s*[:=]\s*["']([a-zA-Z0-9_.-]+)["']/g];
  const names = patterns.flatMap((pattern) => Array.from(raw.matchAll(pattern)).map((match) => match[1]).filter((name): name is string => Boolean(name)));
  return Array.from(new Set(names)).map((name) => ({ name, confidence: 0.8, evidence: [{ kind: "mcp_tool", value: name, reason: "Detected existing tool registration.", confidence: 0.8 }] }));
}

function parse(args: { source: Source; options?: { max_candidates?: number } }) {
  if (!args?.source?.name || !args?.source?.type) throw new Error("source.type and source.name are required.");
  const e = evidence(args.source);
  const raw = sourceText(args.source);
  const candidates: Candidate[] = [];
  if (["stone", "chain", "head", "ref"].some((term) => raw.includes(term))) candidates.push(candidate("parse_cairnstone_chain_for_tools", "analysis", "Parse a CairnStone chain manifest and HEAD refs into MCP tool opportunities.", e));
  if (["mcp", "tools/list", "tools/call", "inputschema", "jsonrpc"].some((term) => raw.includes(term))) candidates.push(candidate("extract_existing_mcp_tools", "extraction", "Extract existing MCP tools from code, manifests, and JSON-RPC handlers.", e));
  if (["blueprint", "worker", "wrangler", "d1", "r2"].some((term) => raw.includes(term))) candidates.push(candidate("generate_mcp_blueprint_candidates", "build", "Generate build-factory-compatible MCP blueprint candidates.", e));
  if (["admin", "status", "health", "deployment", "run"].some((term) => raw.includes(term))) candidates.push(candidate("inspect_source_operational_surfaces", "admin", "Inspect admin, status, deployment, and operational surfaces.", e));
  if (["article", "url", "source", "provenance", "copyright", "permission"].some((term) => raw.includes(term))) {
    candidates.push(candidate("article_url_to_safe_mini_repo", "ingestion", "Create a copyright-safe article mini-repo with source metadata, provenance, derived notes, candidates, and build plan.", e, {
      input_schema: { type: "object", additionalProperties: false, required: ["url", "repo", "base_path"], properties: { url: { type: "string" }, owner: { type: "string" }, repo: { type: "string" }, branch: { type: "string", default: "main" }, base_path: { type: "string" }, allow_full_text: { type: "boolean", default: false } } }
    }));
  }
  return { ok: true, source: args.source, summary: { evidence_count: e.length, candidate_count: candidates.length, existing_mcp_tool_count: existing(args.source).length }, evidence: e, existing_mcp_tools_detected: existing(args.source), recommended_tools: candidates.slice(0, args.options?.max_candidates ?? 12) };
}

function ensureCandidates(args: { source?: Source; candidates?: Candidate[] }) {
  if (Array.isArray(args.candidates) && args.candidates.length) return args.candidates;
  if (!args.source) throw new Error("Provide either candidates or source.");
  return parse({ source: args.source }).recommended_tools;
}

function noAuthAppContract(args: { source: Source; candidates?: Candidate[]; project_name?: string; namespace?: string; worker_slug?: string; owner?: string; repo?: string; base_path?: string; mode?: string }) {
  const candidates = ensureCandidates(args);
  const project = slugify(args.project_name ?? `${args.source.name}-tools-mcp`);
  const workerSlug = slugify(args.worker_slug ?? project);
  const basePath = args.base_path ?? `apps/${workerSlug}`;
  const namespace = args.namespace ?? DEFAULT_NAMESPACE;
  const tools = candidates.map((item) => ({ name: item.name, description: item.description, inputSchema: item.input_schema, outputSchema: item.output_schema, handlerPlan: item.handler_plan, auth: item.auth, bindings_needed: item.bindings_needed }));
  return {
    ok: true,
    app: {
      format: "afo.no_auth.developer_mcp_app.v1",
      project_name: project,
      worker_slug: workerSlug,
      namespace,
      source: { type: args.source.type, name: args.source.name, metadata: args.source.metadata ?? {} },
      target_repo: args.owner && args.repo ? `${args.owner}/${args.repo}` : undefined,
      base_path: basePath,
      auth: { mode: "none", public_dev_app: true, require_user_login: false, require_bearer_token: false },
      runtime: { platform: "cloudflare_workers", module_format: "esm", compatibility_date: DEFAULT_COMPATIBILITY_DATE },
      endpoints: [{ method: "GET", path: "/", purpose: "Human and machine-readable service card." }, { method: "GET", path: "/health", purpose: "No-auth liveness and tool inventory." }, { method: "POST", path: "/mcp", purpose: "JSON-RPC initialize, tools/list, and tools/call." }],
      mcp: { protocol_versions: ["2024-11-05", "2025-03-26"], methods: ["initialize", "tools/list", "tools/call"], tools },
      files: [{ path: `${basePath}/src/index.ts`, role: "worker_mcp_entrypoint", generated: true }, { path: `${basePath}/package.json`, role: "npm_scripts_and_dev_dependencies", generated: true }, { path: `${basePath}/wrangler.toml`, role: "worker_deploy_config", generated: true }, { path: `${basePath}/README.md`, role: "developer_usage_docs", generated: true }, { path: `${basePath}/tests/schema.test.ts`, role: "schema_and_contract_tests", generated: true }],
      wrangler: { name: workerSlug, main: "src/index.ts", compatibility_date: DEFAULT_COMPATIBILITY_DATE, workers_dev: true, vars: { MCP_SERVER_NAME: workerSlug, AFO_APP_KIND: "no_auth_developer_mcp" }, services: [{ binding: "CAIRNSTONE_V5", service: "cairnstone-v5" }], secrets: Array.from(new Set(tools.flatMap((tool) => tool.bindings_needed.filter((binding: any) => binding.required !== false && binding.type === "secret_text").map((binding: any) => String(binding.binding))))) },
      toolsmith: { registry_kind: "generated_no_auth_dev_mcp_app", dedupe_key: `${namespace}/${workerSlug}`, receipt_required: true, cairnstone_source_required: true },
      receipts: { build_receipt_path: `${basePath}/receipts/build.json`, source_receipt_path: `${basePath}/receipts/source.json`, no_auth_reason: "Developer MCP/app intended for public no-auth tool calls; upstream secrets remain Worker bindings." }
    }
  };
}

function blueprints(args: { source: Source; candidates?: Candidate[]; project_name?: string; namespace?: string; worker_slug?: string }) {
  const app = noAuthAppContract(args).app;
  return [{ metadata: { project_name: app.project_name, version: "0.3.0", namespace: app.namespace, description: `Generated no-auth developer MCP app from ${args.source.type}:${args.source.name}` }, options: { auto_status_tool: true, compatibility_date: DEFAULT_COMPATIBILITY_DATE, execution_logging: true, r2_payload_offload: false, vector_embedding: false, write_receipt: true, no_auth_dev_app: true }, auth: app.auth, endpoints: app.endpoints, mcp: app.mcp, files: app.files, wrangler: app.wrangler, bindings: { services: [{ binding: "CAIRNSTONE_V5", service: "cairnstone-v5", required: false }], d1_databases: [], secrets: [{ name: "GITHUB_TOKEN", description: "Optional GitHub source expansion token.", required: false }] }, tools: app.mcp.tools }];
}

function score(args: { source?: Source; candidates?: Candidate[]; existing_tool_names?: string[] }) {
  const candidates = ensureCandidates(args);
  const existingNames = new Set((args.existing_tool_names ?? []).map((name) => name.toLowerCase()));
  return candidates.map((item) => {
    const duplicate = existingNames.has(String(item.name).toLowerCase());
    const schemaBonus = item.input_schema ? 0.08 : 0;
    const authBonus = item.auth?.mode === "none" ? 0.04 : 0;
    const total = Math.max(0, Math.min(1, (item.confidence ?? 0.5) + schemaBonus + authBonus - (duplicate ? 0.25 : 0)));
    return { ...item, scores: { total, schema_bonus: schemaBonus, no_auth_fit_bonus: authBonus, duplication_penalty: duplicate ? 0.25 : 0 }, recommended_action: duplicate ? "merge_with_existing" : total > 0.62 ? "build" : "defer" };
  }).sort((left, right) => right.scores.total - left.scores.total);
}

function compare(args: { source?: Source; candidates?: Candidate[]; existing_tools?: Array<{ name?: string }> }) {
  const candidates = ensureCandidates(args);
  const existingTools = args.existing_tools ?? [];
  const overlaps = candidates.filter((item) => existingTools.some((tool) => (tool.name ?? "").toLowerCase() === String(item.name).toLowerCase()));
  const overlapNames = new Set(overlaps.map((item) => item.name));
  const gaps = candidates.filter((item) => !overlapNames.has(item.name));
  return { ok: true, counts: { candidates: candidates.length, existing_tools: existingTools.length, overlaps: overlaps.length, gaps: gaps.length }, overlaps, gaps };
}


  const raw = args.cairnstone_api_url ?? args.cairnstone_mcp_url ?? env?.CAIRNSTONE_API_URL ?? env?.CAIRNSTONE_MCP_URL ?? DEFAULT_CAIRNSTONE_API_URL;
  return String(raw).replace(/\/mcp\/?$/, "").replace(/\/+$/, "");
}

function mcpUrl(base: string) { return `${base}/mcp`; }
function serviceUrl(path: string) { return `https://cairnstone-v5${path.startsWith("/") ? path : `/${path}`}`; }

async function fetchCairnstone(env: Env | undefined, base: string, path: string, init: RequestInit) {
  if (env?.CAIRNSTONE_V5) {
    const request = new Request(serviceUrl(path), init);
    const response = await env.CAIRNSTONE_V5.fetch(request);
    return { response, via: "service_binding:CAIRNSTONE_V5" };
  }
  const response = await fetch(`${base}${path}`, init);
  return { response, via: "http_fallback" };
}

async function readJsonResponse(response: Response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { ok: false, text }; }
}

async function getJson(base: string, path: string, env?: Env) {
  const { response, via } = await fetchCairnstone(env, base, path, { method: "GET", headers: { accept: "application/json" } });
  const payload: any = await readJsonResponse(response);
  if (!response.ok) throw new Error(`CairnStone GET ${path} via ${via} failed with HTTP ${response.status}`);
  return payload;
}

async function postJson(base: string, path: string, body: Record<string, unknown>, env?: Env) {
  const { response, via } = await fetchCairnstone(env, base, path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const payload: any = await readJsonResponse(response);
  if (!response.ok) throw new Error(`CairnStone POST ${path} via ${via} failed with HTTP ${response.status}`);
  return payload;
}

function decodeJsonText(value: any): any {
  if (value?.structuredContent) return value.structuredContent;
  if (typeof value?.text === "string") { try { return JSON.parse(value.text); } catch { return value; } }
  const text = value?.content?.find?.((item: any) => item?.type === "text")?.text;
  if (typeof text === "string") { try { return JSON.parse(text); } catch { return { ok: true, text }; } }
  return value;
}

function normalizeStoneList(payload: any, chain: string): CairnstoneNode[] {
  const unwrapped = decodeJsonText(payload);
  const raw = Array.isArray(unwrapped?.stones) ? unwrapped.stones : Array.isArray(unwrapped?.data?.stones) ? unwrapped.data.stones : Array.isArray(unwrapped) ? unwrapped : [];
  return raw.filter((stone: CairnstoneNode) => !stone.chain || stone.chain === chain);
}

async function cairnstoneTool(base: string, name: string, args: Record<string, unknown>, env?: Env) {
  const body = { jsonrpc: "2.0", id: `${name}-${Date.now()}`, method: "tools/call", params: { name, arguments: args } };
  const { response, via } = await fetchCairnstone(env, base, "/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload: any = await readJsonResponse(response);
  if (!response.ok || payload?.error) throw new Error(payload?.error?.message ?? `CairnStone ${name} via ${via} failed with HTTP ${response.status}`);
  const decoded = decodeJsonText(payload.result);
  return decoded && typeof decoded === "object" ? { ...decoded, bridge_source: via } : decoded;
}

async function cairnstoneManifest(base: string, chain: string, env?: Env): Promise<CairnstoneManifest> {
  try { return await cairnstoneTool(base, "cairnstone_get_chain_manifest", { chain }, env) as CairnstoneManifest; }
  catch (mcpError) {
    try { return await getJson(base, `/chains/${encodeURIComponent(chain)}/manifest`, env) as CairnstoneManifest; }
    catch (manifestRestError) {
      const listPayload = await getJson(base, `/v1/stones?chain=${encodeURIComponent(chain)}&limit=200`, env);
      const nodes = normalizeStoneList(listPayload, chain);
      const head = nodes.find((node) => node.is_head) ?? nodes[0];
      return { ok: true, chain, head_hash: head?.hash ?? null, head_updated_at: null, stone_count: nodes.length, nodes, edges: [], fallback: { used: "rest_list_stones", mcp_error: mcpError instanceof Error ? mcpError.message : String(mcpError), manifest_rest_error: manifestRestError instanceof Error ? manifestRestError.message : String(manifestRestError) } };
    }
  }
}

async function cairnstoneLod(base: string, hash: string, level: "lod4" | "lod5", env?: Env) {
  try { return await cairnstoneTool(base, "cairnstone_get_lod", { hash, level }, env); }
  catch (mcpError) {
    try { return await getJson(base, `/v1/stones/${encodeURIComponent(hash)}/lod/${level}`, env); }
    catch (restError) { return { ok: false, mcp_error: mcpError instanceof Error ? mcpError.message : String(mcpError), rest_error: restError instanceof Error ? restError.message : String(restError) }; }
  }
}

async function cairnstoneQueryExpand(base: string, hash: string, query: string, topK: number, contextLines: number, env?: Env) {
  const body = { stone_hash: hash, query, top_k: topK, context_lines: contextLines, include_metadata: true };
  try { return await cairnstoneTool(base, "cairnstone_query_and_expand", body, env); }
  catch (mcpError) {
    try { return await postJson(base, "/v1/query-expand", body, env); }
    catch (restError) { return { ok: false, mcp_error: mcpError instanceof Error ? mcpError.message : String(mcpError), rest_error: restError instanceof Error ? restError.message : String(restError) }; }
  }
}

function nodeSummary(node: CairnstoneNode) { return [`hash=${node.hash ?? ""}`, `head=${node.is_head === true}`, `title=${node.title ?? ""}`, `lod5=${node.lod5 ?? ""}`].join(" | "); }

async function mineChain(args: { chain: string; query?: string; max_stones?: number; top_k?: number; context_lines?: number; cairnstone_api_url?: string; cairnstone_mcp_url?: string }, env?: Env) {
  if (!args.chain) throw new Error("mine_cairnstone_chain requires a chain name.");
  const base = normalizeCairnstoneBase(args, env);
  const maxStones = Math.max(1, Math.min(50, args.max_stones ?? 12));
  const topK = Math.max(1, Math.min(10, args.top_k ?? 5));
  const contextLines = Math.max(0, Math.min(200, args.context_lines ?? 40));
  const query = args.query ?? "mcp tool tools/list tools/call endpoint route schema blueprint worker cairnstone chain head ref bindings deploy status admin no-auth developer app";
  const manifest = await cairnstoneManifest(base, args.chain, env);
  const nodes = manifest.nodes ?? [];
  const headHash = manifest.head_hash ?? nodes.find((node) => node.is_head)?.hash ?? nodes[0]?.hash;
  if (!headHash) throw new Error(`No HEAD or stones found for chain: ${args.chain}`);
  const selectedNodes = [...nodes.filter((node) => node.hash === headHash), ...nodes.filter((node) => node.hash !== headHash)].slice(0, maxStones);
  const [headLod5, headLod4, queryExpand] = await Promise.all([cairnstoneLod(base, headHash, "lod5", env), cairnstoneLod(base, headHash, "lod4", env), cairnstoneQueryExpand(base, headHash, query, topK, contextLines, env)]);
  const content = [`CHAIN ${args.chain}`, `HEAD ${headHash}`, `HEAD_UPDATED_AT ${manifest.head_updated_at ?? ""}`, `STONE_COUNT ${manifest.stone_count ?? nodes.length}`, "", "LOD_SUMMARIES", ...selectedNodes.map(nodeSummary), "", "HEAD_LOD5", JSON.stringify(headLod5), "", "HEAD_LOD4", JSON.stringify(headLod4), "", "QUERY_EXPAND", JSON.stringify(queryExpand), "", "GRAPH_EDGES", JSON.stringify(manifest.edges ?? [])].join("\n");
  const minedSource: Source = { type: "cairnstone_chain", name: args.chain, content, metadata: { chain: args.chain, head_hash: headHash, node_count: nodes.length, selected_node_count: selectedNodes.length, cairnstone_api_url: base, bridge_source: manifest.fallback ? "fallback" : (manifest as any).bridge_source ?? (env?.CAIRNSTONE_V5 ? "service_binding:CAIRNSTONE_V5" : "http_fallback"), query } };
  const parsed = parse({ source: minedSource });
  return { ...parsed, blueprints: blueprints({ source: minedSource, candidates: parsed.recommended_tools }), no_auth_app: noAuthAppContract({ source: minedSource, candidates: parsed.recommended_tools }).app, chain: args.chain, cairnstone: { api_url: base, mcp_url: mcpUrl(base), bridge_source: minedSource.metadata?.bridge_source, service_binding_configured: Boolean(env?.CAIRNSTONE_V5), head_hash: headHash, node_count: nodes.length, selected_node_count: selectedNodes.length }, mining_steps: ["get_chain_manifest", "resolve_HEAD", "collect_LOD_summaries", "query_expand_HEAD", "parse_source_for_tool_opportunities", "generate_no_auth_dev_mcp_app"], manifest_summary: { head_hash: manifest.head_hash, head_updated_at: manifest.head_updated_at, stone_count: manifest.stone_count, edges_count: Array.isArray(manifest.edges) ? manifest.edges.length : 0 }, head_lod5: headLod5, head_lod4: headLod4, query_expand: queryExpand, source_summary: minedSource };
}

export function listTools() {
  return toolNames.map((name) => ({ name, description: descriptions[name], inputSchema: name === "mine_cairnstone_chain" ? mineChainSchema : sourceSchema }));
}

export function callTool(name: string, args: any) {
  const env = (arguments.length > 2 ? arguments[2] : undefined) as Env | undefined;
  const table: Record<string, () => unknown | Promise<unknown>> = {
    parse_source_for_tool_opportunities: () => parse(args),
    extract_existing_mcp_tools: () => ({ ok: true, tools: existing(args.source) }),
    generate_blueprint_candidates: () => ({ ok: true, blueprints: blueprints(args) }),
    generate_no_auth_dev_mcp_app: () => noAuthAppContract(args),
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

async function rpc(request: Request, env?: Env) {
  const payload: any = await request.json();
  const id = payload.id ?? null;
  try {
    if (payload.method === "initialize") return json({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "cairnstone-tool-miner-mcp", version: "0.3.0" } } });
    if (payload.method === "tools/list") return json({ jsonrpc: "2.0", id, result: { tools: listTools() } });
    if (payload.method === "tools/call") return json({ jsonrpc: "2.0", id, result: await (callTool as any)(payload.params?.name, payload.params?.arguments ?? {}, env) });
    return json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown method" } }, 404);
  } catch (error) {
    return json({ jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : "Tool execution failed" } }, 400);
  }
}

export default {
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return json({});
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "cairnstone-tool-miner-mcp", version: "0.3.0", auth: { mode: "none", developer_app: true }, tools: toolNames, cairnstone_bridge: { service_binding_configured: Boolean(env.CAIRNSTONE_V5), http_fallback_configured: Boolean(env.CAIRNSTONE_API_URL ?? env.CAIRNSTONE_MCP_URL ?? DEFAULT_CAIRNSTONE_API_URL) } });
    if (request.method === "GET" && url.pathname === "/") return json({ ok: true, name: "cairnstone-tool-miner-mcp", version: "0.3.0", app_kind: "no_auth_developer_mcp", endpoints: ["/health", "/mcp"], tools: toolNames });
    if (request.method === "POST" && url.pathname === "/mcp") return rpc(request, env);
    return json({ ok: false, error: "not_found" }, 404);
  }
};
