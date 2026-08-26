#!/usr/bin/env python3

"""Validate progressive disclosure for the Rainbond App Assistant skill."""

from __future__ import annotations

import sys
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
ROOT = SKILL_DIR / "SKILL.md"
RUNTIME_GATE = SKILL_DIR / "references" / "runtime-gate.md"


def require(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def main() -> int:
    failures: list[str] = []
    root = ROOT.read_text(encoding="utf-8")
    root_bytes = len(root.encode("utf-8"))
    root_lines = len(root.splitlines())

    require(root_bytes <= 7_000, f"root is too large: {root_bytes} bytes", failures)
    require(root_lines <= 150, f"root is too long: {root_lines} lines", failures)
    require(
        "不得一次性加载全部 references" in root,
        "root must forbid eagerly loading every reference",
        failures,
    )
    require(
        "任何 Rainbond 查询、环境连接、平台安装或变更前，必须先读取 references/runtime-gate.md"
        in root,
        "root must require its runtime gate before Rainbond access",
        failures,
    )
    require(
        "当前项目或用户明确给出的源码 Git URL：由本 Skill 接管" in root,
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
        require((SKILL_DIR / relative_path).is_file(), f"missing {relative_path}", failures)

    for required in (
        "初始部署",
        "operation/context",
        "按需",
        "不得提前读取无关 reference",
        "首次",
        "401",
        "403",
        "写调用不得自动重放",
        "确认",
        "TTY",
        "停止",
    ):
        require(required in root, f"root is missing required invariant: {required}", failures)

    require(
        "rainskills.single-runtime-contract.v1" not in root,
        "root must not embed the runtime contract",
        failures,
    )
    require(RUNTIME_GATE.is_file(), "missing references/runtime-gate.md", failures)
    if RUNTIME_GATE.is_file():
        gate = RUNTIME_GATE.read_text(encoding="utf-8")
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

    if failures:
        print("FAIL: progressive loading invalid")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("PASS: progressive loading valid")
    return 0


if __name__ == "__main__":
    sys.exit(main())
