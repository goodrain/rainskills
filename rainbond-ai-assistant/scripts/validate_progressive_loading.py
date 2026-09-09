#!/usr/bin/env python3

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    assert len(skill.splitlines()) <= 150
    assert len(skill.encode("utf-8")) <= 7_000
    assert "不得一次性读取全部" in skill
    links = set()
    for part in skill.split("("):
        if part.startswith("references/") and ".md)" in part:
            links.add(part.split(")", 1)[0])
    assert len(links) >= 15
    for relative in links:
        assert (ROOT / relative).is_file(), relative
    print("PASS: AI Engine progressive loading")
    return 0


if __name__ == "__main__":
    sys.exit(main())

