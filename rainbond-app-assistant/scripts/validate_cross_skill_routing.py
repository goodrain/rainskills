#!/usr/bin/env python3

"""Validate mutually exclusive routing for the two deployment entry skills."""

from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from pathlib import Path

import yaml


DEFAULT_REPO_ROOT = Path(__file__).resolve().parents[2]
OPEN_STAGE_ROWS = (
    "| Phase 0：描述符未确认 | 不加载 reference；只做上述静态资格判断 |",
    "| 描述符已确认，首次需要连接或调用 Rainbond | 只读取自己的 "
    "[runtime gate](references/runtime-gate.md) |",
    "| workspace context 已解析，需要建模、部署、排障或交付 app/component | 读取 "
    "[deployment workflow](references/deployment-workflow.md) |",
    "| 新鲜证据命中已知部署故障模式 | 再读取 "
    "[failure-mode playbook](references/failure-mode-playbook.md) |",
)
NEGATIONS = ("不得", "禁止", "不加载", "never", "must not", "do not", "cannot")
ROUTE_MARKERS = (
    "route",
    "use",
    "goes",
    "go to",
    "转到",
    "改走",
    "应转",
    "留在",
    "remain",
    "stay",
)


def require(condition: bool, message: str, failures: list[str]) -> None:
    if not condition:
        failures.append(message)


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).casefold()
    value = re.sub(r"[-_/]", " ", value)
    value = re.sub(r"[^\w\u3400-\u9fff]+", " ", value)
    return " ".join(value.split())


def contains(value: str, phrase: str) -> bool:
    return normalize(phrase) in normalize(value)


def statements(value: str) -> list[str]:
    return [
        normalize(part)
        for part in re.split(r"[!?。！？;；\n]+|\.(?=\s|$)", value)
        if normalize(part)
    ]


def description_statements(value: str) -> list[str]:
    return [
        normalize(part)
        for part in re.split(r"[!?。！？\n]+|\.(?=\s|$)", value)
        if normalize(part)
    ]


def parse_description(source: str) -> str:
    match = re.match(r"\A---\s*\n(.*?)\n---\s*\n", source, re.DOTALL)
    if not match:
        return ""
    metadata = yaml.safe_load(match.group(1))
    if not isinstance(metadata, dict) or not isinstance(metadata.get("description"), str):
        return ""
    return metadata["description"]


def markdown_body(source: str) -> str:
    return re.sub(r"\A---\s*\n.*?\n---\s*\n", "", source, count=1, flags=re.DOTALL)


def bounded_section(source: str, start_heading: str, end_heading: str) -> str:
    start = source.find(start_heading)
    end = source.find(end_heading, start + len(start_heading)) if start >= 0 else -1
    if start < 0 or end < 0 or start >= end:
        return ""
    return source[start:end]


def has_route_marker(statement: str) -> bool:
    return any(marker in statement for marker in ROUTE_MARKERS)


def has_negation(statement: str) -> bool:
    return any(normalize(marker) in statement for marker in NEGATIONS)


def has_local_negation(value: str) -> bool:
    value = normalize(value)
    return bool(re.search(r"\b(?:not|never)\b", value)) or any(
        marker in value for marker in ("不得", "禁止", "不能", "不可", "不应")
    )


def category_is_locally_negated(statement: str, category: str) -> bool:
    statement = normalize(statement)
    category = normalize(category)
    category_at = statement.find(category)
    if category_at < 0:
        return False
    prefix = statement[:category_at]
    boundaries = ("but", "while", "whereas", "although", "however", "instead", "而是", "但是", "但", "不过")
    boundary_at = -1
    for boundary in boundaries:
        normalized_boundary = normalize(boundary)
        if re.fullmatch(r"[a-z]+", normalized_boundary):
            matches = list(re.finditer(rf"\b{re.escape(normalized_boundary)}\b", prefix))
            candidate = matches[-1].start() if matches else -1
        else:
            candidate = prefix.rfind(normalized_boundary)
        boundary_at = max(boundary_at, candidate)
    clause_prefix = prefix[boundary_at:] if boundary_at >= 0 else prefix
    return has_local_negation(clause_prefix)


