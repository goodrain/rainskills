#!/usr/bin/env python3

"""Deterministic routing-policy evals for generic Rainbond skill prompts."""

from __future__ import annotations

import argparse
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
SKILL_FILES = {
    "rainbond-app-assistant": ROOT / "rainbond-app-assistant" / "SKILL.md",
    "rainbond-fullstack-bootstrap": ROOT / "rainbond-fullstack-bootstrap" / "SKILL.md",
    "rainbond-fullstack-troubleshooter": ROOT / "rainbond-fullstack-troubleshooter" / "SKILL.md",
    "rainbond-delivery-verifier": ROOT / "rainbond-delivery-verifier" / "SKILL.md",
}
POLICY_FILE = ROOT / "rainbond-app-assistant" / "references" / "transport-resolution.md"
BUSINESS_SKILL_FILES = sorted(ROOT.glob("rainbond-*/SKILL.md"))


def classify_prompt(prompt: str) -> str | None:
    text = prompt.lower().strip()

    explicit_names = {
        "rainbond-app-assistant": ["$rainbond-app-assistant", "rainbond-app-assistant"],
        "rainbond-fullstack-bootstrap": ["$rainbond-fullstack-bootstrap", "rainbond-fullstack-bootstrap"],
        "rainbond-fullstack-troubleshooter": [
            "$rainbond-fullstack-troubleshooter",
            "rainbond-fullstack-troubleshooter",
        ],
        "rainbond-delivery-verifier": ["$rainbond-delivery-verifier", "rainbond-delivery-verifier"],
    }
    for skill, needles in explicit_names.items():
        if any(needle in text for needle in needles):
            return skill

    bootstrap_needles = [
        "只帮我创建应用和组件",
        "只创建应用和组件",
        "create app and components",
        "create topology",
        "bootstrap only",
    ]
    if any(needle in text for needle in bootstrap_needles):
        return "rainbond-fullstack-bootstrap"

    troubleshoot_needles = [
        "为什么构建失败",
        "构建失败",
        "先查事件和构建日志",
        "why build failed",
        "build failure",
    ]
    if any(needle in text for needle in troubleshoot_needles):
        return "rainbond-fullstack-troubleshooter"

    delivery_needles = [
        "交付成功",
        "访问地址",
        "是否已经交付成功",
        "delivery complete",
        "verify delivery",
    ]
    if any(needle in text for needle in delivery_needles):
        return "rainbond-delivery-verifier"

    generic_app_assistant_needles = [
        "部署到 rainbond",
        "部署到rainbond",
        "帮我把这个项目跑起来",
        "帮我看看当前项目卡在哪",
        "如果还没初始化就先初始化",
        "自动继续到应该停止的位置",
        "continue to the right stop point",
    ]
    if any(needle in text for needle in generic_app_assistant_needles):
        return "rainbond-app-assistant"

    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Run deterministic routing-policy evals for Rainbond skill prompts.")
    parser.add_argument(
        "--fixtures",
        type=Path,
        default=ROOT / "tests" / "skill-routing-fixtures.yaml",
        help="Path to routing eval fixtures.",
    )
    args = parser.parse_args()

    payload = yaml.safe_load(args.fixtures.read_text(encoding="utf-8"))
    cases = payload.get("cases", [])
    transport_cases = payload.get("transport_cases", [])
    required_markers = payload.get("required_markers", {})
    forbidden_operational_markers = payload.get("forbidden_operational_markers", [])

    failures = 0
    for skill_name, markers in required_markers.items():
        skill_path = SKILL_FILES[skill_name]
        text = skill_path.read_text(encoding="utf-8")
        for marker in markers:
            if marker not in text:
                print(f"FAIL marker {skill_name}")
                print(f"  - missing marker: {marker}")
                failures += 1

    for case in cases:
        predicted = classify_prompt(case["prompt"])
        expected = case["expected_skill"]
        if predicted != expected:
            print(f"FAIL {case['id']}")
            print(f"  - expected {expected}, got {predicted}")
            failures += 1
            continue
        print(f"PASS {case['id']}")

    policy = POLICY_FILE.read_text(encoding="utf-8")
    top_skill = SKILL_FILES["rainbond-app-assistant"].read_text(encoding="utf-8")
    documents = {"policy": policy, "app-assistant": top_skill}
    for case in transport_cases:
        case_failed = False
        for document_name, markers in case["required_markers"].items():
            text = documents[document_name]
            for marker in markers:
                if marker not in text:
                    print(f"FAIL {case['id']}")
                    print(f"  - {document_name} missing semantic marker: {marker}")
                    failures += 1
                    case_failed = True
        if not case_failed:
            print(f"PASS {case['id']} -> {case['expected_state']}")

    for skill_path in BUSINESS_SKILL_FILES:
        text = skill_path.read_text(encoding="utf-8")
        for marker in forbidden_operational_markers:
            if marker in text:
                print(f"FAIL operational MCP-only marker {skill_path.parent.name}")
                print(f"  - forbidden marker: {marker}")
                failures += 1

    if failures:
        print(f"\n{failures} routing eval(s) failed.")
        return 1

    print(
        f"\nAll {len(cases)} skill routing fixture(s), {len(transport_cases)} transport fixture(s), "
        f"and {sum(len(v) for v in required_markers.values())} routing marker check(s) passed."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
