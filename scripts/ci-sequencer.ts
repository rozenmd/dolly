import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { URL } from "node:url";
import { BaseSequencer, type TestSpecification } from "vite-plus/test/node";
import * as Schema from "effect/Schema";

const timings = new Map(
  Object.entries(
    Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Number))(
      JSON.parse(readFileSync(new URL("../tools/ci/timings.json", import.meta.url), "utf8")),
    ),
  ),
);

/** Longest recorded test files first, greedily assigned to the lightest shard. */
export class TimingSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]) {
    const shard = this.ctx.config.shard;

    if (!shard) return files;

    const bins: { files: TestSpecification[]; duration: number }[] = Array.from(
      { length: shard.count },
      () => ({
        files: [],
        duration: 0,
      }),
    );

    const path = (file: TestSpecification) =>
      relative(this.ctx.config.root, file.moduleId).replaceAll("\\", "/");

    // Cold workerd startup/imports dominate tiny files. Unknown files get a conservative estimate.
    const duration = (file: TestSpecification) => (timings.get(path(file)) ?? 5_000) + 3_000;

    const ordered = [...files].sort(
      (a, b) => duration(b) - duration(a) || path(a).localeCompare(path(b), "en"),
    );

    for (const file of ordered) {
      const bin = bins.toSorted((a, b) => a.duration - b.duration)[0];
      bin.files.push(file);
      bin.duration += duration(file);
    }

    const selected = bins[shard.index - 1];

    console.log(
      `Timing shard ${shard.index}/${shard.count}: ${selected.files.length} files, estimated ${selected.duration}ms`,
    );

    return selected.files;
  }
}
