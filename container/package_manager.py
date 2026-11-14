"""Select the repository's installer without assuming it uses Dolly's toolchain."""
import json
from pathlib import Path
import re
import subprocess

LOCKFILES = {
    "pnpm": ("pnpm-lock.yaml",),
    "npm": ("npm-shrinkwrap.json", "package-lock.json"),
    "yarn": ("yarn.lock",),
    "bun": ("bun.lock", "bun.lockb"),
}


def selected_manager():
    package = json.loads(Path("package.json").read_text())
    declared = package.get("packageManager", "")
    name = declared.split("@")[0]
    if not name:
        matches = [
            manager for manager, locks in LOCKFILES.items()
            if any(Path(lock).is_file() for lock in locks)
        ]
        if len(matches) > 1:
            raise RuntimeError("Multiple package-manager lockfiles; declare packageManager in package.json")
        name = matches[0] if matches else "npm"
    if name not in LOCKFILES:
        raise RuntimeError("Automatic dependency setup does not support " + name)
    if name in {"pnpm", "yarn"} or (name == "npm" and declared):
        command = ["corepack", name]
    elif name == "bun":
        command = ["bun"]
        if declared:
            match = re.fullmatch(r"bun@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)", declared)
            if not match:
                raise RuntimeError("Bun packageManager must specify an exact version")
            try:
                installed = subprocess.check_output(["bun", "--version"], text=True, timeout=30).strip()
            except (OSError, subprocess.SubprocessError):
                installed = ""
            if installed != match[1]:
                command = ["npx", "--yes", "--package=bun@" + match[1], "--", "bun"]
    else:
        command = ["npm"]
    return name, command


def install_command(name, command):
    locked = any(Path(lock).is_file() for lock in LOCKFILES[name])
    if name == "npm":
        return command + ["ci" if locked else "install"]
    if name in {"pnpm", "bun"}:
        return command + ["install"] + (["--frozen-lockfile"] if locked else [])
    return command + ["install"]
