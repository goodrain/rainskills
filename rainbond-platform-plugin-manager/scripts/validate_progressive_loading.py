#!/usr/bin/env python3

from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
EXPECTED = {"runtime-gate.md", "plugin-discovery.md", "plugin-lifecycle.md", "recovery.md", "output-contract.md"}


def main() -> int:
    skill = (ROOT / "SKILL.md").read_text(encoding="utf-8")
    assert len(skill.splitlines()) <= 150
    assert len(skill.encode("utf-8")) <= 7_000
    assert "不得一次性读取全部" in skill
    for name in EXPECTED:
        assert (ROOT / "references" / name).is_file()
        assert f"references/{name}" in skill
    print("PASS: platform plugin progressive loading")
    return 0


if __name__ == "__main__":
    sys.exit(main())

