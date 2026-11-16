import { cacheManagers } from "./cache-manager";

cacheManagers([
  {
    name: "npm inferred from package-lock.json",
    bootstrap: "npm install --package-lock-only",
    lockfile: "package-lock.json",
  },
  {
    name: "npm inferred from npm-shrinkwrap.json",
    bootstrap: "npm install --package-lock-only && npm shrinkwrap",
    lockfile: "npm-shrinkwrap.json",
  },
  {
    name: "npm with a declared version",
    manager: "npm@11.0.0",
    bootstrap: "npx --yes --package=npm@11.0.0 -- npm install --package-lock-only",
    lockfile: "package-lock.json",
  },
]);
