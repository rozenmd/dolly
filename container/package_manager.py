"""Select the repository's installer without assuming it uses Dolly's toolchain."""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

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


def installed(command, timeout=30):
    try:
        return subprocess.check_output(command + ["--version"], text=True, timeout=timeout).strip()
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
    elif version and installed([name]) != version:
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


def pinned(command):
    """Replace a floating npx package (latest, yarn@1) with the version it resolves to."""
    package = command[2].removeprefix("--package=") if command[:1] == ["npx"] else ""
    if not package or VERSION.fullmatch(package.rpartition("@")[2]):
        return command
    version = installed(command, timeout=120)
    if not VERSION.fullmatch(version):
        return command
    return command[:2] + ["--package=" + package.rpartition("@")[0] + "@" + version] + command[3:]


def install_shim(name, command, directory=None):
    """Put the selected manager on PATH, so later shells run the same pinned release.

    Setup reaches npx-fetched managers only through npx; without a shim, `pnpm`
    is missing and `yarn`/`bun` would run the image's unrelated releases.
    """
    if command == [name]:
        return None
    directory = Path(directory or os.environ.get("DOLLY_SHIM_DIR", "/usr/local/bin"))
    command = pinned(command)
    script = "#!/bin/sh\n"
    if name == "yarn":
        # Match setup: keep Yarn's archives in the checkout, not a global cache.
        script += 'export YARN_ENABLE_GLOBAL_CACHE="${YARN_ENABLE_GLOBAL_CACHE:-false}"\n'
    script += "exec " + shlex.join(command) + ' "$@"\n'
    target = directory / name
    # Replace atomically: the image's own yarn/bun may be running concurrently.
    descriptor, temporary = tempfile.mkstemp(dir=directory, prefix="." + name + "-")
    try:
        with os.fdopen(descriptor, "w") as handle:
            handle.write(script)
        os.chmod(temporary, 0o755)
        os.replace(temporary, target)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    return target
