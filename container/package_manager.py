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

# Corepack is deliberately unused: its downloader is unreliable in the sandbox.
# npx fetches the exact declared release from the npm registry instead.
VERSION = re.compile(r"(\d+)\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?")


def npx(package, binary):
    return ["npx", "--yes", "--package=" + package, "--", binary]


def declared_version(name, declared):
    match = re.fullmatch(re.escape(name) + r"@([^+]+)(?:\+.*)?", declared)
    if not match or not VERSION.fullmatch(match[1]):
        raise RuntimeError(name + " packageManager must specify an exact version")
    return match[1]


def installed(binary):
    try:
        return subprocess.check_output([binary, "--version"], text=True, timeout=30).strip()
    except (OSError, subprocess.SubprocessError):
        return ""


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
    version = declared_version(name, declared) if declared else None
    if name == "pnpm":
        command = npx("pnpm@" + (version or "latest"), "pnpm")
    elif name == "yarn":
        # Yarn 2+ is published as @yarnpkg/cli-dist; the yarn package is Classic.
        if version and int(VERSION.fullmatch(version)[1]) >= 2:
            command = npx("@yarnpkg/cli-dist@" + version, "yarn")
        else:
            command = npx("yarn@" + (version or "1"), "yarn")
    elif version and installed(name) != version:
        command = npx(name + "@" + version, name)
    else:
        command = [name]
    return name, command


def install_command(name, command):
    locked = any(Path(lock).is_file() for lock in LOCKFILES[name])
    if name == "npm":
        return command + ["ci" if locked else "install"]
    if name in {"pnpm", "bun"}:
        return command + ["install"] + (["--frozen-lockfile"] if locked else [])
    return command + ["install"]
