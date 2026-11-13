"""Supervise a command group so Worker cancellation cannot orphan Git children."""
import os
import signal
import subprocess
import sys
import time

stopping = 0


def stop(signum, _frame):
    # Do not raise during Popen: cancellation must also cover the spawn window.
    global stopping
    stopping = signum


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
child = subprocess.Popen(["sh", "-lc", sys.argv[1]], start_new_session=True)


def signal_group(signum):
    try:
        os.killpg(child.pid, signum)
    except ProcessLookupError:
        pass


while not stopping:
    # Observe exit without reaping: a cancelled group's PID cannot be reused
    # between TERM and KILL, even if its shell exits before its Git children.
    if os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT):
        break
    time.sleep(0.05)

if stopping:
    signal_group(signal.SIGTERM)
    # Keep the group leader unreaped until escalation, preventing PID/PGID reuse.
    time.sleep(1)
    signal_group(signal.SIGKILL)
    child.wait()
    sys.exit(128 + stopping)

code = child.wait()
sys.exit(code if code >= 0 else 128 - code)