def relation_has_positive_cue(relation: str, cues: tuple[str, ...]) -> bool:
    relation = normalize(relation)
    positions = [relation.rfind(normalize(cue)) for cue in cues]
    cue_at = max(positions, default=-1)
    if cue_at < 0:
        return False
    prefix_tokens = relation[:cue_at].split()[-4:]
    local_window = " ".join(prefix_tokens + relation[cue_at:].split())
    return not has_local_negation(local_window)


def target_relation_after_contrast(
    statement: str,
    target_phrases: tuple[str, ...],
) -> bool:
    statement = normalize(statement)
    explicit_alternatives = ("instead", "rather", "而是", "改为")
    controlled_but = ("but", "但是", "但")
    cues = ("route", "use", "to", "with", "delegate", "handled", "goes", "stay")

    def starts_with_inherited_cue(value: str) -> bool:
        value = normalize(value)
        cue = r"(?:routes?|uses?|go(?:es)?|delegates?|handled|转到|改走|应转|留在)"
        pronoun = r"(?:it|they|this|that|these|those|request|requests|它|其|该请求|这些请求)"
        return bool(re.match(rf"^(?:{cue}|{pronoun}\s*{cue})(?:\s|$)", value))

    for marker in explicit_alternatives + controlled_but:
        marker_at = statement.rfind(marker)
        if marker_at < 0:
            continue
        suffix = statement[marker_at + len(marker):]
        for target in target_phrases:
            target = normalize(target)
            target_at = suffix.find(target)
            if target_at < 0:
                continue
            relation = suffix[:target_at]
            if marker in controlled_but:
                if starts_with_inherited_cue(relation):
                    return True
            elif relation_has_positive_cue(relation, cues):
                return True
    return False


def directed_relation(
    statement: str,
    category_phrases: tuple[str, ...],
    target_phrases: tuple[str, ...],
    *,
    allow_negated_category: bool = False,
) -> bool:
    statement = normalize(statement)
    categories = [normalize(phrase) for phrase in category_phrases]
    targets = [normalize(phrase) for phrase in target_phrases]
    forward_cues = (
        "route",
        "use",
        " to ",
        " with ",
        "delegate",
        "handled",
        "goes",
        "stay",
        "转到",
        "改走",
        "应转",
        "留在",
    )
    reverse_cues = ("handles", "owns", "accepts", "receives", "responsible for")
    contrast = ("while", "but", "whereas", "although", "however", "instead", "unrelated")

    for category in categories:
        category_at = statement.find(category)
        if category_at < 0 or (
            not allow_negated_category
            and category_is_locally_negated(statement, category)
        ):
            continue
        for target in targets:
            target_at = statement.find(target)
            if target_at < 0:
                continue
            if category_at < target_at:
                relation = statement[category_at + len(category):target_at]
                cues = forward_cues
            else:
                relation = statement[target_at + len(target):category_at]
                cues = reverse_cues
            if len(relation) > 360 or any(word in relation for word in contrast):
                continue
            if relation_has_positive_cue(relation, cues):
                return True
    return False


