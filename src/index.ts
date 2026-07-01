type Source = { type: string; name: string; content?: string; metadata?: Record<string, unknown> };
type Evidence = { kind: string; value: string; reason: string; confidence: number };
type Candidate = Record<string, any>;
type Env = {
  MCP_SERVER_NAME?: string;
  CAIRNSTONE_API_URL?: string;
  CAIRNSTONE_MCP_URL?: string;
  CAIRNSTONE_V5?: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
  AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
};
type CairnstoneNode = { hash?: string; title?: string; is_head?: boolean; lod5?: string; lod4?: string; path?: string; repo?: string; chain?: string };
type CairnstoneManifest = { ok?: boolean; chain?: string; head_hash?: string | null; head_updated_at?: string | null; stone_count?: number; nodes?: CairnstoneNode[]; edges?: unknown[]; bridge_source?: string };
type Classification = { summary: string; intent: string; topics: string[]; capabilities: Array<{ name: string; category?: string; description?: string; reasoning?: string; confidence?: number }>; output_types: OutputTypeRecommendation[] };

const DEFAULT_CAIRNSTONE_API_URL = "https://cairnstone-v5.jaredtechfit.workers.dev";
const DEFAULT_NAMESPACE = "com.agentfeedoptimization";
const DEFAULT_COMPATIBILITY_DATE = "2024-11-01";
const CLASSIFIER_MODEL = "@cf/zai-org/glm-4.7-flash";
const SERVICE_VERSION = "0.8.2";
const OUTPUT_TAXONOMY = ["mcp_tool", "document", "audio_song", "video", "software_app", "game"] as const;
type OutputType = typeof OUTPUT_TAXONOMY[number];
type OutputTypeRecommendation = { type: OutputType; score: number; reasoning: string };

const toolNames = [
  "parse_source_for_tool_opportunities",
  "extract_existing_mcp_tools",
  "generate_blueprint_candidates",
  "generate_no_auth_dev_mcp_app",
  "score_tool_candidates",
  "compare_against_toolsmith_inventory",
  "create_build_plan",
  "mine_cairnstone_chain",
  "recommend_output_type",
  "generate_document_blueprint",
  "generate_document",
  "generate_software_app_blueprint",
  "generate_software_app"
];

const descriptions: Record<string, string> = {
  parse_source_for_tool_opportunities: "Parse source text/metadata into evidence-backed MCP candidates. Uses real LLM content classification (Workers AI) when available; falls back to a keyword scanner only if the AI binding is missing or the call fails.",
  extract_existing_mcp_tools: "Detect existing MCP or JSON-RPC tools already present in source.",
  generate_blueprint_candidates: "Convert parsed candidates into build-factory-style blueprint candidates.",
  generate_no_auth_dev_mcp_app: "Generate a complete no-auth developer Cloudflare Worker MCP app contract from mined candidates.",
  score_tool_candidates: "Rank candidates by utility, evidence, effort, safety, and duplication risk.",
  compare_against_toolsmith_inventory: "Compare recommendations against known Toolsmith tools.",
  create_build_plan: "Produce an ordered build plan for selected candidates.",
  mine_cairnstone_chain: "Read a CairnStone chain through CAIRNSTONE_V5 service binding first, then HTTP fallback, and return tool recommendations.",
  recommend_output_type: "Phase 2 router: score a source against the full output taxonomy (mcp_tool, document, audio_song, video, software_app, game) and return ranked recommendations with reasoning, before any type-specific generator runs.",
  generate_document_blueprint: "Phase 3 document lane, candidate/blueprint step: design a markdown document outline (title, summary, 3-8 sections with per-section purpose) tailored to the source content.",
  generate_document: "Phase 3 document lane, build step: draft a complete markdown document from a source, following a blueprint outline (generated automatically if not provided).",
  generate_software_app_blueprint: "Phase 3 software_app lane, candidate/blueprint step: design a minimal concrete app (name, type, tech stack, 3-6 features, entry file) tailored to the source content. Generalizes the no-auth MCP app pattern beyond MCP-only apps.",
  generate_software_app: "Phase 3 software_app lane, build step: draft the entry file's full contents for an app, following a blueprint (generated automatically if not provided)."
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
    cairnstone_api_url: { type: "string", description: "Fallback override when no service binding is available." },
    cairnstone_mcp_url: { type: "string", description: "Fallback override when no service binding is available." }
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

// --- Phase 1: real content classification (Workers AI), with keyword-bag fallback ---

function classificationPrompt(source: Source) {
  const body = `${source.name}\n\n${(source.content ?? "").slice(0, 6000)}`;
  const system = "You are a precise software-capability analyst and content router. Given arbitrary source content (an article, repo file, API doc, landing page, research paper, recipe, song lyric idea, story pitch, etc.), do two things. First, identify what the content is actually about and propose 1 to 5 concrete, distinct MCP-tool capabilities that would genuinely help someone work with THIS SPECIFIC content as an mcp_tool - every capability must be traceable to something specific in the text, not a generic template. Second, score how well this source content is suited to become each of these six output types, even if some scores are low: mcp_tool (a callable API/tool), document (article/report/guide), audio_song (a song or audio piece), video (a video), software_app (a broader interactive app beyond a single MCP tool), game (a game). A source can legitimately score well on more than one type - do not force a single choice. Respond with ONLY valid JSON, no markdown fences, no prose, matching exactly this shape: {\"summary\": string, \"intent\": string, \"topics\": string[], \"capabilities\": [{\"name\": string, \"category\": \"analysis\"|\"extraction\"|\"build\"|\"admin\"|\"ingestion\", \"description\": string, \"reasoning\": string, \"confidence\": number}], \"output_types\": [{\"type\": \"mcp_tool\"|\"document\"|\"audio_song\"|\"video\"|\"software_app\"|\"game\", \"score\": number, \"reasoning\": string}]}. confidence and score are between 0 and 1. name should be a short snake_case-able phrase. output_types must include all six types, each with its own score and reasoning.";
  return [{ role: "system", content: system }, { role: "user", content: body }];
}

function extractJsonObject(text: string) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON object found in classifier response.");
  return match[0];
}

