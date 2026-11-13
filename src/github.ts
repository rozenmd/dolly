import { createPrivateKey } from "node:crypto";
import { flow } from "effect/Function";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import {
  GitHubSetup,
  GitHubAccounts,
  GitHubRequest,
  GitHubReply,
  Repository,
} from "./github-contracts";
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

import {
  GITHUB_APP_GRANT_PERMISSIONS,
  GITHUB_APP_READ_PERMISSIONS,
  GITHUB_APP_WRITE_PERMISSIONS,
  GITHUB_APP_CODE_PERMISSIONS,
} from "./github-permissions";

const App = Schema.Struct({
  id: Schema.Number,
  slug: Schema.NonEmptyString,
  pem: Schema.NonEmptyString,
  client_id: Schema.optional(Schema.NonEmptyString),
  webhook_secret: Schema.optional(Schema.NonEmptyString),
  owner: Schema.Struct({ login: Schema.String, type: Schema.optional(Schema.String) }),
});

const Connected = Schema.Struct({ app: App });

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
      repositories?: readonly string[];
      permissions: Readonly<Record<string, string>>;
    }
  | { body: string }
  | { ref: string; sha: string }
  | { head: string; base: string; title: string; body: string }
  | { message: string; branch: string; content: string; sha?: string }
  | { url: string; content_type: "json"; secret: string; insecure_ssl: "0" };

/** The ingress Worker's webhook URL for a base URL, with or without the `/hooks/github` path. */
export function ingressHook(url: string) {
  const base = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/hooks\/github$/, "");

  return Schema.decodeUnknownOption(WebhookUrl)(`${base}/hooks/github`);
}

