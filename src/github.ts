import { createPrivateKey } from "node:crypto";
import { flow } from "effect/Function";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { GitHubSetup, GitHubRequest, GitHubReply, Repository } from "./github-contracts";
import {
  WebhookSetup,
  WebhookProfile,
  verifyWebhook,
  GitHubEvent,
  WebhookUrl,
} from "./github-webhook";
import { exceptionDetails } from "./diagnostics";
import { integrationJson } from "./integration-http";
import { attempt, OperationError } from "./operations";

const Permissions = { contents: "write", pull_requests: "write", metadata: "read" } as const;

const App = Schema.Struct({
  id: Schema.Number,
  slug: Schema.NonEmptyString,
  pem: Schema.NonEmptyString,
  webhook_secret: Schema.optional(Schema.NonEmptyString),
  owner: Schema.Struct({ login: Schema.String }),
});

const Connected = Schema.Struct({ app: App, repositories: Schema.Array(Repository) });

const Pending = Schema.Struct({
  state: Schema.String,
  expires: Schema.Number,
  origin: Schema.String,
  setup: GitHubSetup,
  phase: Schema.Literals(["pending", "converting"]),
});

const Token = Schema.Struct({ token: Schema.NonEmptyString, expires_at: Schema.String });
const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const RefResponse = Schema.Struct({ object: Schema.Struct({ sha: Sha }) });
const RepoResponse = Schema.Struct({ default_branch: Schema.String });

const FileResponse = Schema.Struct({
  type: Schema.Literal("file"),
  path: Schema.String,
  sha: Sha,
  encoding: Schema.Literal("base64"),
  content: Schema.String,
  size: Schema.Number,
});

const CommitResponse = Schema.Struct({ commit: Schema.Struct({ sha: Sha }) });
const PullResponse = Schema.Struct({ number: Schema.Number, html_url: Schema.String });

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

const jwt = Effect.fn("GitHub.jwt")(function* (app: typeof App.Type) {
  const now = Math.floor(Date.now() / 1000);

  const part = (value: { alg: string; typ: string } | { iss: string; iat: number; exp: number }) =>
    base64url(new TextEncoder().encode(JSON.stringify(value)));

  const input = `${part({ alg: "RS256", typ: "JWT" })}.${part({ iss: String(app.id), iat: now - 60, exp: now + 540 })}`;

  const privateKey = yield* attempt("github.key", async () => {
    const der = createPrivateKey(app.pem).export({ type: "pkcs8", format: "der" });

    return crypto.subtle.importKey(
      "pkcs8",
      new Uint8Array(der),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  });

  const signature = yield* attempt("github.sign", () =>
    crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(input)),
  );

  return `${input}.${base64url(new Uint8Array(signature))}`;
});

const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  flow(
    Schema.decodeUnknownEffect(schema, { reportInput: false }),
    Effect.mapError(
      (cause) =>
        new OperationError({
          operation: "github.decode",
          message: "Invalid GitHub response or stored configuration",
          details: exceptionDetails(cause),
        }),
    ),
  );

type GitHubBody =
  | {
      repositories: readonly string[];
      permissions: { contents: string; pull_requests: string; metadata: string };
    }
  | { body: string }
  | { ref: string; sha: string }
  | { head: string; base: string; title: string; body: string }
  | { message: string; branch: string; content: string; sha?: string };

