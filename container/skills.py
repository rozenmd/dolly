"""Read a bounded skill inventory from one checkout; never execute skill code."""

import json
from itertools import islice
from pathlib import Path
import re
import stat
import sys


def inventory(checkout):
    checkout = Path(checkout).resolve()
    skills = {}
    errors = []
    visited = set()
    truncated = False
    remaining = 1000

    def inside(path):
        return path.resolve().is_relative_to(checkout)

    def scan(directory, depth):
        nonlocal remaining, truncated
        if remaining <= 0:
            truncated = True
            return
        remaining -= 1
        try:
            resolved = directory.resolve()
            if not inside(directory) or resolved in visited:
                return
            visited.add(resolved)
            md = directory / "SKILL.md"
            if md.exists():
                if not inside(md) or not stat.S_ISREG(md.stat().st_mode):
                    return
                with md.open("rb") as source:
                    text = source.read(8192).decode("utf-8", errors="replace")
                # Inventory only: full instructions remain in SKILL.md.
                frontmatter = re.match(r"\A---\r?\n([\s\S]*?)\r?\n---", text)
                fields = {}
                if frontmatter:
                    lines = frontmatter.group(1).splitlines()
                    for index, line in enumerate(lines):
                        match = re.match(r"^(name|description):\s*(.*)$", line)
                        if not match:
                            continue
                        key, value = match.groups()
                        if value in (">", ">-", "|", "|-"):
                            parts = []
                            for continuation in lines[index + 1 :]:
                                if continuation and not continuation[0].isspace():
                                    break
                                parts.append(continuation.strip())
                            value = " ".join(parts)
                        fields[key] = value.strip().strip("\"'")
                name = fields.get("name") or directory.name
                if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}", name):
                    errors.append(str(md.relative_to(checkout)))
                    return
                skills.setdefault(
                    name,
                    {
                        "name": name,
                        "description": fields.get("description", "")[:256],
                        "path": str(md.relative_to(checkout)),
                    },
                )
                return
            if depth <= 0:
                truncated = True
                return
            entries = list(islice(directory.iterdir(), remaining + 1))
            if len(entries) > remaining:
                truncated = True
            for entry in sorted(entries[:remaining]):
                remaining -= 1
                if remaining <= 0:
                    truncated = True
                    break
                if not entry.name.startswith(".") and entry.is_dir():
                    scan(entry, depth - 1)
        except (OSError, RuntimeError):
            errors.append(str(directory.relative_to(checkout)))

    # First name wins, matching checkout precedence in Open Session.
    for root in (".claude/skills", ".agents/skills", ".opencode/skills"):
        path = checkout / root
        if path.exists():
            scan(path, 5)
    entries = []
    for skill in skills.values():
        if len(json.dumps(entries + [skill]).encode("utf-8")) > 24000:
            truncated = True
            break
        entries.append(skill)
    return {
        "skills": entries,
        "truncated": truncated,
        "unreadable": [path[:256] for path in errors[:5]],
    }


if __name__ == "__main__":
    print(json.dumps(inventory(sys.argv[1] if len(sys.argv) > 1 else "/workspace/repo")))
