#!/usr/bin/env python3

"""Deterministic validator for bootstrap structured output fixtures and replies."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

import yaml

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts"))
from validate_customer_output import validate_customer_output  # noqa: E402


REQUIRED_SECTIONS = [
    "### Creation Result",
    "### Actions Taken",
    "### Current State",
    "### Handoff Recommendation",
    "### Structured Output",
]

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


class ValidationFailure(Exception):
    """Raised when validation fails."""


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
        description=(
            "Validate a bootstrap reply fixture or captured response against the "
            "frozen BootstrapResult contract."
        )
    )
    parser.add_argument("response", type=Path, help="Path to the markdown response file.")
    parser.add_argument(
        "--schema",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "schemas" / "bootstrap-result.schema.yaml",
        help="Path to bootstrap-result.schema.yaml.",
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

    presentation_mode = (expected or {}).get("presentation_mode", "customer")
    if presentation_mode == "customer":
        return validate_customer_output(response_text, expected or {})
    if presentation_mode == "structured":
        pass
    else:
        return [f"unsupported presentation_mode: {presentation_mode!r}"]

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
        errors.append("structured YAML parsed to null; expected a BootstrapResult object")
        return errors

    errors.extend(check_for_secret_leaks(structured_yaml, payload))
    errors.extend(validate_schema(payload, schema))
    errors.extend(validate_cross_field_rules(payload))
    errors.extend(validate_handoff_section(sections["### Handoff Recommendation"], payload))

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


def validate_cross_field_rules(payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    bootstrap = payload.get("BootstrapResult", {})
    workflow = bootstrap.get("deployment_plan", {}).get("workflow", {})
    runtime = bootstrap.get("runtime_state", {})

    created = workflow.get("created", [])
    reused = workflow.get("reused", [])
    skipped = workflow.get("skipped", [])
    skipped_reasons = workflow.get("skipped_reasons", {})
    deferred = workflow.get("deferred_dependencies", [])
    component_status = runtime.get("component_status", {})
    overall = runtime.get("overall")
    blocking_bucket = runtime.get("blocking_bucket")
    next_handoff = bootstrap.get("next_handoff")

    group_map = {"created": set(created), "reused": set(reused), "skipped": set(skipped)}
    names = list(group_map.keys())
    for index, left_name in enumerate(names):
        for right_name in names[index + 1 :]:
            overlap = sorted(group_map[left_name] & group_map[right_name])
            if overlap:
                errors.append(
                    f"BootstrapResult.deployment_plan.workflow.{left_name} and "
                    f"{right_name} overlap: {overlap}"
                )

    if set(skipped_reasons.keys()) != set(skipped):
        errors.append(
            "BootstrapResult.deployment_plan.workflow.skipped_reasons keys must "
            "exactly match workflow.skipped"
        )

    if overall == "runtime_healthy" and blocking_bucket is not None:
        errors.append("runtime_state.overall=runtime_healthy requires blocking_bucket=null")

    if overall == "capacity_blocked" and blocking_bucket != "cluster capacity blocked":
        errors.append(
            "runtime_state.overall=capacity_blocked requires "
            "blocking_bucket='cluster capacity blocked'"
        )

    if blocking_bucket == "platform backend issue" and next_handoff != "none":
        errors.append("blocking_bucket='platform backend issue' requires next_handoff='none'")

    if blocking_bucket == "external artifact unreachable":
        if overall != "code_or_build_handoff_needed":
            errors.append(
                "blocking_bucket='external artifact unreachable' requires "
                "overall='code_or_build_handoff_needed'"
            )
        if next_handoff != "code_build_handoff":
            errors.append(
                "blocking_bucket='external artifact unreachable' requires next_handoff='code_build_handoff'"
            )

    if next_handoff == "code_build_handoff" and not (
        overall == "code_or_build_handoff_needed"
        or blocking_bucket in {"source build failed", "external artifact unreachable"}
    ):
        errors.append(
            "next_handoff='code_build_handoff' requires overall="
            "'code_or_build_handoff_needed' or a code/build blocker bucket"
        )

    if deferred and overall == "runtime_healthy":
        errors.append("non-empty deferred_dependencies is incompatible with runtime_healthy")

    if any(status == "capacity-blocked" for status in component_status.values()) and overall == "runtime_healthy":
        errors.append("component_status containing capacity-blocked is incompatible with runtime_healthy")

    return errors


def validate_handoff_section(handoff_section: str, payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []

    handoff_text = handoff_section.lower()
    next_handoff = payload["BootstrapResult"]["next_handoff"]

    if next_handoff == "troubleshooter" and "troubleshooter" not in handoff_text:
        errors.append("Handoff Recommendation must mention troubleshooter when next_handoff=troubleshooter")

    if next_handoff == "delivery_verifier" and not (
        "delivery-verifier" in handoff_text or "delivery verifier" in handoff_text
    ):
        errors.append(
            "Handoff Recommendation must mention delivery-verifier when next_handoff=delivery_verifier"
        )

    if next_handoff == "code_build_handoff" and not (
        "code/build" in handoff_text
        or "code build" in handoff_text
        or "code_build_handoff" in handoff_text
    ):
        errors.append(
            "Handoff Recommendation must mention code/build handoff when next_handoff=code_build_handoff"
        )

    if next_handoff == "none" and (
        "troubleshooter" in handoff_text or "delivery-verifier" in handoff_text or "delivery verifier" in handoff_text
    ):
        errors.append("Handoff Recommendation mentions a downstream stage but next_handoff=none")

    return errors


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
        contains_errors = assert_contains(path, actual, expected_value)
        errors.extend(contains_errors)

    for path, forbidden_value in assertions.get("excludes", {}).items():
        actual = get_path(payload, path)
        exclude_errors = assert_excludes(path, actual, forbidden_value)
        errors.extend(exclude_errors)

    prose_body = "\n\n".join(
        [
            sections["### Creation Result"],
            sections["### Actions Taken"],
            sections["### Current State"],
            sections["### Handoff Recommendation"],
        ]
    )

    for needle in assertions.get("prose_contains", []):
        if needle not in prose_body:
            errors.append(f"prose is missing required text: {needle!r}")

    for needle in assertions.get("prose_not_contains", []):
        if needle in prose_body:
            errors.append(f"prose contains forbidden text: {needle!r}")

    in_scope_components = expected.get("in_scope_components", [])
    if in_scope_components:
        workflow = payload["BootstrapResult"]["deployment_plan"]["workflow"]
        accounted = set(workflow["created"]) | set(workflow["reused"]) | set(workflow["skipped"])
        if accounted != set(in_scope_components):
            errors.append(
                "in-scope components must exactly match created/reused/skipped union: "
                f"expected {sorted(in_scope_components)}, got {sorted(accounted)}"
            )

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


def check_for_secret_leaks(structured_yaml: str, payload: Any) -> list[str]:
    errors = check_secret_assignments(structured_yaml)
    errors.extend(check_secret_keys(payload, "$"))
    return errors


def check_secret_assignments(structured_yaml: str) -> list[str]:
    errors: list[str] = []

    for line in structured_yaml.splitlines():
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
        errors.append(f"structured output appears to contain unmasked secret material: {line.strip()!r}")

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
