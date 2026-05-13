#!/usr/bin/env python3

"""Deterministic validator for delivery-verifier structured output fixtures and replies."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

import yaml


REQUIRED_SECTIONS = [
    "### Deployment State",
    "### Component Runtime",
    "### Access URL",
    "### Verification Result",
    "### Next Step",
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

DELIVERY_COMPLETE_PHRASES = (
    "delivery complete",
    "fully delivered",
    "delivered successfully",
)


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
            "Validate a delivery-verifier reply fixture or captured response against "
            "the frozen DeliveryVerificationResult contract."
        )
    )
    parser.add_argument("response", type=Path, help="Path to the markdown response file.")
    parser.add_argument(
        "--schema",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "schemas"
        / "delivery-verification-result.schema.yaml",
        help="Path to delivery-verification-result.schema.yaml.",
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
        return [str(exc)]

    try:
        payload = yaml.safe_load(structured_yaml)
    except yaml.YAMLError as exc:
        return [f"structured YAML did not parse: {exc}"]

    if payload is None:
        return ["structured YAML parsed to null; expected a DeliveryVerificationResult object"]

    errors.extend(check_for_secret_leaks(response_text, payload))
    errors.extend(validate_schema(payload, schema))
    errors.extend(validate_cross_field_rules(payload, sections))
    errors.extend(validate_deployment_section(sections["### Deployment State"], payload))
    errors.extend(validate_component_runtime_section(sections["### Component Runtime"], payload))
    errors.extend(validate_access_section(sections["### Access URL"], payload))
    errors.extend(validate_verification_section(sections["### Verification Result"], payload))
    errors.extend(validate_next_step_section(sections["### Next Step"], payload))

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


def validate_cross_field_rules(payload: dict[str, Any], sections: dict[str, str]) -> list[str]:
    errors: list[str] = []

    result = payload.get("DeliveryVerificationResult", {})
    runtime_state = result.get("runtime_state")
    delivery_state = result.get("delivery_state")
    preferred_access_url = result.get("preferred_access_url")
    verification_mode = result.get("verification_mode")
    blocker = result.get("blocker")
    next_action = result.get("next_action")
    component_status = result.get("component_status", {})

    prose_body = "\n\n".join(
        [
            sections["### Deployment State"],
            sections["### Component Runtime"],
            sections["### Access URL"],
            sections["### Verification Result"],
            sections["### Next Step"],
        ]
    ).lower()

    building_or_waiting = [
        name for name, status in component_status.items() if status in {"building", "waiting"}
    ]
    unhealthy_status = [
        name for name, status in component_status.items() if status in {"abnormal", "capacity-blocked"}
    ]

    if delivery_state == "delivered":
        if not preferred_access_url:
            errors.append("delivery_state=delivered requires preferred_access_url")
        if verification_mode != "verified":
            errors.append("delivery_state=delivered requires verification_mode=verified")
        if blocker is not None:
            errors.append("delivery_state=delivered requires blocker=null")
        if next_action != "stop":
            errors.append("delivery_state=delivered requires next_action=stop")

    if delivery_state == "delivered-but-needs-manual-validation":
        if not preferred_access_url:
            errors.append("delivery_state=delivered-but-needs-manual-validation requires preferred_access_url")
        if verification_mode not in {"manual_validation_needed", "inferred"}:
            errors.append(
                "delivery_state=delivered-but-needs-manual-validation requires "
                "verification_mode=manual_validation_needed or inferred"
            )
        if blocker is not None:
            errors.append("delivery_state=delivered-but-needs-manual-validation requires blocker=null")
        if next_action != "manual_url_validation":
            errors.append(
                "delivery_state=delivered-but-needs-manual-validation requires "
                "next_action=manual_url_validation"
            )

    if delivery_state == "partially-delivered":
        if next_action == "stop":
            errors.append("delivery_state=partially-delivered cannot use next_action=stop")
        if verification_mode == "verified":
            errors.append("delivery_state=partially-delivered cannot use verification_mode=verified")
        if runtime_state == "runtime_healthy":
            errors.append("delivery_state=partially-delivered is incompatible with runtime_state=runtime_healthy")
        if any(phrase in prose_body for phrase in DELIVERY_COMPLETE_PHRASES):
            errors.append("delivery_state=partially-delivered cannot claim delivery complete in prose")

    if delivery_state == "blocked":
        if blocker is None:
            errors.append("delivery_state=blocked requires blocker")
        if next_action == "stop":
            errors.append("delivery_state=blocked cannot use next_action=stop")

    if building_or_waiting and delivery_state != "partially-delivered":
        errors.append(
            "component_status containing building/waiting requires delivery_state=partially-delivered"
        )

    if unhealthy_status and delivery_state == "delivered":
        errors.append("delivery_state=delivered is incompatible with abnormal or capacity-blocked components")

    if runtime_state == "capacity_blocked" and blocker != "cluster capacity blocked":
        errors.append(
            "runtime_state=capacity_blocked requires blocker='cluster capacity blocked'"
        )

    if blocker == "cluster capacity blocked":
        if next_action != "fix_cluster_capacity_first":
            errors.append(
                "blocker='cluster capacity blocked' requires next_action=fix_cluster_capacity_first"
            )
        if runtime_state != "capacity_blocked":
            errors.append(
                "blocker='cluster capacity blocked' requires runtime_state=capacity_blocked"
            )

    if next_action == "fix_cluster_capacity_first" and blocker != "cluster capacity blocked":
        errors.append(
            "next_action=fix_cluster_capacity_first requires blocker='cluster capacity blocked'"
        )

    if preferred_access_url is None and delivery_state in {
        "delivered",
        "delivered-but-needs-manual-validation",
    }:
        errors.append(f"delivery_state={delivery_state} requires preferred_access_url")

    return errors


def validate_deployment_section(deployment_section: str, payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    section = deployment_section.lower()
    result = payload["DeliveryVerificationResult"]

    delivery_state = result["delivery_state"].lower()
    if delivery_state not in section:
        errors.append("Deployment State must mention the delivery_state value")

    runtime_state = result["runtime_state"].lower()
    normalized_runtime = runtime_state.replace("_", " ")
    if normalized_runtime not in section and runtime_state not in section:
        errors.append("Deployment State must mention the runtime_state value")

    return errors


def validate_component_runtime_section(component_section: str, payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    section = component_section.lower()
    component_status = payload["DeliveryVerificationResult"]["component_status"]

    for name, status in component_status.items():
        normalized_name = name.lower()
        normalized_status = status.lower()
        if normalized_name not in section:
            errors.append(f"Component Runtime must mention component {name!r}")
        if normalized_status not in section:
            errors.append(f"Component Runtime must mention status {status!r}")

    return errors


def validate_access_section(access_section: str, payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    section = access_section.lower()
    preferred_access_url = payload["DeliveryVerificationResult"]["preferred_access_url"]

    if preferred_access_url is None:
        if not any(
            phrase in section
            for phrase in [
                "no usable access url",
                "no external access url",
                "no access url",
                "not available",
            ]
        ):
            errors.append("Access URL must explicitly say that no usable URL is available")
    elif preferred_access_url not in access_section:
        errors.append("Access URL must include the preferred_access_url value")

    return errors


def validate_verification_section(verification_section: str, payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    section = verification_section.lower()
    verification_mode = payload["DeliveryVerificationResult"]["verification_mode"]

    if verification_mode == "verified" and "verified" not in section:
        errors.append("Verification Result must mention verified when verification_mode=verified")

    if verification_mode == "inferred" and "inferred" not in section:
        errors.append("Verification Result must mention inferred when verification_mode=inferred")

    if verification_mode == "manual_validation_needed" and "manual validation" not in section:
        errors.append(
            "Verification Result must mention manual validation when "
            "verification_mode=manual_validation_needed"
        )

    return errors


def validate_next_step_section(next_step_section: str, payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    section = next_step_section.lower()
    next_action = payload["DeliveryVerificationResult"]["next_action"]

    if next_action == "stop" and not (
        "stop" in section or "delivery complete" in section or "app is healthy" in section
    ):
        errors.append("Next Step must mention stop when next_action=stop")

    if next_action == "manual_url_validation" and not (
        "manual url validation" in section or "manual_url_validation" in section
    ):
        errors.append(
            "Next Step must mention manual URL validation when "
            "next_action=manual_url_validation"
        )

    if next_action == "run_troubleshooter" and "troubleshooter" not in section:
        errors.append("Next Step must mention troubleshooter when next_action=run_troubleshooter")

    if next_action == "fix_cluster_capacity_first" and "fix cluster capacity first" not in section:
        errors.append(
            "Next Step must mention fix cluster capacity first when "
            "next_action=fix_cluster_capacity_first"
        )

    if next_action == "code_build_handoff" and not (
        "code/build" in section
        or "code build" in section
        or "code_build_handoff" in section
    ):
        errors.append(
            "Next Step must mention code/build handoff when next_action=code_build_handoff"
        )

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
        errors.extend(assert_contains(path, actual, expected_value))

    for path, forbidden_value in assertions.get("excludes", {}).items():
        actual = get_path(payload, path)
        errors.extend(assert_excludes(path, actual, forbidden_value))

    prose_body = "\n\n".join(
        [
            sections["### Deployment State"],
            sections["### Component Runtime"],
            sections["### Access URL"],
            sections["### Verification Result"],
            sections["### Next Step"],
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


def check_for_secret_leaks(response_text: str, payload: Any) -> list[str]:
    errors = check_secret_assignments(response_text)
    errors.extend(check_secret_keys(payload, "$"))
    return errors


def check_secret_assignments(response_text: str) -> list[str]:
    errors: list[str] = []

    for line in response_text.splitlines():
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
