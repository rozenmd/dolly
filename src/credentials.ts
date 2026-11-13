import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import { attempt } from "./operations";

/** The same permit protects login, logout, and Pi's rotating-token refresh. */
export class Account extends Context.Service<
  Account,
  Pick<Credentials, "storage" | "get" | "put" | "remove" | "locked">
>()("dolly/Account") {}

export class Credentials implements CredentialStore {
  private readonly permit = Semaphore.makeUnsafe(1);
  constructor(readonly storage: DurableObjectStorage) {}

  locked<A, E, R>(effect: Effect.Effect<A, E, R>) {
    return this.permit.withPermit(effect);
  }

  get = Effect.fn("Account.get")((providerId: string) =>
    attempt("credential.read", () => this.storage.get<Credential>(`credential:${providerId}`)).pipe(
      Effect.map(Option.fromUndefinedOr),
    ),
  );

  put = Effect.fn("Account.put")((providerId: string, credential: Credential) =>
    attempt("credential.write", () => this.storage.put(`credential:${providerId}`, credential)),
  );

  remove = Effect.fn("Account.remove")((providerId: string) =>
    attempt("credential.delete", () => this.storage.delete(`credential:${providerId}`)),
  );

  // Pi requires a Promise-based CredentialStore. Run only at that interop boundary.
  read(providerId: string) {
    return Effect.runPromise(this.get(providerId).pipe(Effect.map(Option.getOrUndefined)));
  }

  list() {
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const entries: { providerId: string; type: Credential["type"] }[] = [];

        for (const providerId of ["openai-codex", "anthropic"]) {
          const credential = yield* this.get(providerId);

          if (Option.isSome(credential)) entries.push({ providerId, type: credential.value.type });
        }

        return entries;
      }),
    );
  }

  secrets = Effect.gen({ self: this }, function* () {
    const secrets: string[] = [];

    for (const providerId of ["openai-codex", "anthropic"]) {
      const credential = Option.getOrUndefined(yield* this.get(providerId));

      if (credential?.type === "oauth") secrets.push(credential.access, credential.refresh);
      else if (credential?.type === "api_key" && credential.key) secrets.push(credential.key);
    }

    return secrets;
  });

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ) {
    return Effect.runPromise(
      this.locked(
        Effect.gen({ self: this }, function* () {
          const current = yield* this.get(providerId);

          const next = yield* attempt("credential.modify", () =>
            fn(Option.getOrUndefined(current)),
          );

          if (next) yield* this.put(providerId, next);

          return next ?? Option.getOrUndefined(current);
        }),
      ),
    );
  }

  delete(providerId: string) {
    return Effect.runPromise(this.locked(this.remove(providerId)).pipe(Effect.asVoid));
  }
}
