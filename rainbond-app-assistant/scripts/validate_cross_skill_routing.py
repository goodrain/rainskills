#!/usr/bin/env python3

"""Validate mutually exclusive routing for the two deployment entry skills."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


DEFAULT_REPO_ROOT = Path(__file__).resolve().parents[2]
APP_DESCRIPTION_OWNER = (
    "Use whenever a user asks to deploy, run, deliver, publish, inspect, repair, or "
    "troubleshoot source code, the current project, a source directory/package, a bare "
    "Git repository URL without a supplied Compose/Helm/image-set descriptor, or a named "
    "application without a descriptor."
)
APP_DESCRIPTION_DESCRIPTOR_EXCLUSION = (
    "Not for supplied third-party Compose, Helm, or image-set descriptors; use "
    "rainbond-opensource-app-deploy."
)
APP_DESCRIPTION_MARKET_EXCLUSION = (
    "Not for a confirmed market template; use rainbond-template-installer."
)
OPEN_DESCRIPTION_OWNER = (
    "Use only when the user actually supplies a third-party Docker Compose file/content, "
    "Helm chart/values, or container image-set descriptor."
)
OPEN_DESCRIPTION_EXCLUSIONS = (
    "Never use for a bare Git URL, source project/directory/package, named application "
    "without a descriptor, private-image project, or confirmed market template; route "
    "source and named-only requests to rainbond-app-assistant and market templates to "
    "rainbond-template-installer."
)
OPEN_DESCRIPTOR_GUARD = (
    "未确认描述符时不得读取 references/runtime-gate.md；也不得加载任何 reference、"
    "查询/连接环境、安装平台、调用 Rainbond、克隆或浏览 Git、读取外部文档或做任何变更。"
)
OPEN_STAGE_ROWS = (
    "| Phase 0：描述符未确认 | 不加载 reference；只做上述静态资格判断 |",
    "| 描述符已确认，首次需要连接或调用 Rainbond | 只读取自己的 "
    "[runtime gate](references/runtime-gate.md) |",
    "| operation/context 已建立，需要建模、部署、排障或交付 | 读取 "
    "[deployment workflow](references/deployment-workflow.md) |",
    "| 新鲜证据命中已知部署故障模式 | 再读取 "
    "[failure-mode playbook](references/failure-mode-playbook.md) |",
)


def require(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def description(source: str) -> str:
    match = re.search(r'^description:\s*["\']?(.*?)["\']?\s*$', source, re.MULTILINE)
    return match.group(1) if match else ""


def validate_cross_skill_routing(repo_root: Path) -> list[str]:
    failures: list[str] = []
    app_dir = repo_root / "rainbond-app-assistant"
    open_dir = repo_root / "rainbond-opensource-app-deploy"
    app_root = (app_dir / "SKILL.md").read_text(encoding="utf-8")
    open_root = (open_dir / "SKILL.md").read_text(encoding="utf-8")
    app_description = description(app_root)
    open_description = description(open_root)

    for required, message in (
        (APP_DESCRIPTION_OWNER, "App description must positively own source and descriptor-less requests"),
        (APP_DESCRIPTION_DESCRIPTOR_EXCLUSION, "App description must exclude supplied descriptors"),
        (APP_DESCRIPTION_MARKET_EXCLUSION, "App description must exclude confirmed market templates"),
    ):
        require(required in app_description, message, failures)
    for required, message in (
        (OPEN_DESCRIPTION_OWNER, "Open-source description must positively own only supplied descriptors"),
        (OPEN_DESCRIPTION_EXCLUSIONS, "Open-source description must exclude source, named-only, and market routes"),
    ):
        require(required in open_description, message, failures)

    open_bytes = len(open_root.encode("utf-8"))
    open_lines = len(open_root.splitlines())
    require(open_bytes <= 6_500, f"Open-source root is too large: {open_bytes} bytes", failures)
    require(open_lines <= 140, f"Open-source root is too long: {open_lines} lines", failures)

    for label, root in (("App", app_root), ("Open-source", open_root)):
        for forbidden in (
            "rainskills.skill-runtime-contract.v1",
            "rainskills.single-runtime-contract.v1",
            "<!-- rainskills-runtime-gate:start -->",
            '"runtime_status":',
            '"input_commands":',
        ):
            require(forbidden not in root, f"{label} root embeds runtime content: {forbidden}", failures)

    require(
        "核心顺序是：先验证描述符，再加载 Runtime Gate；不得为了确认资格而接触 Rainbond 或外部源码。"
        in open_root,
        "Open-source root must state descriptor-before-gate ordering",
        failures,
    )
    require(OPEN_DESCRIPTOR_GUARD in open_root, "Open-source descriptor guard is missing or reversed", failures)
    for forbidden in (
        "未确认描述符时允许读取 references/runtime-gate.md",
        "## 0. Derive the official topology",
        "## 6. Pass the delivery gate",
        "## Progress checklist",
    ):
        require(forbidden not in open_root, f"Open-source root contains forbidden staged content: {forbidden}", failures)

    for row in OPEN_STAGE_ROWS:
        require(row in open_root, f"Open-source stage mapping is invalid: {row}", failures)
    if all(row in open_root for row in OPEN_STAGE_ROWS):
        positions = [open_root.index(row) for row in OPEN_STAGE_ROWS]
        require(
            positions == sorted(positions),
            "Open-source stages must progress from static qualification to gate, workflow, then playbook",
            failures,
        )

    for label, skill_dir in (("App", app_dir), ("Open-source", open_dir)):
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

    deployment_workflow = open_dir / "references" / "deployment-workflow.md"
    failure_playbook = open_dir / "references" / "failure-mode-playbook.md"
    require(deployment_workflow.is_file(), "missing deployment-workflow.md", failures)
    require(failure_playbook.is_file(), "missing failure-mode-playbook.md", failures)
    if deployment_workflow.is_file():
        workflow = deployment_workflow.read_text(encoding="utf-8")
        require("## 0. Derive the official topology" in workflow, "deployment workflow lacks phase 0", failures)
        require("## 6. Pass the delivery gate" in workflow, "deployment workflow lacks delivery gate", failures)

    openai_yaml = (open_dir / "agents" / "openai.yaml").read_text(encoding="utf-8")
    require(
        'short_description: "Only supplied Compose, Helm, or image-set descriptors"' in openai_yaml,
        "Open-source short_description is not the required value",
        failures,
    )

    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=DEFAULT_REPO_ROOT)
    args = parser.parse_args()
    failures = validate_cross_skill_routing(args.repo_root.resolve())

    if failures:
        print("FAIL: cross-skill routing is not mutually exclusive")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("PASS: cross-skill routing is mutually exclusive")
    return 0


if __name__ == "__main__":
    sys.exit(main())
