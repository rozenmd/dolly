import { cacheManagers } from "./cache-manager";

cacheManagers([
  {
    name: "Bun inferred from bun.lock",
    bootstrap: "bun install --lockfile-only",
    lockfile: "bun.lock",
  },
  {
    name: "Bun with a declared version and binary lockfile",
    manager: "bun@1.1.45",
    bootstrap: "npx --yes --package=bun@1.1.45 -- bun install --lockfile-only",
    lockfile: "bun.lockb",
  },
  {
    name: "Bun inferred from a binary lockfile",
    bootstrap: "npx --yes --package=bun@1.1.45 -- bun install --lockfile-only",
    lockfile: "bun.lockb",
  },
]);
