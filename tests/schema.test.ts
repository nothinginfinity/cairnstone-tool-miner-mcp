import { describe, expect, it } from "vitest";
import { callTool, listTools } from "../src/index";

const source = {
  type: "cairnstone_chain",
  name: "demo",
  content: "HEAD refs stones tools/list tools/call blueprint worker D1 admin status no-auth developer app article provenance"
};

describe("cairnstone tool miner", () => {
  it("publishes nine MCP tools including chain mining, no-auth app generation, and output-type routing", () => {
    const tools = listTools();
    expect(tools).toHaveLength(9);
    expect(tools.map((tool) => tool.name)).toContain("mine_cairnstone_chain");
    expect(tools.map((tool) => tool.name)).toContain("generate_no_auth_dev_mcp_app");
    expect(tools.map((tool) => tool.name)).toContain("recommend_output_type");
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
});