function sanitizeClassification(parsed: any): Classification {
  if (!parsed || typeof parsed !== "object") throw new Error("Classifier response was not an object.");
  const capabilities = Array.isArray(parsed.capabilities) ? parsed.capabilities : [];
  const cleanCapabilities = capabilities
    .filter((item: any) => item && typeof item.name === "string" && item.name.trim().length > 0)
    .map((item: any) => ({
      name: String(item.name).trim(),
      category: typeof item.category === "string" ? item.category : "analysis",
      description: typeof item.description === "string" ? item.description : "",
      reasoning: typeof item.reasoning === "string" ? item.reasoning : "",
      confidence: typeof item.confidence === "number" ? item.confidence : 0.6
    }));
  if (!cleanCapabilities.length) throw new Error("Classifier returned no usable capabilities.");
  const rawOutputTypes = Array.isArray(parsed.output_types) ? parsed.output_types : [];
  const cleanOutputTypes: OutputTypeRecommendation[] = rawOutputTypes
    .filter((item: any) => item && OUTPUT_TAXONOMY.includes(item.type))
    .map((item: any) => ({
      type: item.type as OutputType,
      score: Math.max(0, Math.min(1, typeof item.score === "number" ? item.score : 0)),
      reasoning: typeof item.reasoning === "string" ? item.reasoning : ""
    }));
  // Fill in any taxonomy members the classifier omitted, at score 0, so callers can always rely on all six being present.
  for (const type of OUTPUT_TAXONOMY) {
    if (!cleanOutputTypes.some((item) => item.type === type)) {
      cleanOutputTypes.push({ type, score: 0, reasoning: "Classifier did not score this output type." });
    }
  }
  return {
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    intent: typeof parsed.intent === "string" ? parsed.intent : "unknown",
    topics: Array.isArray(parsed.topics) ? parsed.topics.filter((item: any) => typeof item === "string").slice(0, 12) : [],
    capabilities: cleanCapabilities,
    output_types: cleanOutputTypes
  };
}

function extractModelText(raw: any): string {
  if (typeof raw === "string") return raw;
  if (typeof raw?.response === "string") return raw.response;
  if (typeof raw?.result?.response === "string") return raw.result.response;
  const message = raw?.choices?.[0]?.message;
  const choiceContent = message?.content;
  if (typeof choiceContent === "string" && choiceContent.trim()) return choiceContent;
  if (Array.isArray(choiceContent)) {
    const joined = choiceContent.map((part: any) => typeof part === "string" ? part : part?.text ?? "").join("");
    if (joined.trim()) return joined;
  }
  const toolArgs = message?.tool_calls?.[0]?.function?.arguments;
  if (typeof toolArgs === "string" && toolArgs.trim()) return toolArgs;
  // Reasoning models (e.g. GLM-4.7-Flash) sometimes exhaust the token budget mid
  // chain-of-thought, leaving content null. The reasoning trace itself may still
  // contain the JSON answer near the end if it got far enough; try it as a last resort.
  if (typeof message?.reasoning === "string" && message.reasoning.trim()) return message.reasoning;
  return "";
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/);
  return match ? (match[1] ?? "").trim() : trimmed;
}

async function classifySource(source: Source, env?: Env): Promise<{ classification: Classification | null; via: string; error?: string }> {
  if (!env?.AI) return { classification: null, via: "no_ai_binding" };
  try {
    const raw: any = await env.AI.run(CLASSIFIER_MODEL, { messages: classificationPrompt(source), max_completion_tokens: 3000, response_format: { type: "json_object" } });
    const text = extractModelText(raw);
    if (!text.trim()) throw new Error(`Empty classifier response. finish_reason=${raw?.choices?.[0]?.finish_reason} reasoning_len=${typeof raw?.choices?.[0]?.message?.reasoning === "string" ? raw.choices[0].message.reasoning.length : "n/a"} Raw shape: ${JSON.stringify(raw).slice(0, 1500)}`);
    const parsed = JSON.parse(extractJsonObject(text));
    const classification = sanitizeClassification(parsed);
    return { classification, via: `workers_ai:${CLASSIFIER_MODEL}` };
  } catch (error) {
    return { classification: null, via: "workers_ai_failed", error: error instanceof Error ? error.message : String(error) };
  }
}

// --- Phase 2: output-type router. The single fork point deciding what kind of output a
// source is best suited to become, before any type-specific generator runs. Reuses Phase 1's
// classification call rather than duplicating classification logic in each lane. ---

function fallbackOutputTypeRecommendations(reason: string): OutputTypeRecommendation[] {
  return OUTPUT_TAXONOMY.map((type) => type === "mcp_tool"
    ? { type, score: 0.4, reasoning: `No semantic classification available (${reason}). Falling back to mcp_tool, the only lane with an existing generator in this repo.` }
    : { type, score: 0, reasoning: `No semantic classification available (${reason}); cannot score this lane without it.` });
}

