# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Revision: `13909c9e07590f5a85d93c62712259fe14a883f7`
- Copied `skills/install-anti-slop/assets/anti-slop/` to this directory, retaining all generic and Effect rules, shared helpers, and the nested ESLint Stylistic license and provenance. These assets match production `src/` at that revision, excluding upstream tests.
- Root MIT license copied from the same revision to `LICENSE`.
- Local deviations: none. The plugin is excluded from repository lint and formatting to preserve the upstream snapshot.

Both entry points are registered in `oxlint.config.ts`. All generic and Effect rules are enabled as errors alongside `oxc/no-accumulating-spread`. Keep `oxlint` and `@oxlint/plugins` pinned to the same version when upgrading.

To update, compare this pristine revision with a chosen upstream revision and retain any future local policy changes. Update this record, preserve both licenses, and verify rule rejection and lint/format stability before committing.