function makeGitHub(storage: DurableObjectStorage) {
  const setupPermit = Semaphore.makeUnsafe(1);
  const tokens = new Map<string, { value: string; expires: number }>();

  // Stored policy is authoritative: absence or an empty list denies every owner.
  const accounts = Effect.gen(function* () {
    const raw = yield* attempt("github.accounts.read", () => storage.get("github:accounts"));

    return raw === undefined ? [] : yield* decode(GitHubAccounts.fields.accounts)(raw);
  });

  const accountAllowed = Effect.fn("GitHub.accountAllowed")(function* (owner: string) {
    const allowed = yield* accounts;

    return allowed.some((account) => account.toLowerCase() === owner.toLowerCase());
  });

  const configureAccounts = Effect.fn("GitHub.configureAccounts")(
    (input: typeof GitHubAccounts.Type) =>
      setupPermit.withPermit(
        Effect.gen(function* () {
          const allowed = Array.from(
            new Set(input.accounts.map((account) => account.toLowerCase())),
          );

          yield* attempt("github.accounts.save", () => storage.put("github:accounts", allowed));
          tokens.clear();

          return { accounts: allowed };
        }),
      ),
  );

  const ingress = Effect.gen(function* () {
    const raw = yield* attempt("github.ingress.read", () => storage.get("github:ingress"));

    return raw === undefined ? "" : yield* decode(WebhookUrl)(raw);
  });

  // Who may run /pi commands. The signing secret stays server-side.
  const senders = Effect.gen(function* () {
    const raw = yield* attempt("github.webhook.read", () => storage.get("github:webhook"));

    return raw === undefined ? [] : (yield* decode(WebhookProfile)(raw)).senders;
  });

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
    scope: "read" | "write" | "code",
  ) {
    if (!(yield* accountAllowed(repository.split("/")[0])))
      return yield* new OperationError({
        operation: "github.account",
        message: "GitHub repository owner is not allowed",
        details: null,
      });

    const key = `${repository}:${scope}`;
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
        read: GITHUB_APP_READ_PERMISSIONS,
        write: GITHUB_APP_WRITE_PERMISSIONS,
        code: GITHUB_APP_CODE_PERMISSIONS,
      }[scope],
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

  const repositories = Effect.fn("GitHub.repositories")(function* () {
    const connected = yield* read();
    const appToken = yield* jwt(connected.app);
    const names: string[] = [];

    for (let page = 1; ; page++) {
      const installations = yield* api(
        `/app/installations?per_page=100&page=${page}`,
        appToken,
      ).pipe(
        Effect.flatMap(
          decode(
            Schema.Array(
              Schema.Struct({
                id: Schema.Number,
                account: Schema.Struct({ login: Schema.String }),
              }),
            ),
          ),
        ),
      );

      for (const installation of installations) {
        if (!(yield* accountAllowed(installation.account.login))) continue;

        const token = yield* api(`/app/installations/${installation.id}/access_tokens`, appToken, {
          permissions: GITHUB_APP_READ_PERMISSIONS,
        }).pipe(Effect.flatMap(decode(Token)));

        for (let repositoryPage = 1; ; repositoryPage++) {
          const result = yield* api(
            `/installation/repositories?per_page=100&page=${repositoryPage}`,
            token.token,
          ).pipe(
            Effect.flatMap(
              decode(
                Schema.Struct({
                  repositories: Schema.Array(Schema.Struct({ full_name: Repository })),
                }),
              ),
            ),
          );

          for (const repository of result.repositories) {
            if (yield* accountAllowed(repository.full_name.split("/")[0]))
              names.push(repository.full_name);
          }

          if (result.repositories.length < 100) break;
        }
      }

      if (installations.length < 100) break;
    }

    return names;
  });

  const status = Effect.gen(function* () {
    const raw = yield* attempt("github.status", () => storage.get("github:connected"));

    if (raw === undefined) return { connected: false };
    const value = yield* decode(Connected)(raw);
    const slug = encodeURIComponent(value.app.slug);

    const settings =
      value.app.owner.type === "Organization"
        ? `https://github.com/organizations/${encodeURIComponent(value.app.owner.login)}/settings/apps/${slug}`
        : `https://github.com/settings/apps/${slug}`;

    return {
      connected: true,
      owner: value.app.owner.login,
      appSlug: value.app.slug,
      installUrl: `https://github.com/apps/${slug}/installations/new`,
      settingsUrl: settings,
      ingress: (yield* ingress) || null,
      senders: yield* senders,
    };
  });

  /** The App's OAuth client ID, which runs the device sign-in. Older setups did not store it. */
  const clientId = Effect.gen(function* () {
    const connected = yield* read();

    if (connected.app.client_id) return connected.app.client_id;

    const app = yield* api("/app", yield* jwt(connected.app)).pipe(
      Effect.flatMap(decode(Schema.Struct({ client_id: Schema.NonEmptyString }))),
    );

    yield* attempt("github.client.save", () =>
      storage.put("github:connected", { app: { ...connected.app, client_id: app.client_id } }),
    );

    return app.client_id;
  });

  const configureIngress = Effect.fn("GitHub.configureIngress")((url: string) =>
    setupPermit.withPermit(
      Effect.gen(function* () {
        const hook = ingressHook(url);

        if (Option.isNone(hook))
          return {
            error:
              "Enter the ingress Worker's HTTPS URL, such as https://pi-hard-ingress.example.workers.dev",
          };

        const connected = yield* read();
        const saved = yield* attempt("github.webhook.read", () => storage.get("github:webhook"));
        const profile = saved === undefined ? undefined : yield* decode(WebhookProfile)(saved);
        const secret = profile?.secret ?? connected.app.webhook_secret;

        if (!secret)
          return { error: "This GitHub App has no webhook secret. Create a new GitHub App." };

        yield* api(
          "/app/hook/config",
          yield* jwt(connected.app),
          { url: hook.value, content_type: "json", secret, insecure_ssl: "0" },
          "PATCH",
        );
        yield* attempt("github.ingress.save", () => storage.put("github:ingress", hook.value));

        return { ingress: hook.value };
      }),
    ),
  );

  const start = Effect.fn("GitHub.start")((setup: typeof GitHubSetup.Type, origin: string) =>
    setupPermit.withPermit(
      Effect.gen(function* () {
        const existing = yield* status;

        if (existing.connected) return { ...existing, setupUrl: null };

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

          return {
            connected: false,
            setupUrl: `${origin}/api/setup/github/${pending.value.state}`,
          };
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

        return { connected: false, setupUrl: `${origin}/api/setup/github/${state}` };
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
    const hook = yield* decode(WebhookUrl)(value.setup.ingress);

    const action =
      value.setup.ownerType === "organization"
        ? `https://github.com/organizations/${encodeURIComponent(value.setup.owner)}/settings/apps/new`
        : "https://github.com/settings/apps/new";

    return {
      action: `${action}?state=${encodeURIComponent(state)}`,
      manifest: {
        name: `Pi Hard ${state.slice(0, 8)}`,
        url: value.origin,
        public: true,
        redirect_url: `${value.origin}/api/setup/github/callback`,
        default_permissions: GITHUB_APP_GRANT_PERMISSIONS,
        default_events: ["issue_comment"],
        hook_attributes: { url: hook, active: true },
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
          storage.put({ "github:connected": { app }, "github:ingress": value.setup.ingress }),
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
      return { ok: true, result: { kind: "repositories", repositories: yield* repositories() } };

    const repository = op.repository;
    const write = op.action !== "read_file";
    const token = yield* tokenFor(connected, repository, write ? "write" : "read");
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
        const webhookUrl = yield* ingress;

        if (!secret || !webhookUrl)
          return yield* new OperationError({
            operation: "github.webhook.setup",
            message: "Set the ingress URL and a GitHub webhook secret first",
            details: null,
          });

        const token = yield* jwt(connected.app);

        const app = yield* api("/app", token).pipe(
          Effect.flatMap(
            decode(
              Schema.Struct({
                permissions: Schema.Struct({ issues: Schema.optional(Schema.String) }),
                events: Schema.Array(Schema.String),
              }),
            ),
          ),
        );

        if (
          !["read", "write"].includes(app.permissions.issues ?? "") ||
          !app.events.includes("issue_comment")
        )
          return yield* new OperationError({
            operation: "github.webhook.permissions",
            message:
              "Enable Issues read permission and Issue comments events in GitHub App settings, then approve installation changes",
            details: null,
          });

        yield* attempt("github.webhook.save", () =>
          storage.put("github:webhook", { secret, senders: input.senders }),
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

    const verified = yield* verifyWebhook(profile, body, signature, event);

    if (verified.status !== 202) return verified;

    if (!(yield* accountAllowed(verified.event.repository.split("/")[0])))
      return { status: 403 as const };
    const connected = yield* read();

    const installation = yield* api(
      `/repos/${verified.event.repository}/installation`,
      yield* jwt(connected.app),
    ).pipe(
      Effect.flatMap(decode(Schema.Struct({ id: Schema.Number }))),
      Effect.catchTag("OperationError", (error) => {
        const status = Schema.decodeUnknownOption(Schema.Struct({ status: Schema.Number }))(
          error.details,
        );

        if (Option.isSome(status) && status.value.status === 404) return Effect.succeed(null);

        return Effect.fail(error);
      }),
    );

    if (!installation || installation.id !== verified.event.installationId)
      return { status: 403 as const };

    return verified;
  });

  const reply = Effect.fn("GitHub.reply")(function* (event: typeof GitHubEvent.Type, text: string) {
    const connected = yield* read();

    const token = yield* tokenFor(connected, event.repository, "write");
    const root = `/repos/${event.repository}/issues/${event.number}/comments`;
    const marker = `<!-- pi-hard:comment:${event.commentId} -->`;

    for (let page = 1; ; page++) {
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
  });

  const authorize = Effect.fn("GitHub.authorize")(function* (repository: string, write: boolean) {
    const connected = yield* read();
    const token = yield* tokenFor(connected, repository, write ? "code" : "read");

    const info = yield* api(`/repos/${repository}`, token).pipe(
      Effect.flatMap(decode(RepoResponse)),
    );

    return { token, defaultBranch: info.default_branch };
  });

  return {
    status,
    clientId,
    configureIngress,
    accounts,
    configureAccounts,
    start,
    manifest,
    complete,
    execute,
    configureWebhook,
    receiveWebhook,
    reply,
    authorize,
  };
}

export class GitHub extends Context.Service<GitHub, ReturnType<typeof makeGitHub>>()(
  "pi-hard/GitHub",
) {
  static readonly layer = (storage: DurableObjectStorage) =>
    Layer.succeed(GitHub, makeGitHub(storage));
}