async function routeOutputType(source: Source, env?: Env) {
  const classified = await classifySource(source, env);
  if (classified.classification) {
    const recs = classified.classification.output_types.length
      ? classified.classification.output_types
      : fallbackOutputTypeRecommendations("classifier omitted output_types");
    const sorted = [...recs].sort((left, right) => right.score - left.score);
    return { ok: true, source, mode: "semantic_classification", via: classified.via, taxonomy: OUTPUT_TAXONOMY, output_type_recommendations: sorted, top_recommendation: sorted[0], multi_fit: sorted.filter((item) => item.score >= 0.5).map((item) => item.type) };
  }
  const sorted = fallbackOutputTypeRecommendations(classified.via);
  return { ok: true, source, mode: "keyword_fallback", via: classified.via, error: classified.error, taxonomy: OUTPUT_TAXONOMY, output_type_recommendations: sorted, top_recommendation: sorted[0], multi_fit: ["mcp_tool"] };
}

// --- Phase 3, lane 1: document generator. Cheapest lane to build (closest to existing
// AFO toolchain doc skills) per ROADMAP.md build order. Mirrors the mcp_tool lane's
// candidate -> blueprint -> build -> verify -> stone cycle: classify (Phase 1/2, already
// built) -> generate_document_blueprint (outline) -> generate_document (full draft). ---

type DocumentSection = { heading: string; purpose: string };
type DocumentBlueprint = { title: string; summary: string; sections: DocumentSection[] };

function documentBlueprintPrompt(source: Source) {
  const body = `${source.name}\n\n${(source.content ?? "").slice(0, 6000)}`;
  const system = "You are a technical editor. Given arbitrary source content, design a document outline that would turn this into a clear, well-organized markdown document (report, guide, or article - whichever genuinely fits this content). Respond with ONLY valid JSON, no markdown fences, no prose, matching exactly this shape: {\"title\": string, \"summary\": string, \"sections\": [{\"heading\": string, \"purpose\": string}]}. Produce 3 to 8 sections. Each section's purpose must be a one-sentence description specific to this source's actual content, not generic boilerplate.";
  return [{ role: "system", content: system }, { role: "user", content: body }];
}

function sanitizeDocumentBlueprint(parsed: any, source: Source): DocumentBlueprint {
  if (!parsed || typeof parsed !== "object") throw new Error("Blueprint response was not an object.");
  const rawSections = Array.isArray(parsed.sections) ? parsed.sections : [];
  const sections: DocumentSection[] = rawSections
    .filter((item: any) => item && typeof item.heading === "string" && item.heading.trim().length > 0)
    .map((item: any) => ({ heading: String(item.heading).trim(), purpose: typeof item.purpose === "string" ? item.purpose : "" }))
    .slice(0, 8);
  if (!sections.length) throw new Error("Blueprint returned no usable sections.");
  return {
    title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : displayName(source.name),
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    sections
  };
}

async function classifyDocumentBlueprint(source: Source, env?: Env): Promise<{ blueprint: DocumentBlueprint | null; via: string; error?: string }> {
  if (!env?.AI) return { blueprint: null, via: "no_ai_binding" };
  try {
    const raw: any = await env.AI.run(CLASSIFIER_MODEL, { messages: documentBlueprintPrompt(source), max_completion_tokens: 2000, response_format: { type: "json_object" } });
    const text = extractModelText(raw);
    if (!text.trim()) throw new Error("Empty blueprint response.");
    const parsed = JSON.parse(extractJsonObject(text));
    const blueprint = sanitizeDocumentBlueprint(parsed, source);
    return { blueprint, via: `workers_ai:${CLASSIFIER_MODEL}` };
  } catch (error) {
    return { blueprint: null, via: "workers_ai_failed", error: error instanceof Error ? error.message : String(error) };
  }
}

function fallbackDocumentBlueprint(source: Source, reason: string): DocumentBlueprint {
  return { title: displayName(source.name), summary: `Fallback blueprint (${reason}); no semantic outline available.`, sections: [{ heading: "Source Material", purpose: "Contains the original source content as provided, unprocessed." }] };
}

async function generateDocumentBlueprint(source: Source, env?: Env) {
  const result = await classifyDocumentBlueprint(source, env);
  const blueprint = result.blueprint ?? fallbackDocumentBlueprint(source, result.via);
  return { ok: true, source, mode: result.blueprint ? "semantic_blueprint" : "keyword_fallback", via: result.via, error: result.error, blueprint };
}

function documentDraftPrompt(source: Source, blueprint: DocumentBlueprint) {
  const outline = blueprint.sections.map((item, index) => `${index + 1}. ${item.heading} - ${item.purpose}`).join("\n");
  const body = `${source.name}\n\n${(source.content ?? "").slice(0, 6000)}`;
  const system = `You are a technical writer. Write a complete markdown document titled "${blueprint.title}" following exactly this outline, in order, using level-2 markdown headings (##) for each section:\n${outline}\nBase the content on the source material below - do not invent facts the source does not support, and do not pad with generic filler. Output only the finished markdown document, no preamble, no commentary about what you are doing.`;
  return [{ role: "system", content: system }, { role: "user", content: body }];
}