def validate_description_boundaries(
    app_description: str,
    open_description: str,
    failures: list[str],
) -> None:
    app_statements = description_statements(app_description)
    open_statements = description_statements(open_description)
    app_normalized = normalize(app_description)

    app_targets = ("rainbond app assistant", "app assistant")
    open_targets = ("rainbond opensource app deploy", "open source")
    template_targets = ("rainbond template installer", "template installer")

    def app_category_owned(
        statement: str,
        category_phrases: tuple[str, ...],
    ) -> bool:
        implicit_owner = statement.startswith("use when") and any(
            contains(statement, category)
            and not category_is_locally_negated(statement, category)
            for category in category_phrases
        )
        return implicit_owner or directed_relation(statement, category_phrases, app_targets)

    app_owner = all(
        any(predicate(statement) and app_category_owned(statement, categories) for statement in app_statements)
        for predicate, categories in (
            (lambda statement: "source code" in statement, ("source code",)),
            (lambda statement: "current project" in statement, ("current project",)),
            (
                lambda statement: "source directory" in statement and "package" in statement,
                ("source directory", "source package"),
            ),
            (lambda statement: "bare git" in statement, ("bare git",)),
            (
                lambda statement: "named application" in statement and "without a descriptor" in statement,
                ("named application", "named app"),
            ),
        )
    )
    app_actions = all(
        action in app_normalized
        for action in ("deploy", "run", "deliver", "inspect", "repair", "troubleshoot")
    )
    require(
        app_owner and app_actions,
        "App description must positively own source and descriptor-less requests",
        failures,
    )
    require(
        any(
            "supplied" in statement
            and all(kind in statement for kind in ("compose", "helm", "image set", "descriptor"))
            and directed_relation(
                statement,
                ("descriptor", "compose", "helm", "image set"),
                open_targets,
                allow_negated_category=True,
            )
            for statement in app_statements
        ),
        "App description must exclude supplied descriptors to Open-source Deploy",
        failures,
    )
    require(
        any(
            "market template" in statement
            and directed_relation(
                statement,
                ("market template",),
                template_targets,
                allow_negated_category=True,
            )
            for statement in app_statements
        ),
        "App description must exclude confirmed market templates",
        failures,
    )

    open_owner = any(
        (
            statement.startswith("use only when")
            or statement.startswith("use this skill only when")
            or directed_relation(
                statement,
                ("descriptor", "compose", "helm", "image set"),
                open_targets,
            )
        )
        and ("actual" in statement or "supplied" in statement)
        and all(kind in statement for kind in ("compose", "helm", "image set", "descriptor"))
        for statement in open_statements
    )
    require(
        open_owner,
        "Open-source description must positively own only supplied descriptors",
        failures,
    )
    open_exclusion = any(
        "bare git" in statement
        and "source project" in statement
        and "directory" in statement
        and "package" in statement
        and "named app" in statement
        and ("without a descriptor" in statement or "without descriptor" in statement)
        and "private image project" in statement
        and all(
            directed_relation(
                statement,
                categories,
                app_targets,
                allow_negated_category=True,
            )
            for categories in (
                ("bare git",),
                ("source project", "source directory", "source package"),
                ("named application", "named app"),
            )
        )
        for statement in open_statements
    ) and any(
        "market template" in statement
        and directed_relation(
            statement,
            ("market template",),
            template_targets,
            allow_negated_category=True,
        )
        for statement in open_statements
    )
    require(
        open_exclusion,
        "Open-source description must exclude source, named-only, and market routes",
        failures,
    )


