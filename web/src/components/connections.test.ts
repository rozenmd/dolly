import { describe, expect, it } from "vite-plus/test";
import { nameFromUrl } from "./connections";

describe("nameFromUrl", () => {
  it.each([
    ["https://mcp.linear.app/mcp", "linear"],
    ["https://api.getvero.com/mcp", "vero"],
    ["https://mcp.vercel.com", "vercel"],
    ["https://api.oneleet.com/mcp", "oneleet"],
    ["https://mcp.resend.com/mcp", "resend"],
    ["https://mcp.cloudflare.com/mcp", "cloudflare"],
    ["https://mcp.pscale.dev/mcp/planetscale", "pscale"],
    ["https://api.example.co.uk/mcp", "example"],
    ["https://my-tools.acme.workers.dev/mcp", "my-tools"],
    ["https://foo.vercel.app/mcp", "foo"],
    ["https://localhost:8080/mcp", "localhost"],
    ["mcp.linear.app", ""],
    ["", ""],
  ])("%s -> %s", (url, name) => {
    expect(nameFromUrl(url)).toBe(name);
  });
});