async function draftDocumentContent(source: Source, blueprint: DocumentBlueprint, env?: Env): Promise<{ content: string | null; via: string; error?: string }> {
  if (!env?.AI) return { content: null, via: "no_ai_binding" };
  try {
    const raw: any = await env.AI.run(CLASSIFIER_MODEL, { messages: documentDraftPrompt(source, blueprint), max_completion_tokens: 4000 });
    const text = extractModelText(raw);
    if (!text.trim()) throw new Error("Empty document draft response.");
    return { content: stripCodeFence(text), via: `workers_ai:${CLASSIFIER_MODEL}` };
  } catch (error) {
    return { content: null, via: "workers_ai_failed", error: error instanceof Error ? error.message : String(error) };
  }
}

function fallbackDocumentContent(source: Source, blueprint: DocumentBlueprint): string {
  const heading = `# ${blueprint.title}\n\n`;
  const body = blueprint.sections.map((item) => `## ${item.heading}\n\n${item.purpose}\n`).join("\n");
  const raw = `\n\n## Source Material\n\n${source.content ?? "(no content provided)"}\n`;
  return heading + body + raw;
}

async function generateDocument(args: { source: Source; blueprint?: DocumentBlueprint }, env?: Env) {
  const source = args.source;
  const blueprintResult: { blueprint: DocumentBlueprint | null; via: string; error?: string } = args.blueprint
    ? { blueprint: args.blueprint, via: "provided" }
    : await classifyDocumentBlueprint(source, env);
  const blueprint = blueprintResult.blueprint ?? fallbackDocumentBlueprint(source, blueprintResult.via);
  const drafted = await draftDocumentContent(source, blueprint, env);
  const content = drafted.content ?? fallbackDocumentContent(source, blueprint);
  return { ok: true, source, blueprint, document: { title: blueprint.title, format: "markdown", content }, mode: drafted.content ? "semantic_draft" : "keyword_fallback", via: drafted.via };
}

// --- Phase 3, lane 2: software_app generator. Generalizes the existing no-auth MCP app
// contract pattern (noAuthAppContract/blueprints) beyond MCP-only apps - covers broader
// interactive apps (web apps, CLIs, browser extensions, dashboards, static sites) per
// ROADMAP.md's software_app taxonomy member. Mirrors the same candidate -> blueprint ->
// build -> verify -> stone cycle as the document lane. ---

type AppFeature = { name: string; description: string };
type SoftwareAppBlueprint = {
  app_name: string;
  app_type: string;
  summary: string;
  tech_stack: { frontend: string; backend: string; storage: string };
  features: AppFeature[];
  entry_file: { path: string; purpose: string };
};

const SOFTWARE_APP_TYPES = ["web_app", "cli_tool", "browser_extension", "api_service", "dashboard", "static_site", "other"] as const;

function softwareAppBlueprintPrompt(source: Source) {
  const body = `${source.name}\n\n${(source.content ?? "").slice(0, 6000)}`;
  const system = `You are a pragmatic software architect. Given arbitrary source content, design a minimal, concrete software app that would genuinely help someone work with THIS SPECIFIC content - not a generic template. Respond with ONLY valid JSON, no markdown fences, no prose, matching exactly this shape: {"app_name": string, "app_type": "web_app"|"cli_tool"|"browser_extension"|"api_service"|"dashboard"|"static_site"|"other", "summary": string, "tech_stack": {"frontend": string, "backend": string, "storage": string}, "features": [{"name": string, "description": string}], "entry_file": {"path": string, "purpose": string}}. Use "none" for any tech_stack field that does not apply. Produce 3 to 6 features, each traceable to something specific in the source. entry_file should be the single most important file to write first (e.g. index.html for a web_app, main.py for a cli_tool, worker.js for an api_service).`;
  return [{ role: "system", content: system }, { role: "user", content: body }];
}

function sanitizeSoftwareAppBlueprint(parsed: any, source: Source): SoftwareAppBlueprint {
  if (!parsed || typeof parsed !== "object") throw new Error("App blueprint response was not an object.");
  const rawFeatures = Array.isArray(parsed.features) ? parsed.features : [];
  const features: AppFeature[] = rawFeatures
    .filter((item: any) => item && typeof item.name === "string" && item.name.trim().length > 0)
    .map((item: any) => ({ name: String(item.name).trim(), description: typeof item.description === "string" ? item.description : "" }))
    .slice(0, 6);
  if (!features.length) throw new Error("App blueprint returned no usable features.");
  const appType = typeof parsed.app_type === "string" && SOFTWARE_APP_TYPES.includes(parsed.app_type) ? parsed.app_type : "other";
  const stack = parsed.tech_stack ?? {};
  return {
    app_name: typeof parsed.app_name === "string" && parsed.app_name.trim() ? parsed.app_name.trim() : displayName(source.name),
    app_type: appType,
    summary: typeof parsed.summary === "string" ? parsed.summary : "",
    tech_stack: {
      frontend: typeof stack.frontend === "string" ? stack.frontend : "none",
      backend: typeof stack.backend === "string" ? stack.backend : "none",
      storage: typeof stack.storage === "string" ? stack.storage : "none"
    },
    features,
    entry_file: {
      path: typeof parsed.entry_file?.path === "string" && parsed.entry_file.path.trim() ? parsed.entry_file.path.trim() : "index.md",
      purpose: typeof parsed.entry_file?.purpose === "string" ? parsed.entry_file.purpose : "Entry point for the generated app."
    }
  };
}

