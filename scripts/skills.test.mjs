import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const source = await readFile(new URL("../container/skills.py", import.meta.url), "utf8");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "dolly-skills-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  return root;
}

async function skill(root, path, name, description = "Check this checkout") {
  await mkdir(join(root, path), { recursive: true });
  await writeFile(
    join(root, path, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nPrivate full instructions\n`,
  );
}

function discover(root) {
  const result = spawnSync("python3", ["-I", "-c", source, root], {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
  });

  assert.equal(result.status, 0, result.stderr);

  return JSON.parse(result.stdout);
}

test("discovers nested checkout skills with precedence and metadata only", async (t) => {
  const root = await fixture(t);
  await skill(root, ".claude/skills/check", "verify", '"Preferred verification"');
  await skill(root, ".agents/skills/verify", "verify", "Lower precedence");
  await skill(
    root,
    ".agents/skills/suite/skills/other",
    "other",
    ">-\n  Multi-line\n  description",
  );
  await skill(root, ".opencode/skills/third", "third");
  const result = discover(root);
  assert.deepEqual(result, {
    skills: [
      {
        name: "verify",
        description: "Preferred verification",
        path: ".claude/skills/check/SKILL.md",
      },
      {
        name: "other",
        description: "Multi-line description",
        path: ".agents/skills/suite/skills/other/SKILL.md",
      },
      {
        name: "third",
        description: "Check this checkout",
        path: ".opencode/skills/third/SKILL.md",
      },
    ],
    truncated: false,
    unreadable: [],
  });
  assert.ok(!JSON.stringify(result).includes("Private full instructions"));
});

test("refreshes edits and isolates repositories without host or external symlink skills", async (t) => {
  const root = await fixture(t);
  const other = await fixture(t);
  await skill(root, ".agents/skills/verify", "verify");
  await skill(other, ".agents/skills/external", "external");
  await writeFile(join(root, "json.py"), 'raise RuntimeError("Never import checkout code")\n');
  await symlink(join(other, ".agents/skills/external"), join(root, ".agents/skills/external"));
  await symlink(join(root, ".agents/skills"), join(root, ".agents/skills/loop"));
  assert.deepEqual(
    discover(root).skills.map((s) => s.name),
    ["verify"],
  );
  assert.deepEqual(
    discover(other).skills.map((s) => s.name),
    ["external"],
  );
  await skill(root, ".agents/skills/verify", "verify", "Updated");
  assert.equal(discover(root).skills[0].description, "Updated");
});

test("distinguishes missing roots, invalid metadata and a bounded inventory", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(discover(root), { skills: [], truncated: false, unreadable: [] });
  await skill(root, ".agents/skills/invalid", "<injected>");
  assert.deepEqual(discover(root).unreadable, [".agents/skills/invalid/SKILL.md"]);

  for (let index = 0; index < 100; index++)
    await skill(root, `.agents/skills/skill-${index}`, `skill-${index}`, "x".repeat(256));

  const result = discover(root);
  assert.equal(result.truncated, true);
  assert.ok(result.skills.length < 100);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32768);
});
