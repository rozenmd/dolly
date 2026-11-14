"""Disposable dependency installs through the repository-scoped Worker broker."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile
from package_manager import LOCKFILES, selected_manager

ORIGIN = "http://dependencies.workspace/v1/"
MAX_ARCHIVE = 512 * 1024 * 1024
MAX_EXPANDED = 4 * 1024 * 1024 * 1024
LIFECYCLE = {"preinstall", "install", "postinstall", "prepare", "prepublish", "pnpm:devPreinstall"}
CUSTOM_LAYOUT = {
    "pnpmfile", "virtualstoredir", "modulesdir", "enableglobalvirtualstore",
    "injectworkspacepackages", "configdependencies",
}
YARN_LAYOUT = {
    "yarnpath", "plugins", "cachefolder", "modulesfolder", "globalfolder",
    "installstatepath", "pnpunpluggedfolder",
}
YARN_PATHS = (
    ".pnp.cjs", ".pnp.loader.mjs", ".pnp.data.json",
    ".yarn/cache", ".yarn/unplugged", ".yarn/install-state.gz", ".yarn/build-state.yml",
)


class ArchiveReader:
    def __init__(self, stream):
        self.stream = stream
        self.size = 0

    def read(self, size):
        data = self.stream.read(min(size, 1024 * 1024))
        self.size += len(data)
        if self.size > MAX_EXPANDED:
            raise ValueError("Dependency archive exceeds expanded limit")
        return data


def module_roots(root):
    found = []
    for directory, dirs, _ in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if name not in {".git", ".yarn"}]
        if "node_modules" in dirs:
            path = Path(directory) / "node_modules"
            if path.is_symlink():
                raise ValueError("node_modules root is a symlink")
            found.append(path.relative_to(root))
            dirs.remove("node_modules")
    return sorted(found)


def cache_paths(root):
    paths = module_roots(root)
    for name in YARN_PATHS:
        path = root / name
        if path.is_symlink():
            raise ValueError("Dependency cache root is a symlink")
        if path.exists():
            paths.append(Path(name))
    return sorted(paths)


def usable(paths, root):
    return (
        Path("node_modules") in paths and (root / "node_modules").is_dir()
        or Path(".pnp.cjs") in paths and (root / ".pnp.cjs").is_file()
    )


def allowed_path(name, yarn):
    path = Path(name)
    parts = path.parts
    if path.is_absolute() or ".." in parts or ".git" in parts:
        return False
    if "node_modules" in parts and parts[0] != ".yarn":
        return True
    return yarn and any(
        name == entry or (entry in {".yarn/cache", ".yarn/unplugged"} and name.startswith(entry + "/"))
        for entry in YARN_PATHS
    )


def cache_key():
    package = json.loads(Path("package.json").read_text())
    manager, command = selected_manager()
    if not any(Path(lock).is_file() for lock in LOCKFILES[manager]) or Path(".agents/setup").exists():
        return None
    version = subprocess.check_output(command + ["--version"], text=True, timeout=60).strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version):
        return None
    if Path(".pnpmfile.cjs").exists() or Path("pnpmfile.cjs").exists():
        return None
    tracked = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"]
    ).decode().split("\0")
    inputs = {
        "package.json", "pnpm-workspace.yaml", ".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml",
        *LOCKFILES[manager],
    }
    for name in tracked:
        path = Path(name)
        if not name or "node_modules" in path.parts:
            continue
        if path.name == "package.json":
            manifest = json.loads(path.read_text())
            # Repository lifecycle scripts can depend on arbitrary source files or secrets.
            if LIFECYCLE.intersection(manifest.get("scripts", {})):
                return None
            if any(meta.get("injected") for meta in manifest.get("dependenciesMeta", {}).values()):
                return None
            for group in ("dependencies", "devDependencies", "optionalDependencies"):
                if any(re.match(r"^(?:file|link|portal):", spec) for spec in manifest.get(group, {}).values()):
                    return None
            inputs.add(name)
        if path.name in {".pnpmfile.cjs", "pnpmfile.cjs"}:
            return None
        if path.name in {".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml"} or path.suffix == ".patch":
            inputs.add(name)
    # Local file dependencies can embed source not described by the lockfile.
    if any(
        re.search(rb"\b(?:file|portal):", Path(lock).read_bytes())
        for lock in LOCKFILES[manager] if Path(lock).is_file()
    ):
        return None
    if manager == "yarn" and (
        package.get("installConfig", {}).get("pnp")
        or Path(".pnp.js").exists()
        or os.environ.get("YARN_ENABLE_GLOBAL_CACHE") != "false"
    ):
        return None
    fingerprint = subprocess.check_output([
        "node", "-p",
        "JSON.stringify({versions:process.versions,platform:process.platform,arch:process.arch})",
    ])
    digest = hashlib.sha256(b"dolly-dependency-cache-v2\0" + fingerprint)
    digest.update(json.dumps([manager, version]).encode())
    digest.update(platform.libc_ver().__repr__().encode())
    digest.update(Path("/etc/os-release").read_bytes())
    digest.update(Path(__file__).read_bytes())
    digest.update(Path(__file__).with_name("dolly-setup.py").read_bytes())
    digest.update(Path(__file__).with_name("package_manager.py").read_bytes())
    for key in sorted(os.environ):
        if key.lower().startswith(("npm_config_", "yarn_", "bun_", "corepack_")) or key in {"NODE_ENV", "NODE_OPTIONS", "CI"}:
            if any(setting in key.lower().replace("_", "") for setting in CUSTOM_LAYOUT):
                return None
            if manager == "yarn" and any(setting in key.lower().replace("_", "") for setting in YARN_LAYOUT):
                return None
            digest.update(json.dumps([key, os.environ[key]]).encode())
    inputs.update({
        str(Path.home() / ".npmrc"), str(Path.home() / ".config/pnpm/rc"),
        str(Path.home() / ".yarnrc"), str(Path.home() / ".yarnrc.yml"),
        str(Path.home() / ".bunfig.toml"),
    })
    configs = [
        Path(name).read_text() for name in inputs
        if Path(name).is_file() and Path(name).name in {
            ".npmrc", "rc", "pnpm-workspace.yaml", "package.json", ".yarnrc", ".yarnrc.yml", "bunfig.toml",
        }
    ]
    normalized = re.sub(r"[-_]", "", "\n".join(configs)).lower()
    if any(setting in normalized for setting in CUSTOM_LAYOUT):
        return None
    if manager == "yarn":
        yarn_configs = "\n".join(
            Path(name).read_text() for name in inputs
            if Path(name).is_file() and Path(name).name in {".yarnrc", ".yarnrc.yml"}
        )
        if any(setting in re.sub(r"[-_]", "", yarn_configs).lower() for setting in YARN_LAYOUT):
            return None
    if "patcheddependencies" in normalized:
        # A patch path may have any extension; include its source inputs conservatively.
        inputs.update(name for name in tracked if name and Path(name).is_file())
    for name in sorted(inputs):
        path = Path(name)
        digest.update(name.encode() + b"\0")
        digest.update(path.read_bytes() if path.is_file() else b"<absent>")
        digest.update(b"\0")
    return digest.hexdigest()


def transfer(method, key, path):
    command = [
        "curl", "--silent", "--show-error", "--noproxy", "*", "--proto", "=http",
        "--connect-timeout", "3", "--max-time", "30", "--max-filesize", str(MAX_ARCHIVE),
        "--write-out", "%{http_code}", "--output",
        str(path) if method == "GET" else os.devnull,
        "--header", "X-Dolly-Dependency-Cache: " + os.environ.get("DOLLY_DEPENDENCY_CACHE_TOKEN", ""),
    ]
    if method == "PUT":
        command += ["--upload-file", str(path), "--header", "Content-Type: application/zstd"]
    result = subprocess.run(command + [ORIGIN + key], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError("Dependency cache transfer failed")
    return int(result.stdout)


def restore(key):
    root = Path.cwd()
    if cache_paths(root):
        return False
    moved = []
    try:
        manager, _ = selected_manager()
        with tempfile.TemporaryDirectory(prefix="dolly-dependencies-") as scratch:
            archive = Path(scratch) / "modules.tar.zst"
            if transfer("GET", key, archive) != 200:
                print("dependency_cache: miss", flush=True)
                return False
            stage = Path(scratch) / "stage"
            stage.mkdir()
            total = 0
            count = 0
            with subprocess.Popen(
                ["zstd", "-q", "-d", "-c", "--memory=256MB", str(archive)],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            ) as decoder:
                try:
                    reader = ArchiveReader(decoder.stdout)
                    with tarfile.open(fileobj=reader, mode="r|") as tar:
                        for member in tar:
                            count += 1
                            total += member.size
                            if (
                                count > 200_000 or total > MAX_EXPANDED
                                or not allowed_path(member.name.rstrip("/"), manager == "yarn")
                                or not (member.isfile() or member.isdir() or member.issym() or member.islnk())
                            ):
                                raise ValueError("Unsafe dependency archive")
                            tar.extract(member, stage, filter="data")
                    # Drain through the bound to validate the zstd checksum without
                    # deadlocking on padding or accepting an unbounded trailing payload.
                    while reader.read(1024 * 1024):
                        pass
                    if decoder.wait() != 0:
                        raise ValueError("Invalid zstd archive")
                finally:
                    if decoder.poll() is None:
                        decoder.kill()
            modules = cache_paths(stage)
            if not usable(modules, stage):
                raise ValueError("Missing dependency installation")
            for path in modules:
                destination = root / path
                if not destination.parent.resolve().is_relative_to(root):
                    raise ValueError("Workspace path leaves repository")
                if destination.exists() or destination.is_symlink():
                    raise ValueError("Refusing to replace existing dependencies")
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(stage / path), destination)
                moved.append(destination)
        print("dependency_cache: restored", flush=True)
        return True
    except Exception:
        for path in moved:
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
        print("dependency_cache: restore unavailable; installing", flush=True)
        return False


def publish(key):
    try:
        if cache_key() != key:
            return
        modules = cache_paths(Path.cwd())
        if not usable(modules, Path.cwd()):
            return
        with tempfile.TemporaryDirectory(prefix="dolly-dependencies-") as scratch:
            archive = Path(scratch) / "modules.tar.zst"
            with subprocess.Popen(
                ["tar", "-c", "-f", "-", "--", *map(str, modules)],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            ) as tar:
                try:
                    result = subprocess.run(
                        ["zstd", "-q", "-T2", "-3", "-o", str(archive)],
                        stdin=tar.stdout, stderr=subprocess.DEVNULL,
                    )
                    tar.stdout.close()
                    if result.returncode or tar.wait() != 0:
                        raise RuntimeError("Dependency archive failed")
                finally:
                    if tar.poll() is None:
                        tar.kill()
            if archive.stat().st_size <= MAX_ARCHIVE:
                status = transfer("PUT", key, archive)
                print("dependency_cache: stored" if status == 201 else "dependency_cache: not stored", flush=True)
    except Exception:
        print("dependency_cache: publish unavailable", flush=True)


def eligible_key():
    try:
        if not os.environ.get("DOLLY_DEPENDENCY_CACHE_TOKEN"):
            return None
        if cache_paths(Path.cwd()):
            return None
        return cache_key()
    except Exception:
        return None