async function classifySoftwareAppBlueprint(source: Source, env?: Env): Promise<{ blueprint: SoftwareAppBlueprint | null; via: string; error?: string }> {
  if (!env?.AI) return { blueprint: null, via: "no_ai_binding" };
  try {
    const raw: any = await env.AI.run(CLASSIFIER_MODEL, { messages: softwareAppBlueprintPrompt(source), max_completion_tokens: 2500, response_format: { type: "json_object" } });
    const text = extractModelText(raw);
    if (!text.trim()) throw new Error("Empty app blueprint response.");
    const parsed = JSON.parse(extractJsonObject(text));
    const blueprint = sanitizeSoftwareAppBlueprint(parsed, source);
    return { blueprint, via: `workers_ai:${CLASSIFIER_MODEL}` };
  } catch (error) {
    return { blueprint: null, via: "workers_ai_failed", error: error instanceof Error ? error.message : String(error) };
  }
}

function fallbackSoftwareAppBlueprint(source: Source, reason: string): SoftwareAppBlueprint {
  return {
    app_name: displayName(source.name),
    app_type: "other",
    summary: `Fallback blueprint (${reason}); no semantic app design available.`,
    tech_stack: { frontend: "none", backend: "none", storage: "none" },
    features: [{ name: "Source Passthrough", description: "Displays the original source content as provided, unprocessed." }],
    entry_file: { path: "index.md", purpose: "Contains the raw source material with no app logic." }
  };
}

async function generateSoftwareAppBlueprint(source: Source, env?: Env) {
  const result = await classifySoftwareAppBlueprint(source, env);
  const blueprint = result.blueprint ?? fallbackSoftwareAppBlueprint(source, result.via);
  return { ok: true, source, mode: result.blueprint ? "semantic_blueprint" : "keyword_fallback", via: result.via, error: result.error, blueprint };
}

function softwareAppDraftPrompt(source: Source, blueprint: SoftwareAppBlueprint) {
  const features = blueprint.features.map((item, index) => `${index + 1}. ${item.name} - ${item.description}`).join("\n");
  const body = `${source.name}\n\n${(source.content ?? "").slice(0, 6000)}`;
  const system = `You are a software engineer. Write the complete contents of "${blueprint.entry_file.path}" (${blueprint.entry_file.purpose}) for an app called "${blueprint.app_name}" (type: ${blueprint.app_type}, stack: frontend=${blueprint.tech_stack.frontend}, backend=${blueprint.tech_stack.backend}, storage=${blueprint.tech_stack.storage}). It should implement these features, grounded in the source material below - do not invent facts the source does not support:\n${features}\nOutput only the finished file contents, no preamble, no markdown fences, no commentary about what you are doing.`;
  return [{ role: "system", content: system }, { role: "user", content: body }];
}

async function draftSoftwareAppEntryFile(source: Source, blueprint: SoftwareAppBlueprint, env?: Env): Promise<{ content: string | null; via: string; error?: string }> {
  if (!env?.AI) return { content: null, via: "no_ai_binding" };
  try {
    const raw: any = await env.AI.run(CLASSIFIER_MODEL, { messages: softwareAppDraftPrompt(source, blueprint), max_completion_tokens: 8000 });
    const text = extractModelText(raw);
    if (!text.trim()) throw new Error("Empty app draft response.");
    return { content: stripCodeFence(text), via: `workers_ai:${CLASSIFIER_MODEL}` };
  } catch (error) {
    return { content: null, via: "workers_ai_failed", error: error instanceof Error ? error.message : String(error) };
  }
}

function fallbackSoftwareAppEntryFile(source: Source, blueprint: SoftwareAppBlueprint): string {
  const heading = `# ${blueprint.app_name}\n\n${blueprint.summary}\n\n`;
  const featureList = blueprint.features.map((item) => `- **${item.name}**: ${item.description}`).join("\n");
  const raw = `\n\n## Source Material\n\n${source.content ?? "(no content provided)"}\n`;
  return heading + "## Planned Features\n\n" + featureList + "\n" + raw;
}

async function generateSoftwareApp(args: { source: Source; blueprint?: SoftwareAppBlueprint }, env?: Env) {
  const source = args.source;
  const blueprintResult: { blueprint: SoftwareAppBlueprint | null; via: string; error?: string } = args.blueprint
    ? { blueprint: args.blueprint, via: "provided" }
    : await classifySoftwareAppBlueprint(source, env);
  const blueprint = blueprintResult.blueprint ?? fallbackSoftwareAppBlueprint(source, blueprintResult.via);
  const drafted = await draftSoftwareAppEntryFile(source, blueprint, env);
  const content = drafted.content ?? fallbackSoftwareAppEntryFile(source, blueprint);
  return { ok: true, source, blueprint, app: { entry_file: { path: blueprint.entry_file.path, content }, features: blueprint.features }, mode: drafted.content ? "semantic_draft" : "keyword_fallback", via: drafted.via };
}

