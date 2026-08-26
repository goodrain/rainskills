#!/usr/bin/env python3

"""Validate mutually exclusive routing for the two deployment entry skills."""

from __future__ import annotations

import re
import sys
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
APP_DIR = REPO_ROOT / "rainbond-app-assistant"
OPEN_DIR = REPO_ROOT / "rainbond-opensource-app-deploy"


def require(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def description(source: str) -> str:
    match = re.search(r'^description:\s*["\']?(.*?)["\']?\s*$', source, re.MULTILINE)
    return match.group(1) if match else ""


def main() -> int:
    failures: list[str] = []
    app_root = (APP_DIR / "SKILL.md").read_text(encoding="utf-8")
    open_root = (OPEN_DIR / "SKILL.md").read_text(encoding="utf-8")
    app_description = description(app_root).lower()
    open_description = description(open_root).lower()

    for required in (
        "deploy",
        "run",
        "deliver",
        "inspect",
        "repair",
        "troubleshoot",
        "source",
        "current project",
        "git",
        "named",
        "without",
        "descriptor",
    ):
        require(required in app_description, f"App description is missing boundary: {required}", failures)
    for required in ("compose", "helm", "image", "descriptor", "only", "bare git", "source", "named", "market"):
        require(required in open_description, f"Open-source description is missing boundary: {required}", failures)
    require(
        "rainbond-opensource-app-deploy" in app_description,
        "App description must route supplied descriptors to Open-source Deploy",
        failures,
    )
    require(
        "rainbond-app-assistant" in open_description,
        "Open-source description must route source and descriptor-less requests to App Assistant",
        failures,
    )
    require(
        "rainbond-template-installer" in app_description
        and "rainbond-template-installer" in open_description,
        "both descriptions must exclude confirmed market templates",
        failures,
    )

    for label, root in (("App", app_root), ("Open-source", open_root)):
        require(
            "rainskills.single-runtime-contract.v1" not in root,
            f"{label} root must not embed the runtime contract",
            failures,
        )

    for label, skill_dir in (("App", APP_DIR), ("Open-source", OPEN_DIR)):
        gate_path = skill_dir / "references" / "runtime-gate.md"
        require(gate_path.is_file(), f"{label} runtime gate is missing", failures)
        if gate_path.is_file():
            gate = gate_path.read_text(encoding="utf-8")
            require(
                "rainskills.skill-runtime-contract.v1" in gate,
                f"{label} runtime gate lacks the progressive-loading contract marker",
                failures,
            )
            require(
                "rainskills.single-runtime-contract.v1" in gate,
                f"{label} runtime gate lacks its contract",
                failures,
            )

    for required in (
        "Phase 0",
        "静态",
        "描述符",
        "未确认",
        "不得读取 references/runtime-gate.md",
        "references/runtime-gate.md",
        "references/deployment-workflow.md",
        "references/failure-mode-playbook.md",
        "operation/context",
    ):
        require(required in open_root, f"Open-source root is missing staged routing: {required}", failures)

    deployment_workflow = OPEN_DIR / "references" / "deployment-workflow.md"
    failure_playbook = OPEN_DIR / "references" / "failure-mode-playbook.md"
    require(deployment_workflow.is_file(), "missing deployment-workflow.md", failures)
    require(failure_playbook.is_file(), "missing failure-mode-playbook.md", failures)
    if deployment_workflow.is_file():
        workflow = deployment_workflow.read_text(encoding="utf-8")
        require("## 0. Derive the official topology" in workflow, "deployment workflow lacks phase 0", failures)
        require("## 6. Pass the delivery gate" in workflow, "deployment workflow lacks delivery gate", failures)

    openai_yaml = (OPEN_DIR / "agents" / "openai.yaml").read_text(encoding="utf-8")
    require(
        'short_description: "Only supplied Compose, Helm, or image-set descriptors"' in openai_yaml,
        "Open-source short_description is not the required value",
        failures,
    )

    if failures:
        print("FAIL: cross-skill routing is not mutually exclusive")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("PASS: cross-skill routing is mutually exclusive")
    return 0


if __name__ == "__main__":
    sys.exit(main())
