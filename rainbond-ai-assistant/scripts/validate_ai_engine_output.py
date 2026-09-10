#!/usr/bin/env python3

from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys
import yaml


REQUIRED = {"action", "status", "facts", "blocker", "retryable", "next_action"}
TERMINAL = {"Running", "Stopped", "Failed"}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("response", type=Path)
    parser.add_argument("--structured", action="store_true")
    args = parser.parse_args()
    text = args.response.read_text(encoding="utf-8")
    if not args.structured:
        assert "```yaml" not in text and "```json" not in text
        assert not re.search(r"(?i)(authorization|password|token|secret)\s*[:=]\s*(?!\*{3})\S+", text)
        print("PASS: customer AI Engine output")
        return 0

    match = re.search(r"(?s)```yaml\s*\n(.*?)\n```", text)
    assert match, "structured output requires one yaml block"
    payload = yaml.safe_load(match.group(1))
    assert isinstance(payload, dict) and REQUIRED <= set(payload)
    if payload["status"] in TERMINAL:
        assert payload["status"] != "Running" or payload["blocker"] is None
    for fact in payload["facts"]:
        assert isinstance(fact, dict) and {"source", "summary"} <= set(fact)
    print("PASS: structured AI Engine output")
    return 0


if __name__ == "__main__":
    sys.exit(main())

