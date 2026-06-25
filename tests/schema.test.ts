import { describe, expect, it } from "vitest";
import { callTool, listTools } from "../src/index";

describe("cairnstone tool miner", () => {
  it("publishes seven MCP tools including chain mining", () => {
    const tools = listTools();
    expect(tools).toHaveLength(7);
    expect(tools.map((tool) => tool.name)).toContain("mine_cairnstone_chain");
  });

  it("parses source into candidates", async () => {
    const result = await callTool("parse_source_for_tool_opportunities", {
      source: {
        type: "cairnstone_chain",
        name: "demo",
        content: "HEAD refs stones tools/list tools/call blueprint worker D1 admin status"
      }
    });

    expect(result.structuredContent).toHaveProperty("ok", true);
  });

  it("exposes a dedicated input schema for chain mining", () => {
    const miner = listTools().find((tool) => tool.name === "mine_cairnstone_chain");
    expect(miner?.inputSchema).toHaveProperty("required");
    expect(JSON.stringify(miner?.inputSchema)).toContain("chain");
  });
});

  it("parses source into candidates", () => {
    const result = callTool("parse_source_for_tool_opportunities", {
      source: {
        type: "cairnstone_chain",
        name: "demo",
        content: "HEAD refs stones tools/list tools/call blueprint worker D1 admin status"
      }
    });

    expect(result.structuredContent).toHaveProperty("ok", true);
  });
});