// --- Legacy keyword-bag evidence + candidates (fallback path only) ---

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
  return {
    name: slugify(name).replace(/-/g, "_"),
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
    handler_plan: { type: category === "build" ? "factory_blueprint" : "custom", steps: ["Validate JSON input against input_schema.", "Collect source evidence and provenance.", "Return strict JSON with ok/result/evidence."] },
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

function maybeArticleIngestionCandidate(raw: string, sourceEvidence: Evidence[], intentHint?: string): Candidate | null {
  const signal = ["article", "url", "provenance", "copyright", "permission"].some((term) => raw.includes(term)) || /article|ingest/i.test(intentHint ?? "");
  if (!signal) return null;
  return candidate("article_url_to_safe_mini_repo", "ingestion", "Create a copyright-safe article mini-repo with source metadata, provenance, derived notes, candidates, and build plan.", sourceEvidence, {
    input_schema: { type: "object", additionalProperties: false, required: ["url", "repo", "base_path"], properties: { url: { type: "string" }, owner: { type: "string" }, repo: { type: "string" }, branch: { type: "string", default: "main" }, base_path: { type: "string" }, allow_full_text: { type: "boolean", default: false } } }
  });
}

function legacyCandidates(source: Source, sourceEvidence: Evidence[]): Candidate[] {
  const raw = sourceText(source);
  const candidates: Candidate[] = [];
  if (["stone", "chain", "head", "ref"].some((term) => raw.includes(term))) candidates.push(candidate("parse_cairnstone_chain_for_tools", "analysis", "Parse a CairnStone chain manifest and HEAD refs into MCP tool opportunities.", sourceEvidence));
  if (["mcp", "tools/list", "tools/call", "inputschema", "jsonrpc"].some((term) => raw.includes(term))) candidates.push(candidate("extract_existing_mcp_tools", "extraction", "Extract existing MCP tools from code, manifests, and JSON-RPC handlers.", sourceEvidence));
  if (["blueprint", "worker", "wrangler", "d1", "r2"].some((term) => raw.includes(term))) candidates.push(candidate("generate_mcp_blueprint_candidates", "build", "Generate build-factory-compatible MCP blueprint candidates.", sourceEvidence));
  if (["admin", "status", "health", "deployment", "run"].some((term) => raw.includes(term))) candidates.push(candidate("inspect_source_operational_surfaces", "admin", "Inspect admin, status, deployment, and operational surfaces.", sourceEvidence));
  const article = maybeArticleIngestionCandidate(raw, sourceEvidence);
  if (article) candidates.push(article);
  return candidates;
}

// --- Classification-driven candidates (primary path) ---

function classifiedCandidates(source: Source, classification: Classification, sourceEvidence: Evidence[], maxCandidates: number): Candidate[] {
  const raw = sourceText(source);
  const fromClassifier = classification.capabilities.slice(0, maxCandidates).map((cap) =>
    candidate(cap.name, cap.category || "analysis", cap.description || cap.reasoning || "Candidate derived from real content classification of the source.", sourceEvidence, {
      why_useful: cap.reasoning || "Candidate is backed by semantic classification of the actual source content, not a keyword template.",
      confidence: Math.max(0.05, Math.min(0.95, cap.confidence ?? 0.6))
    })
  );
  const article = maybeArticleIngestionCandidate(raw, sourceEvidence, classification.intent);
  if (article && !fromClassifier.some((item) => item.name === article.name)) fromClassifier.push(article);
  return fromClassifier;
}

async function parse(args: { source: Source; options?: { max_candidates?: number } }, env?: Env) {
  if (!args?.source?.name || !args?.source?.type) throw new Error("source.type and source.name are required.");
  const raw = sourceText(args.source);
  const maxCandidates = args.options?.max_candidates ?? 12;
  const classified = await classifySource(args.source, env);
  let e: Evidence[];
  let candidates: Candidate[];
  let classificationMeta: Record<string, unknown>;
  if (classified.classification) {
    const c = classified.classification;
    e = [
      { kind: "semantic_intent", value: c.intent || "unknown", reason: c.summary || "Classifier did not provide a summary.", confidence: 0.8 },
      ...c.topics.map((topic) => ({ kind: "semantic_topic", value: topic, reason: c.summary || `Source covers ${topic}.`, confidence: 0.75 }))
    ];
    candidates = classifiedCandidates(args.source, c, e, maxCandidates);
    classificationMeta = { mode: "semantic_classification", via: classified.via, summary: c.summary, intent: c.intent, topics: c.topics, output_types: c.output_types };
  } else {
    e = evidence(args.source);
    candidates = legacyCandidates(args.source, e);
    classificationMeta = { mode: "keyword_fallback", via: classified.via, error: classified.error };
  }
  const sliced = candidates.slice(0, maxCandidates);
  return { ok: true, source: args.source, summary: { evidence_count: e.length, candidate_count: sliced.length, existing_mcp_tool_count: existing(args.source).length }, evidence: e, existing_mcp_tools_detected: existing(args.source), recommended_tools: sliced, classification: classificationMeta };
}

async function ensureCandidates(args: { source?: Source; candidates?: Candidate[] }, env?: Env) {
  if (Array.isArray(args.candidates) && args.candidates.length) return args.candidates;
  if (!args.source) throw new Error("Provide either candidates or source.");
  return (await parse({ source: args.source }, env)).recommended_tools;
}

async function noAuthAppContract(args: { source: Source; candidates?: Candidate[]; project_name?: string; namespace?: string; worker_slug?: string; owner?: string; repo?: string; base_path?: string }, env?: Env) {
  const candidates = await ensureCandidates(args, env);
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
      endpoints: [{ method: "GET", path: "/", purpose: "Service card." }, { method: "GET", path: "/health", purpose: "Liveness." }, { method: "POST", path: "/mcp", purpose: "JSON-RPC MCP." }],
      mcp: { protocol_versions: ["2024-11-05", "2025-03-26"], methods: ["initialize", "tools/list", "tools/call"], tools },
      files: [{ path: `${basePath}/src/index.ts`, role: "worker_mcp_entrypoint", generated: true }, { path: `${basePath}/package.json`, role: "npm_scripts_and_dev_dependencies", generated: true }, { path: `${basePath}/wrangler.toml`, role: "worker_deploy_config", generated: true }, { path: `${basePath}/README.md`, role: "developer_usage_docs", generated: true }, { path: `${basePath}/tests/schema.test.ts`, role: "schema_and_contract_tests", generated: true }],
      wrangler: { name: workerSlug, main: "src/index.ts", compatibility_date: DEFAULT_COMPATIBILITY_DATE, workers_dev: true, vars: { MCP_SERVER_NAME: workerSlug, AFO_APP_KIND: "no_auth_developer_mcp" }, services: [{ binding: "CAIRNSTONE_V5", service: "cairnstone-v5" }], secrets: [] },
      toolsmith: { registry_kind: "generated_no_auth_dev_mcp_app", dedupe_key: `${namespace}/${workerSlug}`, receipt_required: true, cairnstone_source_required: true }
    }
  };
}

