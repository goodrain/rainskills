#!/usr/bin/env python3

"""Run the delivery-verifier validation fixtures end to end."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from validate_delivery_verifier_output import validate_response_file


def main() -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Run all delivery-verifier response fixtures through the deterministic validator."
        )
    )
    parser.add_argument(
        "--eval-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "evals",
        help="Directory containing *.response.md and *.expected.yaml fixture pairs.",
    )
    parser.add_argument(
        "--schema",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "schemas"
        / "delivery-verification-result.schema.yaml",
        help="Path to delivery-verification-result.schema.yaml.",
    )
    args = parser.parse_args()

    eval_dir = args.eval_dir.resolve()
    schema_path = args.schema.resolve()
    response_paths = sorted(eval_dir.glob("*.response.md"))

    if not response_paths:
        print(f"No response fixtures found in {eval_dir}")
        return 1

    failures = 0
    for response_path in response_paths:
        base_name = response_path.name.replace(".response.md", "")
        expected_path = eval_dir / f"{base_name}.expected.yaml"
        if not expected_path.exists():
            print(f"FAIL {response_path}")
            print(f"  - missing expected fixture: {expected_path}")
            failures += 1
            continue

        errors = validate_response_file(
            response_path=response_path,
            schema_path=schema_path,
            expected_path=expected_path,
        )

        if errors:
            print(f"FAIL {response_path}")
            for error in errors:
                print(f"  - {error}")
            failures += 1
            continue

        print(f"PASS {response_path}")

    if failures:
        print(f"\n{failures} fixture set(s) failed.")
        return 1

    print(f"\nAll {len(response_paths)} delivery-verifier fixture set(s) passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
