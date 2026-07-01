import { describe, expect, it } from "vitest";
import { callTool, listTools } from "../src/index";

const source = {
  type: "cairnstone_chain",
  name: "demo",
  content: "HEAD refs stones tools/list tools/call blueprint worker D1 admin status no-auth developer app article provenance"
};

describe("cairnstone tool miner", () => {
  it("publishes thirteen MCP tools including chain mining, no-auth app generation, output-type routing, the document lane, and the software_app lane", () => {
    const tools = listTools();
    expect(tools).toHaveLength(13);
    expect(tools.map((tool) => tool.name)).toContain("mine_cairnstone_chain");
    expect(tools.map((tool) => tool.name)).toContain("generate_no_auth_dev_mcp_app");
    expect(tools.map((tool) => tool.name)).toContain("recommend_output_type");
    expect(tools.map((tool) => tool.name)).toContain("generate_document_blueprint");
    expect(tools.map((tool) => tool.name)).toContain("generate_document");
    expect(tools.map((tool) => tool.name)).toContain("generate_software_app_blueprint");
    expect(tools.map((tool) => tool.name)).toContain("generate_software_app");
  });

  it("parses source into candidates", async () => {
    const result = await callTool("parse_source_for_tool_opportunities", { source });
    expect(result.structuredContent).toHaveProperty("ok", true);
    expect(JSON.stringify(result.structuredContent)).toContain("input_schema");
  });

  it("scores candidates from source when candidates are omitted", async () => {
    const result = await callTool("score_tool_candidates", { source });
    expect(result.structuredContent).toHaveProperty("ok", true);
    expect(JSON.stringify(result.structuredContent)).toContain("recommended_action");
  });

  it("creates a build plan from source when candidates are omitted", async () => {
    const result = await callTool("create_build_plan", { source });
    expect(result.structuredContent).toHaveProperty("ok", true);
    expect(JSON.stringify(result.structuredContent)).toContain("No-auth MCP contract");
  });

  it("generates a no-auth developer MCP app contract", async () => {
    const result = await callTool("generate_no_auth_dev_mcp_app", { source, worker_slug: "demo-tools-mcp" });
    expect(result.structuredContent).toHaveProperty("ok", true);
    expect(JSON.stringify(result.structuredContent)).toContain("afo.no_auth.developer_mcp_app.v1");
    expect(JSON.stringify(result.structuredContent)).toContain("/mcp");
  });

  it("exposes a dedicated input schema for chain mining", () => {
    const miner = listTools().find((tool) => tool.name === "mine_cairnstone_chain");
    expect(miner?.inputSchema).toHaveProperty("required");
    expect(JSON.stringify(miner?.inputSchema)).toContain("chain");
  });

  it("routes a source to output-type recommendations covering the full taxonomy, even with no AI binding", async () => {
    const result = await callTool("recommend_output_type", { source });
    expect(result.structuredContent).toHaveProperty("ok", true);
    expect(result.structuredContent).toHaveProperty("mode");
    expect(result.structuredContent).toHaveProperty("taxonomy");
    expect(result.structuredContent).toHaveProperty("output_type_recommendations");
    expect(result.structuredContent).toHaveProperty("top_recommendation");
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).toContain("mcp_tool");
    expect(serialized).toContain("software_app");
    // No AI binding is configured in this unit-test environment, so the router must fall back
    // gracefully (not throw) and still return a complete, well-shaped taxonomy.
    expect(result.structuredContent).toHaveProperty("mode", "keyword_fallback");
  });

  it("exposes a dedicated input schema for output-type routing", () => {
    const router = listTools().find((tool) => tool.name === "recommend_output_type");
    expect(router?.inputSchema).toHaveProperty("required");
    expect(JSON.stringify(router?.inputSchema)).toContain("source");
  });

  it("generates a document blueprint from source, even with no AI binding", async () => {
    const result = await callTool("generate_document_blueprint", { source });
    expect(result.structuredContent).toHaveProperty("ok", true);
    expect(result.structuredContent).toHaveProperty("blueprint");
    expect(result.structuredContent).toHaveProperty("mode", "keyword_fallback");
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).toContain("title");
    expect(serialized).toContain("sections");
  });

  it("drafts a full document from source, falling back to a structured skeleton with no AI binding", async () => {
    const result = await callTool("generate_document", { source });
    expect(result.structuredContent).toHaveProperty("ok", true);
    expect(result.structuredContent).toHaveProperty("document");
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).toContain("markdown");
    expect(serialized).toContain("Source Material");
  });

  it("exposes dedicated input schemas for the document lane tools", () => {
    const blueprintTool = listTools().find((tool) => tool.name === "generate_document_blueprint");
    const draftTool = listTools().find((tool) => tool.name === "generate_document");
    expect(blueprintTool?.inputSchema).toHaveProperty("required");
    expect(draftTool?.inputSchema).toHaveProperty("required");
  });

  it("generates a software_app blueprint from source, even with no AI binding", async () => {
    const result = await callTool("generate_software_app_blueprint", { source });
    expect(result.structuredContent).toHaveProperty("ok", true);
    expect(result.structuredContent).toHaveProperty("blueprint");
    expect(result.structuredContent).toHaveProperty("mode", "keyword_fallback");
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).toContain("app_name");
    expect(serialized).toContain("features");
    expect(serialized).toContain("entry_file");
  });

  it("drafts a software_app entry file from source, falling back to a structured skeleton with no AI binding", async () => {
    const result = await callTool("generate_software_app", { source });
    expect(result.structuredContent).toHaveProperty("ok", true);
    expect(result.structuredContent).toHaveProperty("app");
    const serialized = JSON.stringify(result.structuredContent);
    expect(serialized).toContain("entry_file");
    expect(serialized).toContain("Source Material");
  });

  it("exposes dedicated input schemas for the software_app lane tools", () => {
    const blueprintTool = listTools().find((tool) => tool.name === "generate_software_app_blueprint");
    const draftTool = listTools().find((tool) => tool.name === "generate_software_app");
    expect(blueprintTool?.inputSchema).toHaveProperty("required");
    expect(draftTool?.inputSchema).toHaveProperty("required");
  });
});
