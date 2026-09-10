#!/usr/bin/env python3

"""Validate the two AI Engine source Skills and their embedded projection."""

from __future__ import annotations

import json
from pathlib import Path
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
SKILLS = {
    "rainbond-platform-plugin-manager": {
        "plugin-discovery.md",
        "plugin-lifecycle.md",
        "recovery.md",
        "output-contract.md",
    },
    "rainbond-ai-assistant": {
        "context-and-permissions.md",
        "model-discovery.md",
        "model-download.md",
        "instance-deployment.md",
        "cpu-deployment.md",
        "deployment-diagnostics.md",
        "gpu-provider-and-capacity.md",
        "advanced-vllm-arguments.md",
        "model-selection.md",
        "parameter-decision-guide.md",
        "throughput-tuning.md",
        "instance-lifecycle.md",
        "deletion-policy.md",
        "error-recovery.md",
        "output-contract.md",
    },
}
FORBIDDEN_SHARED = (
    "rainskills-tools.js",
    "/console/mcp/",
    "Device Flow",
    "kubectl",
    "backend_service",
    "X-AI-",
)
FORBIDDEN_EMBEDDED = FORBIDDEN_SHARED + (
    "fixed launcher",
    "固定 launcher",
    "require_escalated",
    "~/.rainbond",
)


def main() -> int:
    for skill_id, references in SKILLS.items():
        skill_root = ROOT / skill_id
        root = (skill_root / "SKILL.md").read_text(encoding="utf-8")
        assert len(root.splitlines()) <= 150, skill_id
        assert len(root.encode("utf-8")) <= 7_000, skill_id
        assert "不得一次性读取全部" in root
        assert "references/runtime-gate.md" in root
        for reference in references:
            path = skill_root / "references" / reference
            assert path.is_file(), path
            assert f"references/{reference}" in root
            content = path.read_text(encoding="utf-8")
            for marker in FORBIDDEN_SHARED:
                assert marker not in content, f"{path}: {marker}"

        runtime_gate = (skill_root / "references" / "runtime-gate.md").read_text(encoding="utf-8")
        assert "<!-- rainskills-runtime-gate:start -->" in runtime_gate
        assert "rainskills-tools.js" in runtime_gate

    with tempfile.TemporaryDirectory(prefix="rainskills-ai-profile-") as output:
        result = subprocess.run(
            [
                "node",
                str(ROOT / "scripts" / "build-skill-profile.mjs"),
                "--profile",
                "embedded",
                "--source-root",
                str(ROOT),
                "--output",
                output,
                "--revision",
                "test-ai-engine",
            ],
            check=False,
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, result.stderr or result.stdout
        manifest = json.loads((Path(output) / "rainskills-profile.json").read_text(encoding="utf-8"))
        for skill_id in SKILLS:
            assert skill_id in manifest["skills"]
            for markdown in (Path(output) / skill_id).rglob("*.md"):
                content = markdown.read_text(encoding="utf-8")
                for marker in FORBIDDEN_EMBEDDED:
                    assert marker not in content, f"{markdown}: {marker}"
        assert not list(Path(output).rglob("evals"))
        assert not list(Path(output).rglob("scripts"))

    print("PASS: AI Engine progressive loading and embedded profile")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
