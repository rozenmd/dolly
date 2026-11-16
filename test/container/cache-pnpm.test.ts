import { cacheManagers } from "./cache-manager";

cacheManagers([
  {
    name: "pnpm inferred from pnpm-lock.yaml",
    bootstrap: "npx --yes --package=pnpm@latest -- pnpm install --lockfile-only",
    lockfile: "pnpm-lock.yaml",
  },
]);
