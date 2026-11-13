"""Import an acknowledged Artifacts checkpoint onto ordinary local disk, without FUSE."""
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import tempfile

remote, branch, commit = sys.argv[1:4]
root = Path(sys.argv[4] if len(sys.argv) > 4 else "/workspace")
if (root / "ready").exists():
    sys.exit(0)
if (root / "repo").exists() or (root / "repo").is_symlink():
    raise RuntimeError("Workspace exists; refusing to overwrite it during migration")

with tempfile.TemporaryDirectory(prefix="migration.", dir=root) as temporary:
    checkout = Path(temporary) / "checkpoint"
    subprocess.run(["git", "init", str(checkout)], check=True, stdout=sys.stderr)
    subprocess.run(["git", "-C", str(checkout), "-c", "protocol.version=1", "fetch", "--depth=1", "--no-tags", remote, "refs/heads/" + branch], check=True, stdout=sys.stderr)
    observed = subprocess.check_output(["git", "-C", str(checkout), "rev-parse", "FETCH_HEAD"], text=True).strip()
    if observed != commit:
        raise RuntimeError("Legacy checkpoint commit does not match its acknowledgement")
    subprocess.run(["git", "-C", str(checkout), "checkout", "--detach", "FETCH_HEAD"], check=True, stdout=sys.stderr)
    with tarfile.open(checkout / "nested.tar") as archive:
        archive.extractall(checkout, filter="data")
    for path in (checkout / "directories").read_bytes().split(b"\0"):
        if not path:
            continue
        relative = PurePosixPath(os.fsdecode(path))
        if relative.is_absolute() or ".." in relative.parts or relative.parts[0] != "files":
            raise RuntimeError("Invalid directory in legacy checkpoint")
        directory = checkout / relative
        if not directory.resolve().is_relative_to(checkout.resolve()):
            raise RuntimeError("Directory escapes legacy checkpoint")
        directory.mkdir(parents=True, exist_ok=True)
    restored = Path(temporary) / "repo"
    shutil.copytree(checkout / "files", restored, symlinks=True)
    gitdir = restored / ".git"
    if gitdir.exists() or gitdir.is_symlink():
        raise RuntimeError("Unexpected root .git in legacy checkpoint")
    gitdir.mkdir()
    with tarfile.open(checkout / "git.tar") as archive:
        archive.extractall(gitdir, filter="data")
    git = ["git", "--git-dir=" + str(gitdir)]
    subprocess.run(git + ["config", "core.worktree", str(root / "repo")], check=True)
    for key in ["core.fsmonitor", "core.untrackedCache"]:
        result = subprocess.run(git + ["config", "--unset", key])
        if result.returncode not in (0, 5):
            raise RuntimeError("Cannot clear legacy Git config")
    restored.rename(root / "repo")
(root / "ready").touch()