async function blueprints(args: { source: Source; candidates?: Candidate[]; project_name?: string; namespace?: string; worker_slug?: string }, env?: Env) {
  const app = (await noAuthAppContract(args, env)).app;
  return [{ metadata: { project_name: app.project_name, version: SERVICE_VERSION, namespace: app.namespace, description: `Generated no-auth developer MCP app from ${args.source.type}:${args.source.name}` }, options: { auto_status_tool: true, compatibility_date: DEFAULT_COMPATIBILITY_DATE, execution_logging: true, r2_payload_offload: false, vector_embedding: false, write_receipt: true, no_auth_dev_app: true }, auth: app.auth, endpoints: app.endpoints, mcp: app.mcp, files: app.files, wrangler: app.wrangler, bindings: { services: [{ binding: "CAIRNSTONE_V5", service: "cairnstone-v5", required: false }], d1_databases: [], secrets: [{ name: "GITHUB_TOKEN", description: "Optional GitHub source expansion token.", required: false }] }, tools: app.mcp.tools }];
}

async function score(args: { source?: Source; candidates?: Candidate[]; existing_tool_names?: string[] }, env?: Env) {
  const candidates = await ensureCandidates(args, env);
  const existingNames = new Set((args.existing_tool_names ?? []).map((name) => name.toLowerCase()));
  return candidates.map((item) => {
    const duplicate = existingNames.has(String(item.name).toLowerCase());
    const schemaBonus = item.input_schema ? 0.08 : 0;
    const authBonus = item.auth?.mode === "none" ? 0.04 : 0;
    const total = Math.max(0, Math.min(1, (item.confidence ?? 0.5) + schemaBonus + authBonus - (duplicate ? 0.25 : 0)));
    return { ...item, scores: { total, schema_bonus: schemaBonus, no_auth_fit_bonus: authBonus, duplication_penalty: duplicate ? 0.25 : 0 }, recommended_action: duplicate ? "merge_with_existing" : total > 0.62 ? "build" : "defer" };
  }).sort((left, right) => right.scores.total - left.scores.total);
}

async function compare(args: { source?: Source; candidates?: Candidate[]; existing_tools?: Array<{ name?: string }> }, env?: Env) {
  const candidates = await ensureCandidates(args, env);
  const existingTools = args.existing_tools ?? [];
  const overlaps = candidates.filter((item) => existingTools.some((tool) => (tool.name ?? "").toLowerCase() === String(item.name).toLowerCase()));
  const overlapNames = new Set(overlaps.map((item) => item.name));
  const gaps = candidates.filter((item) => !overlapNames.has(item.name));
  return { ok: true, counts: { candidates: candidates.length, existing_tools: existingTools.length, overlaps: overlaps.length, gaps: gaps.length }, overlaps, gaps };
}

async function plan(args: { source?: Source; candidates?: Candidate[]; mode?: string; project_name?: string; namespace?: string; worker_slug?: string }, env?: Env) {
  const scored = (await score(args, env)) as Array<Candidate & { recommended_action: string }>;
  const selected = scored.filter((item) => item.recommended_action === "build").slice(0, args.mode === "full" ? 10 : 3);
  const app = args.source ? (await noAuthAppContract({ source: args.source, candidates: selected }, env)).app : undefined;
  return { ok: true, selected_tools: selected.map((item) => item.name), no_auth_app: app, phases: [{ phase: 1, name: "Evidence lock", steps: ["Attach candidates to source evidence."] }, { phase: 2, name: "No-auth MCP contract", steps: ["Generate /, /health, and /mcp endpoints."] }, { phase: 3, name: "Schema hardening", steps: selected.map((item) => `Finalize schema for ${item.name}.`) }], scored_candidates: selected };
}

function normalizeCairnstoneBase(args: { cairnstone_api_url?: string; cairnstone_mcp_url?: string }, env?: Env) {
  const raw = args.cairnstone_api_url ?? args.cairnstone_mcp_url ?? env?.CAIRNSTONE_API_URL ?? env?.CAIRNSTONE_MCP_URL ?? DEFAULT_CAIRNSTONE_API_URL;
  return String(raw).replace(/\/mcp\/?$/, "").replace(/\/+$/, "");
}

function mcpUrl(base: string) { return `${base}/mcp`; }
function serviceUrl(path: string) { return `https://cairnstone-v5${path.startsWith("/") ? path : `/${path}`}`; }

async function fetchCairnstone(env: Env | undefined, base: string, path: string, init: RequestInit) {
  if (env?.CAIRNSTONE_V5) {
    const response = await env.CAIRNSTONE_V5.fetch(new Request(serviceUrl(path), init));
    return { response, via: "service_binding:CAIRNSTONE_V5" };
  }
  const response = await fetch(`${base}${path}`, init);
  return { response, via: "http_fallback" };
}

async function readJsonResponse(response: Response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { ok: false, text }; }
}