def validate_routing_conflicts(
    app_root: str,
    app_description: str,
    open_root: str,
    open_description: str,
    failures: list[str],
) -> None:
    phase_zero = bounded_section(open_root, "## Phase 0：静态资格判断", "## 渐进加载")
    staged_loading = bounded_section(open_root, "## 渐进加载", "## Runtime 与安全边界")
    require(bool(phase_zero), "Open-source Phase 0 section bounds are invalid", failures)
    require(bool(staged_loading), "Open-source staged-loading section bounds are invalid", failures)

    app_body_statements = statements(markdown_body(app_root))
    open_body_statements = statements(markdown_body(open_root))
    body_statements = app_body_statements + open_body_statements
    all_root_statements = (
        statements(app_description)
        + statements(open_description)
        + body_statements
    )

    source_categories = (
        "bare git",
        "source project",
        "source code",
        "source directory",
        "source package",
        "current project",
        "named only",
        "named application",
    )

    def open_source_target(statement: str) -> bool:
        return contains(statement, "rainbond opensource app deploy") or "open source" in statement

    source_to_open = any(
        any(category in statement for category in source_categories)
        and open_source_target(statement)
        and (
            directed_relation(statement, source_categories, ("rainbond opensource app deploy", "open source"))
            or target_relation_after_contrast(
                statement,
                ("rainbond opensource app deploy", "open source"),
            )
        )
        for statement in all_root_statements
    )
    require(not source_to_open, "source ownership boundary conflict", failures)

    descriptor_to_app = any(
        any(kind in statement for kind in ("compose", "helm", "image set"))
        and contains(statement, "rainbond app assistant")
        and (
            directed_relation(
                statement,
                ("compose", "helm", "image set", "descriptor"),
                ("rainbond app assistant", "app assistant"),
            )
            or target_relation_after_contrast(
                statement,
                ("rainbond app assistant", "app assistant"),
            )
        )
        for statement in all_root_statements
    )
    require(not descriptor_to_app, "descriptor ownership boundary conflict", failures)

    market_conflict = False
    for statement in all_root_statements:
        if not contains(statement, "market template"):
            continue
        rejects_installer = re.search(
            r"(?:not route|do not route|不转)\s+rainbond template installer",
            statement,
        )
        stays_open = contains(statement, "rainbond opensource app deploy") and any(
            marker in statement for marker in ("留在", "remain", "stay")
        )
        routes_to_app = bool(
            re.search(
                r"market templates?.{0,40}(?:route|goes|go to|转到|改走|应转).{0,40}rainbond app assistant",
                statement,
            )
            or re.search(
                r"(?:route|转到|改走|应转).{0,20}market templates?.{0,40}rainbond app assistant",
                statement,
            )
        ) and not has_negation(statement)
        if rejects_installer or stays_open or routes_to_app:
            market_conflict = True
            break
    require(not market_conflict, "market template routing boundary conflict", failures)

    def unconfirmed(statement: str) -> bool:
        return any(
            marker in statement
            for marker in (
                "未确认描述符",
                "描述符未确认",
                "描述符确认前",
                "未确认 descriptor",
                "descriptor 未确认",
                "before descriptor confirmation",
                "before confirming descriptor",
            )
        )

    def pre_descriptor_action(statement: str) -> bool:
        non_gate_actions = (
            "查询",
            "连接环境",
            "连接 rainbond",
            "连接 runtime",
            "connect environment",
            "connect runtime",
            "clone",
            "browse git",
            "克隆",
            "浏览 git",
        )
        positive_markers = ("允许", "先", "可以", "may", "can", "should", "must load", "must read")
        has_gate_action = "runtime gate" in statement and any(
            action in statement for action in ("读取", "加载", "read", "load", "允许")
        )
        has_action = has_gate_action or any(action in statement for action in non_gate_actions)
        explicitly_positive = any(marker in statement for marker in positive_markers)
        return (
            unconfirmed(statement)
            and has_action
            and (explicitly_positive or not has_negation(statement))
        )

    require(
        not any(pre_descriptor_action(statement) for statement in open_body_statements),
        "pre-descriptor action boundary conflict",
        failures,
    )

    stage_conflict = any(pre_descriptor_action(statement) for statement in statements(staged_loading)) or any(
        contains(statement, "deployment workflow")
        and contains(statement, "workspace context")
        and ("前" in statement or "before" in statement)
        and not has_negation(statement)
        for statement in statements(staged_loading)
    )
    require(not stage_conflict, "Open-source stage ordering conflict", failures)

    guard_scope = normalize(phase_zero)
    guard_complete = (
        unconfirmed(guard_scope)
        and contains(guard_scope, "runtime gate")
        and "rainbond" in guard_scope
        and ("克隆" in guard_scope or "clone" in guard_scope)
        and ("浏览 git" in guard_scope or "browse git" in guard_scope)
        and has_negation(guard_scope)
        and not any(pre_descriptor_action(statement) for statement in statements(phase_zero))
    )
    require(guard_complete, "Open-source descriptor guard is missing or reversed", failures)


