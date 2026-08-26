#!/usr/bin/env python3

"""Route fixtures against the descriptions in real Rainbond Skill frontmatter."""

from __future__ import annotations

import argparse
from pathlib import Path
import re

import yaml


ROOT = Path(__file__).resolve().parents[1]
SKILL_FILES = {
    "rainbond-app-assistant": ROOT / "rainbond-app-assistant" / "SKILL.md",
    "rainbond-fullstack-bootstrap": ROOT / "rainbond-fullstack-bootstrap" / "SKILL.md",
    "rainbond-fullstack-troubleshooter": ROOT / "rainbond-fullstack-troubleshooter" / "SKILL.md",
    "rainbond-delivery-verifier": ROOT / "rainbond-delivery-verifier" / "SKILL.md",
    "rainbond-platform-query": ROOT / "rainbond-platform-query" / "SKILL.md",
    "rainbond-app-version-assistant": ROOT / "rainbond-app-version-assistant" / "SKILL.md",
    "rainbond-env-sync": ROOT / "rainbond-env-sync" / "SKILL.md",
    "rainbond-project-init": ROOT / "rainbond-project-init" / "SKILL.md",
    "rainbond-template-installer": ROOT / "rainbond-template-installer" / "SKILL.md",
    "rainbond-opensource-app-deploy": ROOT / "rainbond-opensource-app-deploy" / "SKILL.md",
}


def parse_frontmatter(skill_path: Path) -> dict[str, str]:
    text = skill_path.read_text(encoding="utf-8")
    match = re.match(r"\A---\s*\n(.*?)\n---\s*\n", text, re.DOTALL)
    if not match:
        raise ValueError(f"missing YAML frontmatter: {skill_path}")
    metadata = yaml.safe_load(match.group(1))
    if not isinstance(metadata, dict) or set(metadata) != {"name", "description"}:
        raise ValueError(f"frontmatter must contain only name and description: {skill_path}")
    if metadata["name"] != skill_path.parent.name or not isinstance(metadata["description"], str):
        raise ValueError(f"invalid Skill frontmatter: {skill_path}")
    return metadata


def skill_contract_text(skill_path: Path) -> str:
    texts = [skill_path.read_text(encoding="utf-8")]
    references = skill_path.parent / "references"
    if references.is_dir():
        texts.extend(
            path.read_text(encoding="utf-8")
            for path in sorted(references.glob("*.md"))
        )
    return "\n".join(texts)


def normalize(value: str) -> str:
    return "".join(character.lower() for character in value if character.isalnum())


def common_substring_coverage(prompt: str, description: str) -> float:
    left = normalize(prompt)
    right = normalize(description)
    if not left:
        return 0.0
    previous = [0] * (len(right) + 1)
    longest = 0
    for left_character in left:
        current = [0]
        for index, right_character in enumerate(right, start=1):
            length = previous[index - 1] + 1 if left_character == right_character else 0
            current.append(length)
            longest = max(longest, length)
        previous = current
    return longest / len(left)


def classify_prompt(prompt: str, metadata_by_skill: dict[str, dict[str, str]]) -> str | None:
    text = prompt.lower().strip()
    explicit = [name for name in metadata_by_skill if f"${name}" in text or name in text]
    if len(explicit) == 1:
        return explicit[0]
    if explicit:
        return None

    platform_query_needles = [
        "当前企业",
        "当前登录的用户",
        "有哪些团队",
        "有哪些集群",
        "团队里的应用",
        "应用有哪些组件",
        "current enterprise",
        "current user",
        "list teams",
        "list regions",
        "list apps",
        "list components",
    ]
    if any(needle in text for needle in platform_query_needles):
        return "rainbond-platform-query"

    open_source_descriptor_needles = [
        "docker-compose",
        "docker compose",
        "compose 文件",
        "compose file",
        "helm chart",
        "helm 图表",
        "镜像清单",
        "image set",
    ]
    if any(needle in text for needle in open_source_descriptor_needles):
        return "rainbond-opensource-app-deploy"

    if "harbor" in text:
        return "rainbond-app-assistant"

    scores = sorted(
        (
            common_substring_coverage(prompt, metadata["description"]),
            name,
        )
        for name, metadata in metadata_by_skill.items()
    )
    best_score, best_name = scores[-1]
    if best_score < 0.35 or (len(scores) > 1 and best_score == scores[-2][0]):
        return None
    return best_name


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
    required_markers = payload.get("required_markers", {})
    metadata_by_skill = {
        name: parse_frontmatter(skill_path)
        for name, skill_path in SKILL_FILES.items()
    }

    failures = 0
    for skill_name, markers in required_markers.items():
        skill_path = SKILL_FILES[skill_name]
        text = skill_contract_text(skill_path)
        for marker in markers:
            if marker not in text:
                print(f"FAIL marker {skill_name}")
                print(f"  - missing marker: {marker}")
                failures += 1

    for case in cases:
        predicted = classify_prompt(case["prompt"], metadata_by_skill)
        expected = case["expected_skill"]
        if predicted != expected:
            print(f"FAIL {case['id']}")
            print(f"  - expected {expected}, got {predicted}")
            failures += 1
            continue
        print(f"PASS {case['id']}")

    if failures:
        print(f"\n{failures} routing eval(s) failed.")
        return 1

    print(f"\nAll {len(cases)} routing fixture(s) and {sum(len(v) for v in required_markers.values())} marker check(s) passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
