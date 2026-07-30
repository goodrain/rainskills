#!/usr/bin/env python3

"""Deterministic validator for app-assistant orchestration-level structured output."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlsplit

import yaml


REQUIRED_SECTIONS = [
    "### Project State",
    "### Actions Performed",
    "### Current Health",
    "### Blocking Issue",
    "### Next Step",
    "### Structured Output",
]

CONCISE_SUCCESS_SECTIONS = [
    "### 部署结果",
    "### 运行状态",
]

CONCISE_SUCCESS_SECTION_ORDERS = {
    tuple(CONCISE_SUCCESS_SECTIONS),
    (*CONCISE_SUCCESS_SECTIONS, "### 处理记录"),
    (*CONCISE_SUCCESS_SECTIONS, "### 注意事项"),
    (*CONCISE_SUCCESS_SECTIONS, "### 处理记录", "### 注意事项"),
}

FORBIDDEN_CONCISE_INTERNAL_PATTERNS = (
    r"\bAppAssistantResult\b",
    r"\blinked-and-",
    r"\borchestration_state\b",
    r"\bruntime_state\b",
    r"\bdelivery_state\b",
    r"\bpromotion_result\b",
    r"\bactions_performed\b",
    r"\bnext_action\b",
    r"\bdelivered-but-needs-manual-validation\b",
    r"\bruntime_(?:healthy|unhealthy)\b",
)

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
    "authorization",
    "cookie",
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
    r"\bcode edit(?:s)?\b",
    r"\blocal test(?:s)?\b",
)


# Canonical next_action vocabulary.
#
# 修改需同步: this list is the validator-side mirror of the "Canonical next_action
# vocabulary" table in SKILL.md (### Structured contract mode). Editing one without
# the other breaks the contract. Fixed phrases must match verbatim (after whitespace
# normalization); template phrases match by their leading + trailing literal segments
# (the text before the first <slot> and after the last <slot>), so the <...> slot can
# be filled with any value or, where the table allows, omitted.
CANONICAL_NEXT_ACTIONS = (
    "stop",
    "run bootstrap",
    "run troubleshooter",
    "run troubleshooter on the same source path",
    "run delivery verifier",
    "fix cluster capacity first",
    "handoff to code/build agent",
    "stop and validate URL manually",
    "stop and ask the user to choose the team/app identity",
    "stop and ask the user to provide a descriptor or template",
    "build the linked source app on the user-provided GitHub URL",
    "configure ports and envs on the known service_alias from the create return",
)

# Template phrases keyed by their literal prefix (before the first <slot>) and
# literal suffix (after the last <slot>). A candidate matches when it starts with the
# prefix and ends with the suffix and is at least as long as prefix+suffix combined.
CANONICAL_NEXT_ACTION_TEMPLATES = (
    {
        "template": "stop after reporting testing app verification for <app>",
        "prefix": "stop after reporting testing app verification for ",
        "suffix": "",
    },
    {
        "template": "delete the abandoned half-installed template app <app> before building the source path",
        "prefix": "delete the abandoned half-installed template app",
        "suffix": "before building the source path",
    },
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
        description="Validate an app-assistant markdown reply against AppAssistantResult."
    )
    parser.add_argument("response", type=Path, help="Path to the markdown response file.")
    parser.add_argument(
        "--schema",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "schemas" / "app-assistant-result.schema.yaml",
        help="Path to app-assistant-result.schema.yaml.",
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

    presentation_mode = (expected or {}).get("presentation_mode", "structured")
    if presentation_mode == "concise":
        errors.extend(check_for_secret_leaks(response_text, "", {}))
        errors.extend(validate_concise_response(response_text, expected or {}))
        return errors
    if presentation_mode != "structured":
        return [f"unsupported presentation_mode: {presentation_mode!r}"]

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
        return ["structured YAML parsed to null; expected an AppAssistantResult object"]

    errors.extend(check_for_secret_leaks(response_text, structured_yaml, payload))
    errors.extend(validate_schema(payload, schema))

    if not errors:
        errors.extend(validate_cross_field_rules(sections, payload))
        errors.extend(validate_prose_consistency(sections, payload))

    if expected_path and not errors:
        errors.extend(validate_expected_fixture(sections, payload, expected or {}))

    return errors


def validate_concise_response(response_text: str, expected: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    headings = re.findall(r"(?m)^### [^\n]+$", response_text)

    if tuple(headings) not in CONCISE_SUCCESS_SECTION_ORDERS:
        errors.append(
            "concise success headings must start with: "
            + ", ".join(CONCISE_SUCCESS_SECTIONS)
            + "; optional trailing sections are ### 处理记录 and ### 注意事项"
            + f"; got: {headings}"
        )

    required_patterns = {
        "a successful deployment result": r"部署成功",
        "an application name": r"(?m)^应用：`?[^`\n]+`?\s*$",
        "an environment name": r"(?m)^环境：`?[^`\n]+`?\s*$",
        "a Rainbond deployment location link": r"(?m)^- 部署位置：\[[^\]]+\]\(https?://[^)\s]+\)\s*$",
        "a public access link": r"(?m)^- 访问地址：\[[^\]]+\]\(https?://[^)\s]+\)\s*$",
        "component runtime status": r"(?m)^- `?[^`\n：]+`?：运行中\s*$",
        "HTTP verification evidence": r"(?im)^- HTTP (?:检查|验证)：[^\n]+$",
    }
    for label, pattern in required_patterns.items():
        if not re.search(pattern, response_text):
            errors.append(f"concise success response requires {label}")

    if re.search(r"(?s)```(?:yaml|yml|json)?\s*\n", response_text, flags=re.IGNORECASE):
        errors.append("concise success response must not contain fenced structured output")

    for pattern in FORBIDDEN_CONCISE_INTERNAL_PATTERNS:
        if re.search(pattern, response_text, flags=re.IGNORECASE):
            errors.append("concise success response must not expose internal orchestration fields or enum values")
            break

    errors.extend(validate_expected_prose(response_text, expected))
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

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: expected constant {schema['const']!r}, got {instance!r}")
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


def validate_cross_field_rules(sections: dict[str, str], payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    result = payload.get("AppAssistantResult", {})

    request_intent = result.get("request_intent")
    execution_path = result.get("execution_path") or {}
    runtime = result.get("runtime_state") or {}
    delivery = result.get("delivery_state")
    promotion = result.get("promotion_result")
    actions = result.get("actions_performed", [])
    next_action = normalize_space(result.get("next_action"))
    orchestration_state = normalize_space(result.get("orchestration_state"))

    errors.extend(validate_next_action_vocabulary(next_action))
    errors.extend(validate_deployment_location(result))

    phase = normalize_space(runtime.get("phase"))
    combined_text = "\n".join(
        [
            sections["### Actions Performed"],
            sections["### Current Health"],
            sections["### Blocking Issue"],
            sections["### Next Step"],
            "\n".join(str(action.get("details", "")) for action in actions if isinstance(action, dict)),
        ]
    ).lower()

    if delivery is not None and not has_executed_skill(actions, "rainbond-delivery-verifier"):
        errors.append("delivery_state can be non-null only after rainbond-delivery-verifier has run")

    if promotion is not None:
        if request_intent != "dev_to_test_promotion":
            errors.append("promotion_result can be non-null only when request_intent=dev_to_test_promotion")
        if not isinstance(delivery, dict) or delivery.get("status") != "delivered":
            errors.append("promotion_result can be non-null only after source delivery_state.status=delivered")
        if not has_executed_skill(actions, "rainbond-app-version-assistant"):
            errors.append("promotion_result requires rainbond-app-version-assistant to have run")

    if isinstance(delivery, dict) and delivery.get("status") == "delivered-but-needs-manual-validation":
        if promotion is not None:
            errors.append("delivered-but-needs-manual-validation must not enter promotion_result")
        if points_to_promotion(next_action):
            errors.append("delivered-but-needs-manual-validation must stop before promotion")
        if has_executed_skill(actions, "rainbond-app-version-assistant"):
            errors.append("delivered-but-needs-manual-validation must not run rainbond-app-version-assistant")

    if phase == "capacity_blocked":
        if points_to_delivery_verification(next_action):
            errors.append("capacity_blocked must not point next_action to delivery verification")
        if isinstance(delivery, dict) and delivery.get("status") in {
            "delivered",
            "delivered-but-needs-manual-validation",
        }:
            errors.append("capacity_blocked is incompatible with a delivered delivery_state")

    if phase == "code_or_build_handoff_needed" or points_to_code_handoff(next_action):
        errors.extend(validate_code_or_build_boundary(actions, sections))

    if execution_path.get("requested_kind") == "source":
        if execution_path.get("resolved_kind") != "source" and not is_identity_ambiguous(
            orchestration_state,
            next_action,
        ):
            errors.append("source-backed orchestration must not silently fallback to package/image/template")
        if has_executed_skill(actions, "rainbond-template-installer"):
            errors.append("source-backed orchestration must not execute rainbond-template-installer silently")
        for pattern in FORBIDDEN_FALLBACK_PATTERNS:
            if re.search(pattern, combined_text):
                errors.append("source-backed orchestration must not silently fallback to package/image/template")
                break

    if isinstance(delivery, dict) and delivery.get("status") == "delivered" and request_intent == "source_app_delivery":
        if promotion is not None:
            errors.append("source_app_delivery runs must stop without promotion_result after delivered")
        if "stop" not in next_action.lower():
            errors.append("delivered source_app_delivery runs must stop instead of continuing")

    if is_identity_ambiguous(orchestration_state, next_action):
        if delivery is not None:
            errors.append("identity-ambiguous runs must not emit delivery_state")
        if promotion is not None:
            errors.append("identity-ambiguous runs must not emit promotion_result")
        if runtime not in ({}, None):
            phase_value = runtime.get("phase")
            if phase_value is not None:
                errors.append("identity-ambiguous runs must stop before emitting canonical runtime_state.phase")
        if not asks_user_to_choose_identity(next_action):
            errors.append("identity-ambiguous runs must stop and ask the user to choose the team/app identity")
        for blocked_skill in (
            "rainbond-fullstack-bootstrap",
            "rainbond-fullstack-troubleshooter",
            "rainbond-delivery-verifier",
            "rainbond-app-version-assistant",
        ):
            if has_executed_skill(actions, blocked_skill):
                errors.append(f"identity-ambiguous runs must stop before executing {blocked_skill}")

    if isinstance(delivery, dict):
        errors.extend(validate_delivery_summary(delivery))

    if isinstance(promotion, dict):
        testing_delivery = promotion.get("testing_delivery_state")
        if isinstance(testing_delivery, dict):
            errors.extend(validate_delivery_summary(testing_delivery, path_prefix="promotion_result.testing_delivery_state"))

    return errors


def validate_deployment_location(result: dict[str, Any]) -> list[str]:
    project = result.get("project") or {}
    identity = project.get("identity") or {}
    deployment_url = project.get("deployment_location_url")

    if deployment_url is None:
        return []

    identity_parts = [
        identity.get("team_name"),
        identity.get("region_name"),
        identity.get("app_id"),
    ]
    if any(value is None for value in identity_parts):
        return ["project.deployment_location_url requires team_name, region_name, and app_id"]

    parsed = urlsplit(deployment_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return ["project.deployment_location_url must be an absolute HTTP(S) Console URL"]

    team_name, region_name, app_id = (quote(str(value), safe="") for value in identity_parts)
    expected_fragment = f"/team/{team_name}/region/{region_name}/apps/{app_id}/overview"
    if parsed.fragment != expected_fragment:
        return [
            "project.deployment_location_url must point to the resolved Rainbond app overview route"
        ]

    delivery = result.get("delivery_state") or {}
    if deployment_url == delivery.get("preferred_access_url"):
        return ["deployment location and public service URL must remain distinct"]

    return []


def validate_next_action_vocabulary(next_action: str) -> list[str]:
    """next_action must come from the canonical vocabulary (see SKILL.md).

    Fixed phrases match verbatim after whitespace normalization. Template phrases
    match by their literal prefix + suffix so the <slot> can carry any value.
    """
    candidate = normalize_space(next_action)
    if not candidate:
        # Empty / missing next_action is already caught by the schema (non_empty_string).
        return []

    if candidate in CANONICAL_NEXT_ACTIONS:
        return []

    for template in CANONICAL_NEXT_ACTION_TEMPLATES:
        if matches_next_action_template(candidate, template):
            return []

    return [
        "next_action must be drawn from the canonical vocabulary in SKILL.md "
        f"(fixed phrase verbatim, or a template with its slot filled); got {next_action!r}"
    ]


def matches_next_action_template(candidate: str, template: dict[str, str]) -> bool:
    prefix = normalize_space(template["prefix"])
    suffix = normalize_space(template["suffix"])
    lowered = candidate.lower()

    if prefix and not lowered.startswith(prefix.lower()):
        return False
    if suffix and not lowered.endswith(suffix.lower()):
        return False
    if len(candidate) < len(prefix) + len(suffix):
        return False
    return True


def validate_delivery_summary(summary: dict[str, Any], path_prefix: str = "delivery_state") -> list[str]:
    errors: list[str] = []
    status = summary.get("status")
    preferred_access_url = summary.get("preferred_access_url")
    verification_mode = summary.get("verification_mode")
    blocker = summary.get("blocker")
    next_action = summary.get("verifier_next_action")

    if status == "delivered":
        if not preferred_access_url:
            errors.append(f"{path_prefix}.status=delivered requires preferred_access_url")
        if verification_mode != "verified":
            errors.append(f"{path_prefix}.status=delivered requires verification_mode=verified")
        if blocker is not None:
            errors.append(f"{path_prefix}.status=delivered requires blocker=null")
        if next_action != "stop":
            errors.append(f"{path_prefix}.status=delivered requires verifier_next_action=stop")

    if status == "delivered-but-needs-manual-validation":
        if not preferred_access_url:
            errors.append(
                f"{path_prefix}.status=delivered-but-needs-manual-validation requires preferred_access_url"
            )
        if verification_mode not in {"manual_validation_needed", "inferred"}:
            errors.append(
                f"{path_prefix}.status=delivered-but-needs-manual-validation requires "
                "verification_mode=inferred or manual_validation_needed"
            )
        if blocker is not None:
            errors.append(f"{path_prefix}.status=delivered-but-needs-manual-validation requires blocker=null")
        if next_action != "manual_url_validation":
            errors.append(
                f"{path_prefix}.status=delivered-but-needs-manual-validation requires "
                "verifier_next_action=manual_url_validation"
            )

    if status == "blocked" and blocker is None:
        errors.append(f"{path_prefix}.status=blocked requires blocker")

    if status == "partially-delivered" and next_action == "stop":
        errors.append(f"{path_prefix}.status=partially-delivered cannot use verifier_next_action=stop")

    return errors


def validate_code_or_build_boundary(actions: list[dict[str, Any]], sections: dict[str, str]) -> list[str]:
    errors: list[str] = []
    action_text = "\n".join(str(action.get("details", "")) for action in actions if isinstance(action, dict)).lower()
    action_text += "\n" + sections["### Actions Performed"].lower()

    for pattern in FORBIDDEN_CODE_HANDOFF_ACTION_PATTERNS:
        if re.search(pattern, action_text):
            errors.append(
                "code_or_build_handoff_needed must not include code edits, local tests, commit, or push"
            )
            break

    return errors


def validate_prose_consistency(sections: dict[str, str], payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    result = payload["AppAssistantResult"]

    project = result["project"]
    environment = result["environment"]
    runtime = result.get("runtime_state") or {}
    delivery = result.get("delivery_state")
    promotion = result.get("promotion_result")
    actions = result.get("actions_performed", [])

    project_state = sections["### Project State"]
    actions_section = sections["### Actions Performed"]
    current_health = sections["### Current Health"]
    blocking_issue = sections["### Blocking Issue"]
    next_step = sections["### Next Step"]

    if not contains_normalized(project_state, result["orchestration_state"]):
        errors.append("Project State prose must mention orchestration_state")

    if not contains_normalized(project_state, environment["name"]):
        errors.append("Project State prose must mention environment.name")

    for identity_value in project["identity"].values():
        if identity_value is None:
            continue
        if not contains_normalized(project_state, identity_value):
            errors.append(f"Project State prose must mention identity value {identity_value!r}")

    if runtime and runtime.get("phase") is not None and not contains_normalized(current_health, runtime["phase"]):
        errors.append("Current Health prose must mention runtime_state.phase")

    if isinstance(delivery, dict) and not (
        contains_normalized(current_health, delivery["status"])
        or contains_normalized(blocking_issue, delivery["status"])
    ):
        errors.append("Current Health or Blocking Issue prose must mention delivery_state.status")

    blocker_text = None
    if runtime:
        blocker_text = runtime.get("blocker")
    if not blocker_text and isinstance(delivery, dict):
        blocker_text = delivery.get("blocker")
    if blocker_text and not contains_normalized(blocking_issue, blocker_text):
        errors.append("Blocking Issue prose must align with the structured blocker summary")

    if not contains_normalized(next_step, result["next_action"]):
        errors.append("Next Step prose must match next_action")

    for action in actions:
        skill = action.get("skill")
        if not skill:
            continue
        if skill == "inspection-only":
            continue
        if not contains_normalized(actions_section, skill):
            errors.append(f"Actions Performed prose must mention skill {skill!r}")

    if promotion is not None:
        testing_app = promotion.get("testing_app", {})
        testing_app_name = testing_app.get("app_name")
        if testing_app_name and not (
            contains_normalized(next_step, testing_app_name) or contains_normalized(current_health, testing_app_name)
        ):
            errors.append("prose must mention testing_app.app_name when promotion_result is present")

    return errors


def normalize_space(text: Any) -> str:
    if text is None:
        return ""
    return " ".join(str(text).split())


def normalize_for_match(text: Any) -> str:
    normalized = normalize_space(text).lower()
    normalized = normalized.replace("_", " ").replace("-", " ")
    return " ".join(normalized.split())


def contains_normalized(haystack: Any, needle: Any) -> bool:
    if needle is None:
        return True
    return normalize_for_match(needle) in normalize_for_match(haystack)


def has_executed_skill(actions: list[dict[str, Any]], skill_name: str) -> bool:
    executed_statuses = {"completed", "complete", "succeeded", "success", "finished", "stopped"}
    for action in actions:
        if not isinstance(action, dict):
            continue
        if action.get("skill") != skill_name:
            continue
        status = normalize_for_match(action.get("status"))
        if status in executed_statuses:
            return True
    return False


def points_to_delivery_verification(next_action: str) -> bool:
    lowered = next_action.lower()
    return "delivery verifier" in lowered or "delivery verification" in lowered


def points_to_promotion(next_action: str) -> bool:
    lowered = next_action.lower()
    return any(
        needle in lowered
        for needle in [
            "promotion",
            "snapshot",
            "testing app",
            "version-assistant",
            "version assistant",
            "dev-to-test",
        ]
    )


def points_to_code_handoff(next_action: str) -> bool:
    lowered = next_action.lower()
    return "code/build" in lowered or "code build" in lowered or "handoff" in lowered


def is_identity_ambiguous(orchestration_state: str, next_action: str) -> bool:
    combined = f"{orchestration_state} {next_action}".lower()
    return "ambiguous" in combined or "choose the team/app identity" in combined


def asks_user_to_choose_identity(next_action: str) -> bool:
    lowered = next_action.lower()
    return "ask the user" in lowered and "identity" in lowered or "choose the team/app identity" in lowered


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
            sections["### Project State"],
            sections["### Actions Performed"],
            sections["### Current Health"],
            sections["### Blocking Issue"],
            sections["### Next Step"],
        ]
    )

    errors.extend(validate_expected_prose(prose_body, expected))

    return errors


def validate_expected_prose(prose_body: str, expected: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    assertions = expected.get("assert", {})

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
    errors = check_secret_assignments(response_text, context="reply")
    errors.extend(check_secret_assignments(structured_yaml, context="structured output"))
    errors.extend(check_secret_keys(payload, "$"))
    return errors


def check_secret_assignments(text: str, context: str) -> list[str]:
    errors: list[str] = []

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue

        keyword_match = re.search(
            r"(?i)\b(password|secret|token|api[_-]?key|private[_-]?key|certificate|authorization|cookie)\b"
            r"[^\n:=]{0,32}[:=]\s*(.+)$",
            stripped,
        )
        if keyword_match:
            value = keyword_match.group(2).strip().strip("'\"")
            lowered = value.lower()
            if lowered in {"null", "true", "false", "***", "[masked]", "<masked>", "redacted", "<redacted>"}:
                continue
            if value.startswith("$"):
                continue
            errors.append(f"{context} appears to contain unmasked secret material: {stripped!r}")
            continue

        env_secret_match = re.search(
            r"(?i)\b[A-Z0-9_]*(PASSWORD|SECRET|TOKEN|API(?:_|-)?KEY|PRIVATE(?:_|-)?KEY|CERT(?:IFICATE)?|COOKIE)"
            r"[A-Z0-9_]*\b\s*[:=]\s*(.+)$",
            stripped,
        )
        if env_secret_match:
            value = env_secret_match.group(2).strip().strip("'\"")
            lowered = value.lower()
            if lowered in {"null", "true", "false", "***", "[masked]", "<masked>", "redacted", "<redacted>"}:
                continue
            if value.startswith("$"):
                continue
            errors.append(f"{context} appears to contain unmasked secret env material: {stripped!r}")
            continue

        auth_match = re.search(r"(?i)\bauthorization\b\s*:\s*(bearer|grjwt)\s+(\S+)", stripped)
        if auth_match:
            value = auth_match.group(2).strip().strip("'\"")
            if not value.startswith("$"):
                errors.append(f"{context} appears to contain an authorization credential: {stripped!r}")

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
                    if lowered_value not in {masked.lower() for masked in MASKED_VALUES} and not value.startswith("$"):
                        errors.append(f"{key_path} appears to expose secret plaintext")
            errors.extend(check_secret_keys(value, key_path))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            errors.extend(check_secret_keys(value, f"{path}[{index}]"))

    return errors


if __name__ == "__main__":
    sys.exit(main())