def validate_cross_skill_routing(repo_root: Path) -> list[str]:
    failures: list[str] = []
    app_dir = repo_root / "rainbond-app-assistant"
    open_dir = repo_root / "rainbond-opensource-app-deploy"
    app_root = (app_dir / "SKILL.md").read_text(encoding="utf-8")
    open_root = (open_dir / "SKILL.md").read_text(encoding="utf-8")
    app_description = parse_description(app_root)
    open_description = parse_description(open_root)

    validate_description_boundaries(app_description, open_description, failures)

    open_bytes = len(open_root.encode("utf-8"))
    open_lines = len(open_root.splitlines())
    require(open_bytes <= 6_500, f"Open-source root is too large: {open_bytes} bytes", failures)
    require(open_lines <= 140, f"Open-source root is too long: {open_lines} lines", failures)

    for label, root in (("App", app_root), ("Open-source", open_root)):
        for forbidden in (
            "rainskills.skill-runtime-contract.v1",
            "rainskills.single-runtime-contract.v1",
            "<!-- rainskills-runtime-gate:start -->",
            '"runtime_status":',
            '"input_commands":',
        ):
            require(forbidden not in root, f"{label} root embeds runtime content: {forbidden}", failures)

    order_statement = next(
        (
            statement
            for statement in statements(open_root)
            if contains(statement, "先验证描述符")
            and contains(statement, "再加载 runtime gate")
        ),
        None,
    )
    require(order_statement is not None, "Open-source root must state descriptor-before-gate ordering", failures)
    validate_routing_conflicts(
        app_root,
        app_description,
        open_root,
        open_description,
        failures,
    )

    for forbidden in (
        "## 0. Derive the official topology",
        "## 6. Pass the delivery gate",
        "## Progress checklist",
    ):
        require(forbidden not in open_root, f"Open-source root contains forbidden staged content: {forbidden}", failures)

    for row in OPEN_STAGE_ROWS:
        require(row in open_root, f"Open-source stage mapping is invalid: {row}", failures)
    if all(row in open_root for row in OPEN_STAGE_ROWS):
        positions = [open_root.index(row) for row in OPEN_STAGE_ROWS]
        require(
            positions == sorted(positions),
            "Open-source stages must progress from static qualification to gate, workflow, then playbook",
            failures,
        )

    for label, skill_dir in (("App", app_dir), ("Open-source", open_dir)):
        gate_path = skill_dir / "references" / "runtime-gate.md"
        require(gate_path.is_file(), f"{label} runtime gate is missing", failures)
        if gate_path.is_file():
            gate = gate_path.read_text(encoding="utf-8")
            require(
                "rainskills.skill-runtime-contract.v1" in gate,
                f"{label} runtime gate lacks the progressive-loading contract marker",
                failures,
            )
            require(
                "rainskills.single-runtime-contract.v1" in gate,
                f"{label} runtime gate lacks its contract",
                failures,
            )

    deployment_workflow = open_dir / "references" / "deployment-workflow.md"
    failure_playbook = open_dir / "references" / "failure-mode-playbook.md"
    require(deployment_workflow.is_file(), "missing deployment-workflow.md", failures)
    require(failure_playbook.is_file(), "missing failure-mode-playbook.md", failures)
    if deployment_workflow.is_file():
        workflow = deployment_workflow.read_text(encoding="utf-8")
        require("## 0. Derive the official topology" in workflow, "deployment workflow lacks phase 0", failures)
        require("## 6. Pass the delivery gate" in workflow, "deployment workflow lacks delivery gate", failures)

    openai_yaml = (open_dir / "agents" / "openai.yaml").read_text(encoding="utf-8")
    require(
        'short_description: "Only supplied Compose, Helm, or image-set descriptors"' in openai_yaml,
        "Open-source short_description is not the required value",
        failures,
    )

    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=DEFAULT_REPO_ROOT)
    args = parser.parse_args()
    failures = validate_cross_skill_routing(args.repo_root.resolve())

    if failures:
        print("FAIL: cross-skill routing is not mutually exclusive")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print("PASS: cross-skill routing is mutually exclusive")
    return 0


if __name__ == "__main__":
    sys.exit(main())
