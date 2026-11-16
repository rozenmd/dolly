import { cacheManagers } from "./cache-manager";

cacheManagers([
  {
    name: "Yarn Classic",
    manager: "yarn@1.22.22",
    bootstrap: "npx --yes --package=yarn@1.22.22 -- yarn install",
    lockfile: "yarn.lock",
  },
  {
    name: "Yarn modern node-modules",
    manager: "yarn@4.18.1",
    bootstrap:
      "YARN_ENABLE_GLOBAL_CACHE=false npx --yes --package=@yarnpkg/cli-dist@4.18.1 -- yarn install",
    lockfile: "yarn.lock",
    config: "nodeLinker: node-modules\n",
  },
  {
    name: "Yarn modern PnP",
    manager: "yarn@4.18.1",
    bootstrap:
      "YARN_ENABLE_GLOBAL_CACHE=false npx --yes --package=@yarnpkg/cli-dist@4.18.1 -- yarn install",
    lockfile: "yarn.lock",
    config: "pnpEnableInlining: false\npnpEnableEsmLoader: true\n",
    pnp: true,
  },
]);
