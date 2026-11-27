"""Bounded dev-server supervisor. Survives DO eviction, but never its own TTL."""
import os
import signal
import subprocess
import sys
import time

stopping = False


def stop(_signum, _frame):
    global stopping
    stopping = True


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
deadline = time.monotonic() + float(sys.argv[1])
log_path = sys.argv[2]
with open(log_path, "wb"):
    pass
child = subprocess.Popen(
    # The command arrives in $DOLLY_COMMAND, not argv, so pgrep -f/pkill -f
    # patterns from the command cannot match this supervisor or its shell.
    ["bash", "-lc", 'dolly_command=$DOLLY_COMMAND; unset DOLLY_COMMAND; eval "$dolly_command"'],
    start_new_session=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    stdin=subprocess.DEVNULL,
)
os.set_blocking(child.stdout.fileno(), False)
tail = b""


def capture_output():
    global tail
    updated = False
    # Bound work per turn so a noisy server cannot starve the TTL check.
    for _ in range(16):
        try:
            chunk = os.read(child.stdout.fileno(), 4096)
        except BlockingIOError:
            break
        if not chunk:
            break
        tail = (tail + chunk)[-32768:]
        updated = True
    if updated:
        with open(log_path, "wb") as log:
            log.write(tail)


try:
    while not stopping and time.monotonic() < deadline:
        # Keep the leader unreaped until group cleanup, preventing PGID reuse.
        if os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT):
            # A short-lived failure can exit before its first selector event.
            capture_output()
            break
        capture_output()
        time.sleep(0.1)
finally:
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(child.pid, sig)
        except ProcessLookupError:
            pass
        if sig == signal.SIGTERM:
            time.sleep(1)
    child.wait()
