import type { Credential, CredentialStore } from "@earendil-works/pi-ai";

/** One owner and one serialized write path, including refresh, login and logout. */
export class Credentials implements CredentialStore {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: DurableObjectStorage) {}

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn);
    this.tail = next.catch(() => undefined);
    return next;
  }

  read(providerId: string): Promise<Credential | undefined> {
    return this.storage.get<Credential>(`credential:${providerId}`);
  }

  async list() {
    const credential = await this.read("openai-codex");
    return credential ? [{ providerId: "openai-codex", type: credential.type }] : [];
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    return this.exclusive(async () => {
      const current = await this.read(providerId);
      const next = await fn(current);
      if (next) await this.storage.put(`credential:${providerId}`, next);
      return next ?? current;
    });
  }

  delete(providerId: string): Promise<void> {
    return this.exclusive(async () => {
      await this.storage.delete(`credential:${providerId}`);
    });
  }
}
