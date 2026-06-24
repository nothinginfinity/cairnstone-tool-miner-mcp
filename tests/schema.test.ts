import { describe, expect, it } from "vitest";
import { callTool, listTools } from "../src/index";

describe("cairnstone tool miner", () => {
  it("publishes six MCP tools", () => {
    expect(listTools()).toHaveLength(6);
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
