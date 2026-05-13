#!/usr/bin/env python3

"""Validate troubleshooter replies and deterministic fixture expectations."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

import yaml


REQUIRED_SECTIONS = [
    "### Problem Judgment",
    "### Actions Taken",
    "### Verification Result",
    "### Follow-up Advice",
    "### Structured Output",
]

CANONICAL_BUCKETS = {
    "db not ready",
    "dependency missing",
    "env naming incompatibility",
    "wrong connection values",
    "api startup issue",
    "frontend access-path issue",
    "source build still running",
    "source build failed",
    "mcp backend issue",
    "external artifact unreachable",
    "cluster capacity blocked",
}

SECRET_KEYWORDS = (
    "password",
    "secret",
    "token",
    "api_key",
    "apikey",
    "private_key",
    "privatekey",
    "certificate",
    "cert",
)

MASKED_VALUES = {"***", "[masked]", "<masked>", "redacted", "<redacted>"}

FORBIDDEN_FALLBACK_PATTERNS = (
    r"\bfallback(?:ed)?\s+to\s+(?:package|image|template)\b",
    r"\bswitched\s+to\s+(?:package|image|template)\b",
    r"\bdefault(?:ed)?\s+to\s+(?:package|image|template)\b",
    r"\bused\s+(?:package|image|template)\s+fallback\b",
)

FORBIDDEN_CODE_HANDOFF_ACTION_PATTERNS = (
    r"\bgo\s+test\b",
    r"\bgo\s+build\b",
    r"\bgo\s+vet\b",
    r"\bnpm\s+(?:test|run|install)\b",
    r"\byarn\s+(?:test|build|install)\b",
    r"\bpnpm\s+(?:test|build|install)\b",
    r"\b(?:ran|run|executed|started|used)\s+docker\s+(?:build|buildx|push|tag|login)\b",
    r"\bopen\s+-a\s+orbstack\b",
    r"\b(?:started|launched|opened)\s+orbstack\b",
    r"\bgit\s+(?:commit|push)\b",
    r"\bcommitted\b",
    r"\bpushed\b",
    r"\bmodified\s+source\b",
    r"\bedited\s+source\b",
)


class ValidationFailure(Exception):
    """Raised when validation cannot continue."""


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    response_path = args.response.resolve()
    schema_path = args.schema.resolve()
    expected_path = args.expected.resolve() if args.expected else None

    errors = validate_response_file(
        response_path=response_path,
        schema_path=schema_path,
        expected_path=expected_path,
    )

    if errors:
        print(f"FAIL {response_path}")
        for error in errors:
            print(f"  - {error}")
        return 1

    print(f"PASS {response_path}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate a troubleshooter markdown reply against TroubleshootResult."
    )
    parser.add_argument("response", type=Path, help="Path to the markdown response file.")
    parser.add_argument(
        "--schema",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "schemas" / "troubleshoot-result.schema.yaml",
        help="Path to troubleshoot-result.schema.yaml.",
    )
    parser.add_argument(
        "--expected",
        type=Path,
        default=None,
        help="Optional fixture-aware assertion file.",
    )
    return parser


def validate_response_file(
    response_path: Path,
    schema_path: Path,
    expected_path: Path | None = None,
) -> list[str]:
    response_text = response_path.read_text(encoding="utf-8")
    schema = load_yaml(schema_path)
    expected = load_yaml(expected_path) if expected_path else None

    errors: list[str] = []

    try:
        sections = parse_required_sections(response_text)
    except ValidationFailure as exc:
        return [str(exc)]

    try:
        structured_yaml = extract_structured_yaml_block(sections["### Structured Output"])
    except ValidationFailure as exc:
        errors.append(str(exc))
        return errors

    try:
        payload = yaml.safe_load(structured_yaml)
    except yaml.YAMLError as exc:
        errors.append(f"structured YAML did not parse: {exc}")
        return errors

    if payload is None:
        errors.append("structured YAML parsed to null; expected a TroubleshootResult object")
        return errors

    errors.extend(check_for_secret_leaks(response_text, structured_yaml, payload))
    errors.extend(validate_schema(payload, schema))

    if not errors:
        errors.extend(validate_troubleshoot_cross_field_rules(payload))
        errors.extend(validate_prose_consistency(sections, payload))

    if expected_path:
        errors.extend(validate_expected_fixture(sections, payload, expected or {}))

    return errors


def load_yaml(path: Path | None) -> Any:
    if path is None:
        return None
    with path.open("r", encoding="utf-8") as handle:
        return yaml.safe_load(handle)


def parse_required_sections(response_text: str) -> dict[str, str]:
    heading_matches = list(re.finditer(r"(?m)^### [^\n]+$", response_text))
    headings = [match.group(0).strip() for match in heading_matches]

    if headings != REQUIRED_SECTIONS:
        raise ValidationFailure(
            "reply headings must be exactly and only: "
            + ", ".join(REQUIRED_SECTIONS)
            + f"; got: {headings}"
        )

    sections: dict[str, str] = {}
    for index, match in enumerate(heading_matches):
        start = match.end()
        end = heading_matches[index + 1].start() if index + 1 < len(heading_matches) else len(response_text)
        sections[match.group(0).strip()] = response_text[start:end].strip()

    return sections


def extract_structured_yaml_block(structured_section: str) -> str:
    matches = list(re.finditer(r"(?s)```yaml\s*\n(.*?)\n```", structured_section))
    if len(matches) != 1:
        raise ValidationFailure("### Structured Output must contain exactly one fenced ```yaml block")

    if re.sub(r"(?s)```yaml\s*\n.*?\n```", "", structured_section).strip():
        raise ValidationFailure("### Structured Output must contain only the fenced yaml block")

    return matches[0].group(1)


def validate_schema(instance: Any, schema: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    _validate_schema_node(instance, schema, "$", schema, errors)
    return errors


def _validate_schema_node(
    instance: Any,
    schema: dict[str, Any],
    path: str,
    root_schema: dict[str, Any],
    errors: list[str],
) -> None:
    if "$ref" in schema:
        resolved = resolve_ref(schema["$ref"], root_schema)
        _validate_schema_node(instance, resolved, path, root_schema, errors)
        return

    if "anyOf" in schema:
        option_errors: list[list[str]] = []
        for option in schema["anyOf"]:
            nested_errors: list[str] = []
            _validate_schema_node(instance, option, path, root_schema, nested_errors)
            if not nested_errors:
                break
            option_errors.append(nested_errors)
        else:
            joined = "; ".join(" / ".join(option) for option in option_errors)
            errors.append(f"{path}: did not match any allowed schema option ({joined})")
            return

    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: expected one of {schema['enum']}, got {instance!r}")
        return

    if "type" in schema and not matches_type(instance, schema["type"]):
        errors.append(f"{path}: expected type {schema['type']!r}, got {type_name(instance)}")
        return

    if isinstance(instance, str) and "minLength" in schema and len(instance) < schema["minLength"]:
        errors.append(f"{path}: expected string length >= {schema['minLength']}, got {len(instance)}")

    if isinstance(instance, list) and "minItems" in schema and len(instance) < schema["minItems"]:
        errors.append(f"{path}: expected at least {schema['minItems']} item(s), got {len(instance)}")

    schema_type = normalized_type(schema.get("type"), instance)
    if schema_type == "object":
        validate_object(instance, schema, path, root_schema, errors)
    elif schema_type == "array":
        validate_array(instance, schema, path, root_schema, errors)


def resolve_ref(ref: str, root_schema: dict[str, Any]) -> dict[str, Any]:
    if not ref.startswith("#/"):
        raise ValidationFailure(f"unsupported schema ref: {ref}")

    node: Any = root_schema
    for part in ref[2:].split("/"):
        node = node[part]
    if not isinstance(node, dict):
        raise ValidationFailure(f"schema ref {ref} did not resolve to an object node")
    return node


def matches_type(instance: Any, expected_type: str | list[str]) -> bool:
    if isinstance(expected_type, list):
        return any(matches_type(instance, option) for option in expected_type)

    if expected_type == "object":
        return isinstance(instance, dict)
    if expected_type == "array":
        return isinstance(instance, list)
    if expected_type == "string":
        return isinstance(instance, str)
    if expected_type == "null":
        return instance is None
    if expected_type == "boolean":
        return isinstance(instance, bool)
    if expected_type == "integer":
        return isinstance(instance, int) and not isinstance(instance, bool)
    if expected_type == "number":
        return isinstance(instance, (int, float)) and not isinstance(instance, bool)
    return False


def type_name(instance: Any) -> str:
    if instance is None:
        return "null"
    if isinstance(instance, bool):
        return "boolean"
    if isinstance(instance, dict):
        return "object"
    if isinstance(instance, list):
        return "array"
    if isinstance(instance, str):
        return "string"
    if isinstance(instance, int):
        return "integer"
    if isinstance(instance, float):
        return "number"
    return type(instance).__name__


def normalized_type(expected_type: Any, instance: Any) -> str | None:
    if isinstance(expected_type, str):
        return expected_type
    if isinstance(expected_type, list):
        for option in expected_type:
            if matches_type(instance, option):
                return option
    if isinstance(instance, dict):
        return "object"
    if isinstance(instance, list):
        return "array"
    return None


def validate_object(
    instance: Any,
    schema: dict[str, Any],
    path: str,
    root_schema: dict[str, Any],
    errors: list[str],
) -> None:
    if not isinstance(instance, dict):
        return

    required = schema.get("required", [])
    for key in required:
        if key not in instance:
            errors.append(f"{path}: missing required property {key!r}")

    properties = schema.get("properties", {})
    for key, subschema in properties.items():
        if key in instance:
            _validate_schema_node(instance[key], subschema, f"{path}.{key}", root_schema, errors)

    allowed = set(properties.keys())
    extras = [key for key in instance.keys() if key not in allowed]
    additional = schema.get("additionalProperties", True)

    if additional is False and extras:
        errors.append(f"{path}: unexpected properties {extras}")
    elif isinstance(additional, dict):
        for key in extras:
            _validate_schema_node(instance[key], additional, f"{path}.{key}", root_schema, errors)


def validate_array(
    instance: Any,
    schema: dict[str, Any],
    path: str,
    root_schema: dict[str, Any],
    errors: list[str],
) -> None:
    if not isinstance(instance, list):
        return

    item_schema = schema.get("items")
    if item_schema:
        for index, item in enumerate(instance):
            _validate_schema_node(item, item_schema, f"{path}[{index}]", root_schema, errors)

    if schema.get("uniqueItems"):
        seen: set[str] = set()
        duplicates: list[Any] = []
        for item in instance:
            fingerprint = json.dumps(item, ensure_ascii=False, sort_keys=True)
            if fingerprint in seen:
                duplicates.append(item)
            seen.add(fingerprint)
        if duplicates:
            errors.append(f"{path}: duplicate array values {duplicates!r}")


def validate_troubleshoot_cross_field_rules(payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    result = payload.get("TroubleshootResult", {})
    runtime = result.get("runtime_state", {})
    verification = result.get("verification_summary", {})
    boundary = verification.get("stop_boundary", {})

    label = runtime.get("label")
    blocker_summary = runtime.get("blocker_summary")
    bucket = result.get("blocker_bucket")
    next_handoff = result.get("next_handoff")
    evidence_chain = verification.get("evidence_chain", [])
    dominant_evidence = verification.get("dominant_evidence")
    stop_reason = verification.get("stop_reason")
    recommended_next_action = verification.get("recommended_next_action")

    if bucket is not None:
        if bucket not in CANONICAL_BUCKETS:
            errors.append(f"blocker_bucket must be canonical; got {bucket!r}")
        if not blocker_summary:
            errors.append("non-null blocker_bucket requires runtime_state.blocker_summary")
        if not dominant_evidence:
            errors.append("non-null blocker_bucket requires verification_summary.dominant_evidence")
        if not stop_reason:
            errors.append("non-null blocker_bucket requires verification_summary.stop_reason")
        if not recommended_next_action:
            errors.append("non-null blocker_bucket requires verification_summary.recommended_next_action")
        if not evidence_chain:
            errors.append("non-null blocker_bucket requires a non-empty evidence_chain")

    if label != "runtime_healthy" and bucket is None:
        errors.append(f"runtime_state.label={label!r} requires a non-null blocker_bucket")

    if boundary.get("stopped") is not True:
        errors.append("stop_boundary.stopped must be true when emitting TroubleshootResult")

    if boundary.get("fallback_used") is not False:
        errors.append("stop_boundary.fallback_used must be false; silent fallback is not allowed")

    if next_handoff == "delivery_verifier":
        if label != "runtime_healthy":
            errors.append("next_handoff=delivery_verifier requires runtime_state.label=runtime_healthy")
        if boundary.get("delivery_verifier_allowed") is not True:
            errors.append("next_handoff=delivery_verifier requires delivery_verifier_allowed=true")

    if label != "runtime_healthy" and boundary.get("delivery_verifier_allowed") is True:
        errors.append("delivery_verifier_allowed=true is only valid for runtime_healthy")

    if bucket == "source build failed":
        errors.extend(validate_source_build_failed_chain(evidence_chain))
        if label != "code_or_build_handoff_needed":
            errors.append("blocker_bucket='source build failed' requires code_or_build_handoff_needed")
        if next_handoff != "code_build_handoff":
            errors.append("blocker_bucket='source build failed' requires next_handoff=code_build_handoff")
        if stop_reason != "source_build_failed":
            errors.append("blocker_bucket='source build failed' requires stop_reason=source_build_failed")

    if bucket == "external artifact unreachable":
        errors.extend(validate_external_artifact_chain(evidence_chain))
        if label != "code_or_build_handoff_needed":
            errors.append("blocker_bucket='external artifact unreachable' requires code_or_build_handoff_needed")
        if next_handoff != "code_build_handoff":
            errors.append("blocker_bucket='external artifact unreachable' requires next_handoff=code_build_handoff")
        if stop_reason != "external_artifact_unreachable":
            errors.append(
                "blocker_bucket='external artifact unreachable' requires "
                "stop_reason=external_artifact_unreachable"
            )

    if bucket == "source build still running":
        if label != "topology_building":
            errors.append("blocker_bucket='source build still running' requires topology_building")
        if next_handoff != "none":
            errors.append("blocker_bucket='source build still running' requires next_handoff=none")
        if stop_reason != "source_build_still_running":
            errors.append("blocker_bucket='source build still running' requires stop_reason=source_build_still_running")

    if bucket == "frontend access-path issue":
        if label != "code_or_build_handoff_needed":
            errors.append("blocker_bucket='frontend access-path issue' requires code_or_build_handoff_needed")
        if next_handoff != "code_build_handoff":
            errors.append("blocker_bucket='frontend access-path issue' requires next_handoff=code_build_handoff")
        if stop_reason != "frontend_access_path_issue":
            errors.append("blocker_bucket='frontend access-path issue' requires stop_reason=frontend_access_path_issue")

    if bucket == "cluster capacity blocked" or label == "capacity_blocked":
        if label != "capacity_blocked":
            errors.append("cluster capacity blocked requires runtime_state.label=capacity_blocked")
        if bucket != "cluster capacity blocked":
            errors.append("runtime_state.label=capacity_blocked requires blocker_bucket='cluster capacity blocked'")
        if next_handoff != "none":
            errors.append("cluster capacity blocked requires next_handoff=none")
        if boundary.get("delivery_verifier_allowed") is not False:
            errors.append("cluster capacity blocked must not continue to delivery verifier")
        if stop_reason != "cluster_capacity_blocked":
            errors.append("cluster capacity blocked requires stop_reason=cluster_capacity_blocked")

    if label == "code_or_build_handoff_needed" or next_handoff == "code_build_handoff":
        errors.extend(validate_code_or_build_stop_boundary(result))

    errors.extend(validate_no_forbidden_fallback(result))
    return errors


def validate_source_build_failed_chain(evidence_chain: list[str]) -> list[str]:
    errors: list[str] = []
    if "component_events" not in evidence_chain:
        errors.append("source build failed requires component_events evidence before runtime logs")
    if "build_logs" not in evidence_chain:
        errors.append("source build failed requires build_logs evidence before runtime logs")
    if "component_events" in evidence_chain and "build_logs" in evidence_chain:
        if evidence_chain.index("component_events") > evidence_chain.index("build_logs"):
            errors.append("source build failed evidence_chain must read component_events before build_logs")
    if "runtime_logs" in evidence_chain and "build_logs" in evidence_chain:
        if evidence_chain.index("runtime_logs") < evidence_chain.index("build_logs"):
            errors.append("source build failed must not read runtime_logs before build_logs")
    return errors


def validate_external_artifact_chain(evidence_chain: list[str]) -> list[str]:
    errors: list[str] = []
    if "component_events" not in evidence_chain and "pod_detail" not in evidence_chain:
        errors.append("external artifact unreachable requires component_events or pod_detail evidence")
    if "build_logs" not in evidence_chain and "pod_detail" not in evidence_chain:
        errors.append("external artifact unreachable requires build_logs or pod_detail pull evidence")
    if "runtime_logs" in evidence_chain:
        event_positions = [
            evidence_chain.index(source)
            for source in ("component_events", "pod_detail")
            if source in evidence_chain
        ]
        if event_positions and evidence_chain.index("runtime_logs") < min(event_positions):
            errors.append("external artifact unreachable must not read runtime_logs before event or pod evidence")
    return errors


def validate_code_or_build_stop_boundary(result: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    verification = result.get("verification_summary", {})
    boundary = verification.get("stop_boundary", {})
    actions_text = "\n".join(result.get("actions_taken", [])).lower()

    if result.get("next_handoff") != "code_build_handoff":
        errors.append("code_or_build_handoff_needed requires next_handoff=code_build_handoff")
    if boundary.get("stopped") is not True:
        errors.append("code_or_build_handoff_needed requires stop_boundary.stopped=true")
    if boundary.get("code_changes_allowed") is not False:
        errors.append("code_or_build_handoff_needed must not allow source-code changes")
    if boundary.get("local_tests_allowed") is not False:
        errors.append("code_or_build_handoff_needed must not allow local tests")
    if boundary.get("commit_or_push_allowed") is not False:
        errors.append("code_or_build_handoff_needed must not allow commit or push")

    for pattern in FORBIDDEN_CODE_HANDOFF_ACTION_PATTERNS:
        if re.search(pattern, actions_text):
            errors.append(
                "code_or_build_handoff_needed actions must not modify code, run local tests, commit, or push"
            )
            break

    return errors


def validate_no_forbidden_fallback(result: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    combined_text = "\n".join(result.get("actions_taken", [])).lower()
    combined_text += "\n" + str(result.get("runtime_state", {}).get("blocker_summary", "")).lower()
    combined_text += "\n" + str(result.get("verification_summary", {}).get("recommended_next_action", "")).lower()

    for pattern in FORBIDDEN_FALLBACK_PATTERNS:
        if re.search(pattern, combined_text):
            errors.append("TroubleshootResult must not silently fallback to package/image/template")
            break

    return errors


def validate_prose_consistency(sections: dict[str, str], payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    result = payload["TroubleshootResult"]
    runtime = result["runtime_state"]
    verification = result["verification_summary"]
    follow_up = sections["### Follow-up Advice"]
    prose_body = "\n\n".join(
        [
            sections["### Problem Judgment"],
            sections["### Actions Taken"],
            sections["### Verification Result"],
            follow_up,
        ]
    )

    label = runtime["label"]
    bucket = result["blocker_bucket"]
    next_handoff = result["next_handoff"]

    if label not in prose_body:
        errors.append(f"prose must mention runtime_state.label {label!r}")

    if bucket is not None and bucket not in prose_body:
        errors.append(f"prose must mention blocker_bucket {bucket!r}")

    status_expectations = {
        "db status": render_human_status(verification["db_status"]),
        "api status": render_human_status(verification["api_status"]),
        "frontend-access status": render_human_status(verification["frontend_access_status"]),
        "overall status": label,
    }
    for status_label, expected_value in status_expectations.items():
        actual_value = extract_status_value(sections["### Verification Result"], status_label)
        if actual_value is not None and actual_value != expected_value:
            errors.append(
                f"Verification Result {status_label} conflicts with structured output: "
                f"expected {expected_value!r}, got {actual_value!r}"
            )

    if next_handoff == "delivery_verifier" and not (
        "delivery-verifier" in follow_up.lower() or "delivery verifier" in follow_up.lower()
    ):
        errors.append("Follow-up Advice must mention delivery-verifier when next_handoff=delivery_verifier")

    if next_handoff == "code_build_handoff" and not (
        "code/build" in follow_up.lower() or "code_build_handoff" in follow_up.lower()
    ):
        errors.append("Follow-up Advice must mention code/build handoff when next_handoff=code_build_handoff")

    if next_handoff == "none" and re.search(r"(?i)handoff needed:\s*yes", follow_up):
        errors.append("Follow-up Advice says handoff needed: yes but next_handoff=none")

    return errors


def render_human_status(value: Any) -> str:
    if value is None:
        return "not applicable"
    if value == "not_working":
        return "not working"
    if value == "needs_validation":
        return "needs validation"
    return str(value)


def extract_status_value(section: str, status_label: str) -> str | None:
    pattern = re.compile(
        rf"(?im)^\s*-\s*\*\*{re.escape(status_label)}\*\*:\s*`([^`]+)`\s*$"
    )
    match = pattern.search(section)
    if not match:
        return None
    return match.group(1).strip()


def validate_expected_fixture(
    sections: dict[str, str],
    payload: dict[str, Any],
    expected: dict[str, Any],
) -> list[str]:
    errors: list[str] = []
    assertions = expected.get("assert", {})

    for path, expected_value in assertions.get("equal", {}).items():
        actual = get_path(payload, path)
        if actual != expected_value:
            errors.append(f"{path}: expected {expected_value!r}, got {actual!r}")

    for path, expected_value in assertions.get("contains", {}).items():
        actual = get_path(payload, path)
        errors.extend(assert_contains(path, actual, expected_value))

    for path, forbidden_value in assertions.get("excludes", {}).items():
        actual = get_path(payload, path)
        errors.extend(assert_excludes(path, actual, forbidden_value))

    prose_body = "\n\n".join(
        [
            sections["### Problem Judgment"],
            sections["### Actions Taken"],
            sections["### Verification Result"],
            sections["### Follow-up Advice"],
        ]
    )

    for needle in assertions.get("prose_contains", []):
        if needle not in prose_body:
            errors.append(f"prose is missing required text: {needle!r}")

    for needle in assertions.get("prose_not_contains", []):
        if needle in prose_body:
            errors.append(f"prose contains forbidden text: {needle!r}")

    return errors


def get_path(payload: Any, dotted_path: str) -> Any:
    current = payload
    for token in dotted_path.split("."):
        if isinstance(current, dict) and token in current:
            current = current[token]
            continue
        raise ValidationFailure(f"missing fixture assertion path: {dotted_path}")
    return current


def assert_contains(path: str, actual: Any, expected: Any) -> list[str]:
    if isinstance(actual, list):
        missing = [item for item in expected if item not in actual]
        if missing:
            return [f"{path}: missing expected list items {missing!r}"]
        return []

    if isinstance(actual, dict):
        missing_keys = [key for key in expected if key not in actual]
        if missing_keys:
            return [f"{path}: missing expected mapping keys {missing_keys!r}"]
        mismatches = [
            f"{key!r}: expected {value!r}, got {actual[key]!r}"
            for key, value in expected.items()
            if actual[key] != value
        ]
        if mismatches:
            return [f"{path}: mapping mismatches: {', '.join(mismatches)}"]
        return []

    if isinstance(actual, str):
        if str(expected) not in actual:
            return [f"{path}: expected substring {expected!r} not found"]
        return []

    return [f"{path}: contains assertion is unsupported for type {type_name(actual)}"]


def assert_excludes(path: str, actual: Any, forbidden: Any) -> list[str]:
    if isinstance(actual, list):
        present = [item for item in forbidden if item in actual]
        if present:
            return [f"{path}: contains forbidden list items {present!r}"]
        return []

    if isinstance(actual, dict):
        collisions = []
        for key, value in forbidden.items():
            if key in actual and actual[key] == value:
                collisions.append((key, value))
        if collisions:
            return [f"{path}: contains forbidden mapping entries {collisions!r}"]
        return []

    if isinstance(actual, str):
        if str(forbidden) in actual:
            return [f"{path}: contains forbidden substring {forbidden!r}"]
        return []

    return [f"{path}: excludes assertion is unsupported for type {type_name(actual)}"]


def check_for_secret_leaks(response_text: str, structured_yaml: str, payload: Any) -> list[str]:
    errors = check_secret_assignments(response_text)
    errors.extend(check_secret_assignments(structured_yaml))
    errors.extend(check_secret_keys(payload, "$"))
    return sorted(set(errors))


def check_secret_assignments(text: str) -> list[str]:
    errors: list[str] = []

    for line in text.splitlines():
        match = re.search(
            r"(?i)\b(password|secret|token|api[_-]?key|private[_-]?key|certificate)\b\s*[:=]\s*(.+)$",
            line,
        )
        if not match:
            continue
        value = match.group(2).strip().strip("'\"")
        lowered = value.lower()
        if lowered in {"null", "***", "[masked]", "<masked>", "redacted", "<redacted>"}:
            continue
        if value.startswith("$"):
            continue
        errors.append(f"response appears to contain unmasked secret material: {line.strip()!r}")

    return errors


def check_secret_keys(node: Any, path: str) -> list[str]:
    errors: list[str] = []

    if isinstance(node, dict):
        for key, value in node.items():
            key_path = f"{path}.{key}"
            lowered_key = key.lower().replace("-", "_")
            if any(keyword in lowered_key for keyword in SECRET_KEYWORDS):
                if isinstance(value, str):
                    lowered_value = value.strip().lower()
                    if lowered_value not in {v.lower() for v in MASKED_VALUES} and not value.startswith("$"):
                        errors.append(f"{key_path} appears to expose secret plaintext")
            errors.extend(check_secret_keys(value, key_path))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            errors.extend(check_secret_keys(value, f"{path}[{index}]"))

    return errors


if __name__ == "__main__":
    sys.exit(main())
