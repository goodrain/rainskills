#!/usr/bin/env python3

"""Shared checks for customer-facing Rainskills replies."""

from __future__ import annotations

import re
from typing import Any


FORBIDDEN_INTERNAL_PATTERNS = (
    r"(?m)^### (?:Structured Output|Project State|Actions Performed|Current Health|Blocking Issue)$",
    r"(?m)^### (?:Creation Result|Actions Taken|Current State|Handoff Recommendation)$",
    r"(?m)^### (?:Problem Judgment|Verification Result|Follow-up Advice)$",
    r"(?m)^### (?:Deployment State|Component Runtime|Access URL)$",
    r"(?s)```(?:yaml|yml|json)\s*\n",
    r"\b(?:AppAssistantResult|BootstrapResult|TroubleshootResult|DeliveryVerificationResult)\b",
    r"\b(?:ProjectInitResult|TemplateInstallResult|EnvironmentSyncResult|VersionCenterSession)\b",
    r"\b(?:orchestration_state|runtime_state|delivery_state|blocking_bucket|next_handoff)\b",
    r"\brainbond_(?:query|get|create|manage|operate|install|update|submit|complete|wait)_[a-z0-9_]+\b",
    r"\brainbond-(?:app|fullstack|delivery|project|template|env)-[a-z0-9-]+\b",
)

SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(?:password|secret|token|api[_-]?key|private[_-]?key|authorization|cookie)\b"
    r"[^\n:=]{0,32}[:=]\s*(.+)$"
)

MASKED_VALUES = {"***", "[masked]", "<masked>", "redacted", "<redacted>", "null"}

SUCCESSFUL_DEPLOYMENT_NEXT_ACTIONS = """你接下来可以：

1. 修改代码并重新部署
2. 将当前应用创建快照发布版本，用于部署到生产环境
3. 查看运行日志
4. 将应用迁移到自己的 Rainbond"""

SUCCESSFUL_DEPLOYMENT_PATTERN = re.compile(
    r"(?m)^部署成功(?:，待浏览器访问确认)?。$"
)


def validate_customer_output(response_text: str, expected: dict[str, Any] | None = None) -> list[str]:
    errors: list[str] = []

    if not re.search(r"[\u3400-\u9fff]", response_text):
        errors.append("customer response must use concise Chinese")

    for pattern in FORBIDDEN_INTERNAL_PATTERNS:
        if re.search(pattern, response_text, flags=re.IGNORECASE):
            errors.append(f"customer response exposes internal contract content matching {pattern!r}")

    for line in response_text.splitlines():
        match = SECRET_ASSIGNMENT.search(line.strip())
        if not match:
            continue
        value = match.group(1).strip().strip("'\"")
        if value.lower() not in MASKED_VALUES and not value.startswith("$"):
            errors.append("customer response appears to expose secret material")
            break

    if SUCCESSFUL_DEPLOYMENT_PATTERN.search(response_text):
        if response_text.count(SUCCESSFUL_DEPLOYMENT_NEXT_ACTIONS) != 1:
            errors.append(
                "successful deployment response must contain the four customer next actions exactly once"
            )
        if not response_text.rstrip().endswith(SUCCESSFUL_DEPLOYMENT_NEXT_ACTIONS):
            errors.append("successful deployment response must end with the customer next actions")

    assertions = (expected or {}).get("assert", {})
    for needle in assertions.get("prose_contains", []):
        if needle not in response_text:
            errors.append(f"customer response is missing required text: {needle!r}")
    for needle in assertions.get("prose_not_contains", []):
        if needle in response_text:
            errors.append(f"customer response contains forbidden text: {needle!r}")

    return errors