function makeGitHub(storage: DurableObjectStorage, webhookUrl: string) {
  const setupPermit = Semaphore.makeUnsafe(1);
  const tokens = new Map<string, { value: string; expires: number }>();

  const read = Effect.fn("GitHub.configuration")(function* () {
    const raw = yield* attempt("github.read", () => storage.get("github:connected"));

    if (raw === undefined)
      return yield* new OperationError({
        operation: "github.setup",
        message: "Connect a GitHub App first",
        details: null,
      });

    return yield* decode(Connected)(raw);
  });

  const api = Effect.fn("GitHub.api")((
    path: string,
    token: string,
    body?: GitHubBody,
    method = body ? "POST" : "GET",
  ) => {
    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "pi-hard",
      "Content-Type": "application/json",
    });

    if (token) headers.set("Authorization", `Bearer ${token}`);

    return integrationJson(`https://api.github.com${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  });

  const tokenFor = Effect.fn("GitHub.token")(function* (
    connected: typeof Connected.Type,
    repository: string,
    write: boolean,
  ) {
    const key = `${repository}:${write}`;
    const cached = tokens.get(key);

    if (cached && cached.expires > Date.now() + 300_000) return cached.value;
    const appToken = yield* jwt(connected.app);

    const installation = yield* api(`/repos/${repository}/installation`, appToken).pipe(
      Effect.flatMap(decode(Schema.Struct({ id: Schema.Number }))),
    );

    const name = repository.split("/")[1];

    const result = yield* api(`/app/installations/${installation.id}/access_tokens`, appToken, {
      repositories: [name],
      permissions: {
        contents: write ? "write" : "read",
        pull_requests: write ? "write" : "read",
        metadata: "read",
      },
    }).pipe(Effect.flatMap(decode(Token)));

    const expires = yield* decode(Schema.Finite)(Date.parse(result.expires_at));

    if (expires <= Date.now())
      return yield* new OperationError({
        operation: "github.token",
        message: "GitHub returned an expired or invalid installation token",
        details: null,
      });
    tokens.set(key, { value: result.token, expires });

    return result.token;
  });

  const status = Effect.gen(function* () {
    const raw = yield* attempt("github.status", () => storage.get("github:connected"));

    if (raw === undefined) return { connected: false };
    const value = yield* decode(Connected)(raw);

    return {
      connected: true,
      owner: value.app.owner.login,
      appSlug: value.app.slug,
      repositories: value.repositories,
      installUrl: `https://github.com/apps/${encodeURIComponent(value.app.slug)}/installations/new`,
    };
  });

  const start = Effect.fn("GitHub.start")((setup: typeof GitHubSetup.Type, origin: string) =>
    setupPermit.withPermit(
      Effect.gen(function* () {
        const existing = yield* status;

        if (existing.connected) return { ...existing, setupUrl: null };

        for (const repository of setup.repositories)
          if (repository.split("/")[0].toLowerCase() !== setup.owner.toLowerCase())
            return yield* new OperationError({
              operation: "github.setup",
              message: "Every repository must belong to the selected owner",
              details: null,
            });
        const previous = yield* attempt("github.pending", () => storage.get("github:pending"));

        const pending =
          previous === undefined ? Option.none() : Schema.decodeUnknownOption(Pending)(previous);

        if (
          Option.isSome(pending) &&
          pending.value.expires > Date.now() &&
          pending.value.phase === "pending"
        ) {
          if (
            pending.value.origin !== origin ||
            JSON.stringify(pending.value.setup) !== JSON.stringify(setup)
          )
            return yield* new OperationError({
              operation: "github.setup",
              message: "A different setup is pending; finish it or wait one hour",
              details: null,
            });

          return { connected: false, setupUrl: `${origin}/setup/github/${pending.value.state}` };
        }

        const state = base64url(crypto.getRandomValues(new Uint8Array(32)));
        yield* attempt("github.pending.write", () =>
          storage.put("github:pending", {
            state,
            expires: Date.now() + 3_600_000,
            setup,
            origin,
            phase: "pending",
          }),
        );

        return { connected: false, setupUrl: `${origin}/setup/github/${state}` };
      }),
    ),
  );

  const pending = Effect.fn("GitHub.pending")(function* (state: string) {
    const raw = yield* attempt("github.pending.read", () => storage.get("github:pending"));
    const value = yield* decode(Pending)(raw);

    if (value.state !== state || value.expires <= Date.now() || value.phase !== "pending")
      return yield* new OperationError({
        operation: "github.setup",
        message: "Setup link is invalid, expired or already used",
        details: null,
      });

    return value;
  });

  const manifest = Effect.fn("GitHub.manifest")(function* (state: string) {
    const value = yield* pending(state);

    if (webhookUrl) yield* decode(WebhookUrl)(webhookUrl);

    const action =
      value.setup.ownerType === "organization"
        ? `https://github.com/organizations/${encodeURIComponent(value.setup.owner)}/settings/apps/new`
        : "https://github.com/settings/apps/new";

    return {
      action: `${action}?state=${encodeURIComponent(state)}`,
      manifest: {
        name: `Pi Hard ${state.slice(0, 8)}`,
        url: value.origin,
        public: false,
        redirect_url: `${value.origin}/setup/github/callback`,
        default_permissions: webhookUrl ? { ...Permissions, issues: "read" } : Permissions,
        default_events: webhookUrl ? ["issue_comment"] : [],
        hook_attributes: {
          url: webhookUrl || `${value.origin}/hooks/github`,
          active: Boolean(webhookUrl),
        },
      },
    };
  });

  const complete = Effect.fn("GitHub.complete")((state: string, code: string) =>
    setupPermit.withPermit(
      Effect.gen(function* () {
        const value = yield* pending(state);
        yield* attempt("github.converting", () =>
          storage.put("github:pending", { ...value, phase: "converting" }),
        );

        const app = yield* api(
          `/app-manifests/${encodeURIComponent(code)}/conversions`,
          "",
          undefined,
          "POST",
        ).pipe(Effect.flatMap(decode(App)));

        if (app.owner.login.toLowerCase() !== value.setup.owner.toLowerCase())
          return yield* new OperationError({
            operation: "github.setup",
            message: "GitHub App owner does not match the selected account",
            details: null,
          });
        yield* jwt(app);
        yield* attempt("github.save", () =>
          storage.put({ "github:connected": { app, repositories: value.setup.repositories } }),
        );
        yield* attempt("github.pending.delete", () => storage.delete("github:pending"));

        return yield* status;
      }),
    ),
  );

  const execute = Effect.fn("GitHub.execute")(function* (
    input: typeof GitHubRequest.Type,
  ): Effect.fn.Return<typeof GitHubReply.Type, OperationError> {
    const connected = yield* read();
    const op = input.operation;

    if (op.action === "repositories")
      return { ok: true, result: { kind: "repositories", repositories: connected.repositories } };

    const repository = connected.repositories.find(
      (name) => name.toLowerCase() === op.repository.toLowerCase(),
    );

    if (!repository)
      return {
        ok: false,
        code: "repository_denied",
        message: "Repository is not approved for this installation",
      };
    const write = op.action !== "read_file";
    const token = yield* tokenFor(connected, repository, write);
    const root = `/repos/${repository}`;

    if (write) {
      const info = yield* api(root, token).pipe(Effect.flatMap(decode(RepoResponse)));

      if (op.branch === info.default_branch)
        return {
          ok: false,
          code: "default_branch",
          message: "Writes to the default branch are forbidden",
        };
    }

    switch (op.action) {
      case "read_file": {
        const file = yield* api(
          `${root}/contents/${op.path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(op.ref)}`,
          token,
        ).pipe(Effect.flatMap(decode(FileResponse)));

        if (file.size > 32_768 || file.content.replace(/\s/g, "").length > 43_692)
          return { ok: false, code: "file_too_large", message: "File exceeds 32 KiB" };

        const content = yield* attempt("github.file.decode", async () =>
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
            Uint8Array.from(atob(file.content.replace(/\s/g, "")), (char) => char.charCodeAt(0)),
          ),
        );

        return { ok: true, result: { kind: "file", path: file.path, sha: file.sha, content } };
      }

      case "create_branch": {
        const base = yield* api(`${root}/git/ref/heads/${encodeURIComponent(op.base)}`, token).pipe(
          Effect.flatMap(decode(RefResponse)),
        );

        const created = yield* api(`${root}/git/refs`, token, {
          ref: `refs/heads/${op.branch}`,
          sha: base.object.sha,
        }).pipe(Effect.flatMap(decode(RefResponse)));

        return { ok: true, result: { kind: "branch", name: op.branch, sha: created.object.sha } };
      }

      case "write_file": {
        if (op.path.toLowerCase().startsWith(".github/workflows/"))
          return {
            ok: false,
            code: "workflow_denied",
            message: "Workflow changes are not allowed through agent tools",
          };

        const bytes = new TextEncoder().encode(op.content);

        if (bytes.byteLength > 32_768)
          return { ok: false, code: "file_too_large", message: "File exceeds 32 KiB" };

        const content = base64url(bytes).replace(/-/g, "+").replace(/_/g, "/");

        const padded = content.padEnd(Math.ceil(content.length / 4) * 4, "=");

        const commit = yield* api(
          `${root}/contents/${op.path.split("/").map(encodeURIComponent).join("/")}`,
          token,
          {
            message: op.message,
            branch: op.branch,
            content: padded,
            sha: op.sha,
          },
          "PUT",
        ).pipe(Effect.flatMap(decode(CommitResponse)));

        return { ok: true, result: { kind: "commit", sha: commit.commit.sha } };
      }

      case "open_pull_request": {
        const pull = yield* api(`${root}/pulls`, token, {
          head: op.branch,
          base: op.base,
          title: op.title,
          body: op.body,
        }).pipe(Effect.flatMap(decode(PullResponse)));

        return {
          ok: true,
          result: { kind: "pull_request", number: pull.number, url: pull.html_url },
        };
      }
    }
  });

  const configureWebhook = Effect.fn("GitHub.configureWebhook")((input: typeof WebhookSetup.Type) =>
    setupPermit.withPermit(
      Effect.gen(function* () {
        const connected = yield* read();
        const previous = yield* attempt("github.webhook.read", () => storage.get("github:webhook"));
        const saved = previous === undefined ? undefined : yield* decode(WebhookProfile)(previous);
        const secret = input.secret ?? saved?.secret ?? connected.app.webhook_secret;

        if (!secret || !webhookUrl)
          return yield* new OperationError({
            operation: "github.webhook.setup",
            message: "Configure GITHUB_WEBHOOK_URL and a GitHub webhook secret first",
            details: null,
          });
        yield* decode(WebhookUrl)(webhookUrl);
        const installations: { repository: string; id: number }[] = [];
        const token = yield* jwt(connected.app);

        for (const repository of connected.repositories) {
          const installation = yield* api(`/repos/${repository}/installation`, token).pipe(
            Effect.flatMap(
              decode(
                Schema.Struct({
                  id: Schema.Number,
                  permissions: Schema.Struct({ issues: Schema.optional(Schema.String) }),
                  events: Schema.Array(Schema.String),
                }),
              ),
            ),
          );

          if (
            !["read", "write"].includes(installation.permissions.issues ?? "") ||
            !installation.events.includes("issue_comment")
          )
            return yield* new OperationError({
              operation: "github.webhook.permissions",
              message:
                "Enable Issues read permission and Issue comments events in GitHub App settings, then approve installation changes",
              details: { repository },
            });
          installations.push({ repository, id: installation.id });
        }

        yield* attempt("github.webhook.save", () =>
          storage.put("github:webhook", { secret, senders: input.senders, installations }),
        );

        return { configured: true, url: webhookUrl, senders: input.senders };
      }),
    ),
  );

  const receiveWebhook = Effect.fn("GitHub.receiveWebhook")(function* (
    body: ArrayBuffer,
    signature: string,
    event: string,
  ) {
    const raw = yield* attempt("github.webhook.read", () => storage.get("github:webhook"));

    if (raw === undefined) return { status: 503 as const };
    const profile = yield* decode(WebhookProfile)(raw);

    return yield* verifyWebhook(profile, body, signature, event);
  });

  const reply = Effect.fn("GitHub.reply")(function* (event: typeof GitHubEvent.Type, text: string) {
    const connected = yield* read();

    if (
      !connected.repositories.some((name) => name.toLowerCase() === event.repository.toLowerCase())
    )
      return yield* new OperationError({
        operation: "github.reply",
        message: "Repository is no longer approved",
        details: null,
      });
    const token = yield* tokenFor(connected, event.repository, true);
    const root = `/repos/${event.repository}/issues/${event.number}/comments`;
    const marker = `<!-- pi-hard:comment:${event.commentId} -->`;

    for (let page = 1; page <= 10; page++) {
      const comments = yield* api(`${root}?per_page=100&page=${page}`, token).pipe(
        Effect.flatMap(
          decode(
            Schema.Array(
              Schema.Struct({ body: Schema.String, user: Schema.Struct({ login: Schema.String }) }),
            ),
          ),
        ),
      );

      if (
        comments.some(
          (comment) =>
            comment.user.login === `${connected.app.slug}[bot]` && comment.body.endsWith(marker),
        )
      )
        return;

      if (comments.length < 100) {
        yield* api(root, token, { body: `${text.slice(0, 16_384)}\n\n${marker}` });

        return;
      }
    }

    return yield* new OperationError({
      operation: "github.reply",
      message: "Reply history exceeds safe deduplication limit (1000 comments)",
      details: null,
    });
  });

  return { status, start, manifest, complete, execute, configureWebhook, receiveWebhook, reply };
}

export class GitHub extends Context.Service<GitHub, ReturnType<typeof makeGitHub>>()(
  "pi-hard/GitHub",
) {
  static readonly layer = (storage: DurableObjectStorage, webhookUrl = "") =>
    Layer.succeed(GitHub, makeGitHub(storage, webhookUrl));
}
