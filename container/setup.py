"""Best-effort repository setup, adapted to the sandbox's ordinary local checkout."""
import os
import shlex
from pathlib import Path
import subprocess
import sys
import fcntl
from dependency_cache import eligible_key, publish, restore
from node_runtime import prepare as prepare_node
from package_manager import selected_manager, install_command, install_shim

# The DO may be evicted while its container remains alive. Join the original
# attempt and replay its result instead of running two installers in one tree.
# Direct invocations without --once remain useful for deliberate reinstalls.
if "--once" in sys.argv:
    with open("/workspace/setup.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        result = Path("/workspace/setup.exit")
        log = Path("/workspace/setup.log")
        if not result.exists():
            with log.open("wb") as output:
                completed = subprocess.run([sys.executable, __file__], stdout=output, stderr=subprocess.STDOUT)
            result.write_text(str(completed.returncode))
        with log.open("rb") as output:
            while chunk := output.read(32768):
                sys.stdout.buffer.write(chunk)
        sys.exit(int(result.read_text()))

failures = []


def failed(message):
    failures.append(message)
    print(message, file=sys.stderr, flush=True)


# Prepare the toolchain first, so a repository's own hook already finds the
# Node release and package manager it declares.
try:
    status = prepare_node()
    if status:
        print(status, flush=True)
except Exception as error:
    failed(f"node_runtime: could not install the declared Node: {error}")


def select(report):
    """The manager package.json declares, with its PATH shim in place."""
    if not Path("package.json").is_file():
        return None
    try:
        manager, executable = selected_manager()
    except Exception as error:
        if report:
            failed(f"package_manager: {error}")
        return None
    try:
        install_shim(manager, executable)
    except OSError as error:
        # A missing shim must not block dependency installation.
        if report:
            print(f"package_manager: could not add {manager} to PATH: {error}", file=sys.stderr, flush=True)
    return manager, executable


hook = Path(".agents/setup")
custom_setup = hook.is_file()
if custom_setup:
    # Shim the declared manager for the hook; problems are reported after it,
    # which may still write or fix the manifest.
    select(report=False)
    try:
        code = subprocess.run(["./" + str(hook)] if os.access(hook, os.X_OK) else ["sh", str(hook)]).returncode
    except OSError as error:
        code = None
        failed(f"{hook} could not start: {error}")
    if code:
        failed(f"{hook} exited {code}")

# Read the manifest after the hook, which may have produced it or its lockfile.
selected = select(report=True)
if selected:
    manager, executable = selected
    command = install_command(manager, executable)
    if manager == "yarn":
        # Keep modern Yarn's PnP archives inside the checkout, rather than in a
        # global store that would be absent in another session.
        os.environ["YARN_ENABLE_GLOBAL_CACHE"] = "false"
    # A failed hook still leaves the declared dependencies to install.
    key = None if custom_setup else eligible_key()
    if key is None or not restore(key):
        code = subprocess.run(command).returncode
        if code:
            failed(f"{shlex.join(command)} exited {code}")
        elif key is not None:
            publish(key)

if failures:
    print("Setup finished with problems:\n" + "\n".join("- " + failure for failure in failures), file=sys.stderr, flush=True)
    sys.exit(1)
