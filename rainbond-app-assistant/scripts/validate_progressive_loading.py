#!/usr/bin/env python3

"""Validate progressive disclosure for the Rainbond App Assistant skill."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


DEFAULT_SKILL_DIR = Path(__file__).resolve().parents[1]
APP_INITIAL_STAGE = (
    "| 初始部署或首次 Rainbond 操作 | 本根入口、"
    "[own runtime gate](references/runtime-gate.md)、"
    "[routing](references/routing.md) | 其余全部 |"
)
APP_OPERATION_STAGE = (
    "| operation/context 已建立，需要编排或执行 | "
    "[workflow rules](references/workflow-rules.md)；仅在核对路线或复盘时读取 "
    "[operational reference](references/operational-reference.md) | 输出与对象细节 |"
)


def require(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def validate_progressive_loading(skill_dir: Path) -> list[str]:
    failures: list[str] = []
    root_path = skill_dir / "SKILL.md"
    runtime_gate = skill_dir / "references" / "runtime-gate.md"
    root = root_path.read_text(encoding="utf-8")
    root_bytes = len(root.encode("utf-8"))
    root_lines = len(root.splitlines())

    require(root_bytes <= 7_000, f"root is too large: {root_bytes} bytes", failures)
    require(root_lines <= 150, f"root is too long: {root_lines} lines", failures)
    require(
        "所有 reference 必须按需加载；不得一次性加载全部 references，也不得提前读取无关 reference。"
        in root,
        "root must explicitly require on-demand reference loading",
        failures,
    )
    require(
        "任何 Rainbond 查询、环境连接、平台安装或变更前，必须先读取 references/runtime-gate.md。"
        in root,
        "root must require its runtime gate before Rainbond access",
        failures,
    )
    require(
        "当前项目或用户明确给出的源码 Git URL：由本 Skill 接管。" in root,
        "root must own current projects and explicit source Git URLs",
        failures,
    )

    references = {
        "references/runtime-gate.md": "runtime gate",
        "references/routing.md": "routing",
        "references/workflow-rules.md": "workflow rules",
        "references/operational-reference.md": "operational reference",
        "references/output-contract.md": "output contract",
        "references/product-object-model.md": "product object model",
    }
    for relative_path, label in references.items():
        require(relative_path in root, f"root must discover {label}", failures)
        require((skill_dir / relative_path).is_file(), f"missing {relative_path}", failures)

    require(APP_INITIAL_STAGE in root, "App initial stage mapping is invalid", failures)
    require(APP_OPERATION_STAGE in root, "App operation/context stage mapping is invalid", failures)
    if APP_INITIAL_STAGE in root and APP_OPERATION_STAGE in root:
        require(
            root.index(APP_INITIAL_STAGE) < root.index(APP_OPERATION_STAGE),
            "App stage mapping must load the runtime gate before workflow rules",
            failures,
        )

    for required in (
        "首次",
        "401",
        "403",
        "写调用不得自动重放",
        "确认",
        "TTY",
        "停止",
    ):
        require(required in root, f"root is missing required invariant: {required}", failures)

    for forbidden in (
        "rainskills.skill-runtime-contract.v1",
        "rainskills.single-runtime-contract.v1",
        "<!-- rainskills-runtime-gate:start -->",
        '"runtime_status":',
        '"input_commands":',
        "## High-Level Workflow",
    ):
        require(forbidden not in root, f"root embeds staged content: {forbidden}", failures)

    require(runtime_gate.is_file(), "missing references/runtime-gate.md", failures)
    if runtime_gate.is_file():
        gate = runtime_gate.read_text(encoding="utf-8")
        for required in (
            "rainskills.skill-runtime-contract.v1",
            "<!-- rainskills-runtime-gate:start -->",
            "<!-- rainskills-runtime-gate:end -->",
            "<!-- rainskills-runtime-routing:start -->",
            "<!-- rainskills-runtime-routing:end -->",
            "rainskills.single-runtime-contract.v1",
            "rainskills-tools.js",
            "tty: true",
            "401",
            "403",
            "new-application-environment",
        ):
            require(required in gate, f"runtime gate is missing: {required}", failures)

    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skill-dir", type=Path, default=DEFAULT_SKILL_DIR)
    args = parser.parse_args()
    failures = validate_progressive_loading(args.skill_dir.resolve())

    if failures:
        print("FAIL: progressive loading invalid")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("PASS: progressive loading valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
