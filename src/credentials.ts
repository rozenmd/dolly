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
>()("pi-hard/Account") {}

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
      this.get("openai-codex").pipe(
        Effect.map(
          Option.match({
            onNone: () => [],
            onSome: (credential) => [{ providerId: "openai-codex", type: credential.type }],
          }),
        ),
      ),
    );
  }

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
