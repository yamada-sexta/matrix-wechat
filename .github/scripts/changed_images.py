import json
import os
from pathlib import Path
import subprocess


def changed_images(paths, force=False):
    selected = set()
    shared = {
        "package.json", "bun.lock", ".dockerignore", ".gitignore",
        ".github/workflows/ci.yml",
        "packages/matrix-bridge/package.json",
        "packages/wechat-runtime/package.json",
    }
    for path in paths:
        if path.endswith(".md"):
            continue
        if path in shared or path.startswith(("packages/wechat-rpc/", ".github/scripts/")):
            selected.update(("matrix-bridge", "wechat-runtime"))
        elif path == "example-config.yaml" or path.startswith("packages/matrix-bridge/"):
            selected.add("matrix-bridge")
        elif path.startswith(("packages/wechat-runtime/", "packages/wechat-native/")):
            selected.add("wechat-runtime")
    if force:
        selected.update(("matrix-bridge", "wechat-runtime"))
    return {"include": [
        {"package": package, "suffix": "" if package == "matrix-bridge" else "-runtime"}
        for package in ("matrix-bridge", "wechat-runtime") if package in selected
    ]}


def changed_paths(event_name, event):
    if event_name == "pull_request":
        base = event["pull_request"]["base"]["sha"]
        head = event["pull_request"]["head"]["sha"]
        base = subprocess.check_output(["git", "merge-base", base, head], text=True).strip()
    elif event_name == "push":
        base, head = event["before"], event["after"]
        if not base.strip("0"):
            return subprocess.check_output(["git", "ls-files", "-z"]).decode().split("\0")
    else:
        raise ValueError("Build both images for an unknown event")
    return subprocess.check_output(
        ["git", "diff", "--name-only", "--no-renames", "-z", base, head, "--"]
    ).decode().split("\0")


def main():
    event_name = os.environ["GITHUB_EVENT_NAME"]
    force = event_name == "workflow_dispatch" or os.environ["GITHUB_REF"].startswith("refs/tags/")
    paths = []
    if not force:
        try:
            event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
            paths = changed_paths(event_name, event)
        except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
            print(f"::notice::Change detection unavailable ({type(error).__name__}); building both images")
            force = True
    matrix = changed_images(paths, force)
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write("matrix=" + json.dumps(matrix, separators=(",", ":")) + "\n")
        output.write("build=" + str(bool(matrix["include"])).lower() + "\n")
    print("Selected image builds:", ", ".join(row["package"] for row in matrix["include"]) or "none")


if __name__ == "__main__":
    main()
