"""Install the Node.js release a repository asks for, from the npm registry.

The sandbox reaches package registries but not nodejs.org, so the official
Linux binaries come from their npm mirrors (node-linux-x64, node-linux-arm64).
`npm pack` checks each tarball against the registry's integrity hash.
"""
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import tarfile
import tempfile

ARCHES = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}
# Versions and ranges only. Aliases such as lts/* or node would need nvm's
# release index, and anything else would reach npm as a non-registry spec.
SPEC = re.compile(r"[v0-9xX*<>=^~][0-9A-Za-z.*\s<>=^~|-]*")
EXACT = re.compile(r"\d+\.\d+\.\d+")


def requested(root=Path(".")):
    """Return (spec, source) for the first Node version the repository declares."""
    for name in (".node-version", ".nvmrc"):
        path = root / name
        if path.is_file():
            lines = [line.split("#")[0].strip() for line in path.read_text().splitlines()]
            spec = next((line for line in lines if line), "")
            if spec:
                return spec, name
    manifest = root / "package.json"
    if manifest.is_file():
        package = json.loads(manifest.read_text())
        runtimes = (package.get("devEngines") or {}).get("runtime")
        for runtime in runtimes if isinstance(runtimes, list) else [runtimes]:
            if isinstance(runtime, dict) and runtime.get("name") == "node" and isinstance(runtime.get("version"), str):
                return runtime["version"].strip(), "package.json devEngines.runtime"
        engine = (package.get("engines") or {}).get("node")
        if isinstance(engine, str) and engine.strip():
            return engine.strip(), "package.json engines.node"
    return None


def npm(*args, timeout=120):
    """Run npm outside the checkout: a repository's devEngines would otherwise veto it."""
    return subprocess.check_output(["npm", *args], text=True, timeout=timeout, cwd=tempfile.gettempdir())


def current():
    try:
        return subprocess.check_output(["node", "-p", "process.versions.node"], text=True, timeout=30).strip()
    except (OSError, subprocess.SubprocessError):
        return ""


def npm_root():
    return Path(npm("root", "--global").strip()) / "npm"


def satisfies(version, spec):
    """Ask npm's bundled semver, so ranges mean what they mean to npm."""
    script = (
        "const semver=require(process.argv[1]);"
        "process.exit(semver.satisfies(process.argv[2],process.argv[3])?0:1)"
    )
    return subprocess.run(
        ["node", "-e", script, str(npm_root() / "node_modules/semver"), version, spec],
        timeout=30,
    ).returncode == 0


def resolve(package, spec):
    """The newest published release matching spec."""
    output = npm("view", f"{package}@{spec}", "version", "--json")
    versions = json.loads(output) if output.strip() else []
    versions = versions if isinstance(versions, list) else [versions]
    if not versions:
        raise RuntimeError(f"No {package} release matches {spec}")
    return versions[-1]


def install(package, version, store):
    """Unpack bin/node from the registry tarball into store/<version>/bin/node."""
    target = store / version / "bin" / "node"
    if target.is_file():
        return target
    with tempfile.TemporaryDirectory() as directory:
        packed = json.loads(npm("pack", f"{package}@{version}", "--json", "--pack-destination", directory, timeout=600))
        with tarfile.open(Path(directory) / packed[0]["filename"]) as archive:
            member = archive.getmember("package/bin/node")
            source = archive.extractfile(member)
            staging = Path(directory) / "node"
            with staging.open("wb") as handle:
                shutil.copyfileobj(source, handle)
        staging.chmod(0o755)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(staging), target)
    return target


def link(binary, directory):
    """Point directory/node at binary, atomically: other processes may be starting node."""
    temporary = directory / ".node-dolly"
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(binary)
    os.replace(temporary, directory / "node")


def prepare(root=Path("."), bin_directory=None, store=None):
    """Make `node` on PATH match the repository's declared version. Returns a status line."""
    declared = requested(root)
    if not declared:
        return None
    spec, source = declared
    if not SPEC.fullmatch(spec):
        return f"node_runtime: {source} asks for {spec!r}; only versions and ranges are supported, keeping Node {current()}"
    spec = spec.lstrip("v")
    version = current()
    if version and satisfies(version, spec):
        return f"node_runtime: Node {version} satisfies {source} ({spec})"
    arch = ARCHES.get(platform.machine().lower())
    if not arch:
        raise RuntimeError(f"No Node binaries for {platform.machine()}")
    package = "node-linux-" + arch
    wanted = spec if EXACT.fullmatch(spec) else resolve(package, spec)
    # npm and npx run on whichever node is on PATH; switching to a release the
    # image's npm cannot run would leave nothing able to install dependencies.
    supported = json.loads((npm_root() / "package.json").read_text()).get("engines", {}).get("node")
    if supported and not satisfies(wanted, supported):
        raise RuntimeError(
            f"{source} asks for Node {wanted}, but the image's npm needs Node {supported}; keeping Node {version}"
        )
    binary = install(package, wanted, Path(store or os.environ.get("DOLLY_NODE_DIR", Path.home() / ".cache/dolly-node")))
    reported = subprocess.check_output([str(binary), "-p", "process.versions.node"], text=True, timeout=30).strip()
    if reported != wanted:
        raise RuntimeError(f"{package}@{wanted} reports Node {reported}")
    link(binary, Path(bin_directory or os.environ.get("DOLLY_SHIM_DIR", "/usr/local/bin")))
    return f"node_runtime: installed Node {wanted} for {source} ({spec}), replacing {version or 'none'}"
