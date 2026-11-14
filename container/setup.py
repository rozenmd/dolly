"""Best-effort repository setup, adapted to the sandbox's ordinary local checkout."""
import json
import os
from pathlib import Path
import subprocess

hook = Path(".agents/setup")
if hook.is_file():
    subprocess.run(["./" + str(hook)] if os.access(hook, os.X_OK) else ["sh", str(hook)], check=True)

manifest = Path("package.json")
if manifest.is_file():
    package = json.loads(manifest.read_text())
    manager = package.get("packageManager", "").split("@")[0]
    if not manager:
        manager = "pnpm" if Path("pnpm-lock.yaml").exists() else "yarn" if Path("yarn.lock").exists() else "npm"
    if manager == "pnpm":
        command = ["corepack", "pnpm", "install", "--frozen-lockfile"] if Path("pnpm-lock.yaml").exists() else ["corepack", "pnpm", "install"]
    elif manager == "yarn":
        command = ["corepack", "yarn", "install"]
    elif manager == "npm":
        command = ["npm", "ci" if Path("package-lock.json").exists() else "install"]
    else:
        raise RuntimeError("Automatic dependency setup does not support " + manager)
    subprocess.run(command, check=True)
