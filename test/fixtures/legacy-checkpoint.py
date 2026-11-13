"""Legacy format fixture producer. New runtime checkpoints use native snapshots."""
import os
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time

repository, branch, parent = sys.argv[1:4]
root = sys.argv[4] if len(sys.argv) == 5 else "/workspace"
worktree = os.path.join(root, "repo")
git = ["git", "--git-dir=" + os.path.join(root, "checkpoints.git")]
subprocess.run(["git", "init", "--bare", os.path.join(root, "checkpoints.git")], check=True, stdout=sys.stderr)
if parent:
    subprocess.run(git + ["fetch", "--no-tags", repository, parent], check=True, stdout=sys.stderr)

# Git metadata is opaque checkpoint data. The working files remain a versioned Git tree.
gitdir = subprocess.check_output(["git", "-C", worktree, "rev-parse", "--absolute-git-dir"], text=True).strip()
with tempfile.TemporaryDirectory(dir=root) as temporary:
    archive = os.path.join(temporary, "git.tar")
    with tarfile.open(archive, "w") as tar:
        tar.add(gitdir, arcname=".")
    process = subprocess.Popen(git + ["fast-import", "--quiet"], stdin=subprocess.PIPE)
    stream = process.stdin

    def line(value):
        stream.write(value.encode() + b"\n")

    def pathquote(path):
        # Quote every byte, including newlines and non-UTF-8 filenames, using Git's octal syntax.
        return '"' + ''.join('\\%03o' % byte for byte in os.fsencode(path)) + '"'

    directories = []
    nested_git = []

    def entry(path, target):
        info = os.lstat(path)
        if stat.S_ISLNK(info.st_mode):
            data = os.fsencode(os.readlink(path))
            line("M 120000 inline " + pathquote(target))
            line("data " + str(len(data)))
            stream.write(data + b"\n")
        elif stat.S_ISREG(info.st_mode):
            mode = "100755" if info.st_mode & 0o111 else "100644"
            line("M " + mode + " inline " + pathquote(target))
            line("data " + str(info.st_size))
            with open(path, "rb") as file:
                shutil.copyfileobj(file, stream)
            stream.write(b"\n")
        elif stat.S_ISDIR(info.st_mode):
            directories.append(os.fsencode(target))
            for child in sorted(os.listdir(path)):
                # Exclude only the root Git pointer. Nested repositories must survive too.
                if child == ".git":
                    if target != "files":
                        nested_git.append((os.path.join(path, child), target + "/" + child))
                    continue
                entry(os.path.join(path, child), target + "/" + child)
        else:
            raise RuntimeError("Cannot checkpoint special file: " + repr(target))

    try:
        line("commit refs/heads/" + branch)
        line("committer Dolly <dolly@users.noreply.github.com> " + str(int(time.time())) + " +0000")
        line("data 20")
        line("Workspace checkpoint")
        if parent:
            line("from " + subprocess.check_output(git + ["rev-parse", "FETCH_HEAD"], text=True).strip())
        line("deleteall")
        entry(os.path.realpath(worktree), "files")
        entry(archive, "git.tar")
        nested_archive = os.path.join(temporary, "nested.tar")
        with tarfile.open(nested_archive, "w") as tar:
            for path, target in nested_git:
                tar.add(path, arcname=target)
        entry(nested_archive, "nested.tar")
        directory_data = b"\0".join(directories)
        line('M 100644 inline "directories"')
        line("data " + str(len(directory_data)))
        stream.write(directory_data + b"\n")
        line("")
        line("done")
        stream.close()
        if process.wait() != 0:
            raise RuntimeError("Git checkpoint import failed")
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
    subprocess.run(git + ["push", repository, "refs/heads/" + branch], check=True, stdout=sys.stderr)
    print(subprocess.check_output(git + ["rev-parse", "refs/heads/" + branch], text=True).strip())
