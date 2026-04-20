/**
 * One-time pre-launch database purge script.
 * Calls web_purge_all_posts via the public Railway MCP endpoint.
 * Run with: npx tsx scripts/purge-db.ts
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const WEB_MCP_URL = "https://sidelineiq-mcp-servers.up.railway.app/mcp";

async function main() {
  console.log("Connecting to web MCP server:", WEB_MCP_URL);

  const client = new Client({ name: "purge-script", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(WEB_MCP_URL));

  await client.connect(transport);
  console.log("Connected.\n");

  const result = await client.callTool({
    name: "web_purge_all_posts",
    arguments: { confirm: true, reason: "Pre-launch test data purge" },
  });

  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text;
  const parsed = JSON.parse(text);

  if (result.isError) {
    console.error("Purge failed:", parsed);
    process.exit(1);
  }

  console.log("=== PURGE COMPLETE ===");
  console.log("Before:");
  console.log("  injury_posts:", parsed.before.injury_posts);
  console.log("  md_reviews:  ", parsed.before.md_reviews);
  console.log("\nAfter:");
  console.log("  injury_posts:", parsed.after.injury_posts);
  console.log("  md_reviews:  ", parsed.after.md_reviews);
  console.log("\nDeleted:", parsed.deleted_posts, "posts,", parsed.deleted_reviews, "reviews");

  await client.close();
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