function decodeJsonText(value: any): any {
  if (value?.structuredContent) return value.structuredContent;
  if (typeof value?.text === "string") { try { return JSON.parse(value.text); } catch { return value; } }
  const text = value?.content?.find?.((item: any) => item?.type === "text")?.text;
  if (typeof text === "string") { try { return JSON.parse(text); } catch { return { ok: true, text }; } }
  return value;
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
  return await cairnstoneTool(base, "cairnstone_get_chain_manifest", { chain }, env) as CairnstoneManifest;
}

async function cairnstoneQueryExpand(base: string, hash: string, query: string, topK: number, contextLines: number, env?: Env) {
  const body = { stone_hash: hash, query, top_k: topK, context_lines: contextLines, include_metadata: true };
  try { return await cairnstoneTool(base, "cairnstone_query_and_expand", body, env); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
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
  const queryExpand = await cairnstoneQueryExpand(base, headHash, query, topK, contextLines, env);
  const content = [`CHAIN ${args.chain}`, `HEAD ${headHash}`, `STONE_COUNT ${manifest.stone_count ?? nodes.length}`, "", "LOD_SUMMARIES", ...selectedNodes.map(nodeSummary), "", "QUERY_EXPAND", JSON.stringify(queryExpand), "", "GRAPH_EDGES", JSON.stringify(manifest.edges ?? [])].join("\n");
  const bridgeSource = manifest.bridge_source ?? (env?.CAIRNSTONE_V5 ? "service_binding:CAIRNSTONE_V5" : "http_fallback");
  const minedSource: Source = { type: "cairnstone_chain", name: args.chain, content, metadata: { chain: args.chain, head_hash: headHash, node_count: nodes.length, selected_node_count: selectedNodes.length, cairnstone_api_url: base, bridge_source: bridgeSource, query } };
  const parsed = await parse({ source: minedSource }, env);
  const builtBlueprints = await blueprints({ source: minedSource, candidates: parsed.recommended_tools }, env);
  const noAuthApp = (await noAuthAppContract({ source: minedSource, candidates: parsed.recommended_tools }, env)).app;
  return { ...parsed, blueprints: builtBlueprints, no_auth_app: noAuthApp, chain: args.chain, cairnstone: { api_url: base, mcp_url: mcpUrl(base), bridge_source: bridgeSource, service_binding_configured: Boolean(env?.CAIRNSTONE_V5), head_hash: headHash, node_count: nodes.length, selected_node_count: selectedNodes.length }, mining_steps: ["get_chain_manifest", "resolve_HEAD", "collect_LOD_summaries", "query_expand_HEAD", "parse_source_for_tool_opportunities", "generate_no_auth_dev_mcp_app"], manifest_summary: { head_hash: manifest.head_hash, head_updated_at: manifest.head_updated_at, stone_count: manifest.stone_count, edges_count: Array.isArray(manifest.edges) ? manifest.edges.length : 0 }, query_expand: queryExpand, source_summary: minedSource };
}

export function listTools() {
  return toolNames.map((name) => ({ name, description: descriptions[name], inputSchema: name === "mine_cairnstone_chain" ? mineChainSchema : sourceSchema }));
}

export function callTool(name: string, args: any) {
  const env = (arguments.length > 2 ? arguments[2] : undefined) as Env | undefined;
  const table: Record<string, () => unknown | Promise<unknown>> = {
    parse_source_for_tool_opportunities: () => parse(args, env),
    extract_existing_mcp_tools: () => ({ ok: true, tools: existing(args.source) }),
    generate_blueprint_candidates: () => blueprints(args, env).then((list) => ({ ok: true, blueprints: list })),
    generate_no_auth_dev_mcp_app: () => noAuthAppContract(args, env),
    score_tool_candidates: () => score(args, env).then((list) => ({ ok: true, candidates: list })),
    compare_against_toolsmith_inventory: () => compare(args, env),
    create_build_plan: () => plan(args, env),
    mine_cairnstone_chain: () => mineChain(args, env),
    recommend_output_type: () => routeOutputType(args.source, env),
    generate_document_blueprint: () => generateDocumentBlueprint(args.source, env),
    generate_document: () => generateDocument(args, env),
    generate_software_app_blueprint: () => generateSoftwareAppBlueprint(args.source, env),
    generate_software_app: () => generateSoftwareApp(args, env)
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
    if (payload.method === "initialize") return json({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "cairnstone-tool-miner-mcp", version: SERVICE_VERSION } } });
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
    if (request.method === "GET" && url.pathname === "/health") return json({ ok: true, service: "cairnstone-tool-miner-mcp", version: SERVICE_VERSION, auth: { mode: "none", developer_app: true }, tools: toolNames, cairnstone_bridge: { service_binding_configured: Boolean(env.CAIRNSTONE_V5), http_fallback_configured: Boolean(env.CAIRNSTONE_API_URL ?? env.CAIRNSTONE_MCP_URL ?? DEFAULT_CAIRNSTONE_API_URL) }, ai_classifier: { binding_configured: Boolean(env.AI), model: CLASSIFIER_MODEL } });
    if (request.method === "GET" && url.pathname === "/") return json({ ok: true, name: "cairnstone-tool-miner-mcp", version: SERVICE_VERSION, app_kind: "no_auth_developer_mcp", endpoints: ["/health", "/mcp"], tools: toolNames });
    if (request.method === "POST" && url.pathname === "/mcp") return rpc(request, env);
    return json({ ok: false, error: "not_found" }, 404);
  }
};
