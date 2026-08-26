#!/usr/bin/env python3

"""Cross-check selected Rainskills instructions against Rainbond Console tool schemas."""

from __future__ import annotations

import ast
import os
import unittest
from pathlib import Path
from typing import Any


RAINSKILLS_ROOT = Path(__file__).resolve().parents[1]


def resolve_console_root() -> Path | None:
    configured = os.environ.get("RAINBOND_CONSOLE_ROOT")
    candidates = [
        Path(configured).expanduser() if configured else None,
        RAINSKILLS_ROOT.parent / "rainbond-console",
    ]
    for candidate in candidates:
        if candidate and (candidate / "console/services/mcp_query_service.py").is_file():
            return candidate.resolve()
    return None


def literal_shape(node: ast.AST) -> Any:
    if isinstance(node, ast.Dict):
        return {
            key.value: literal_shape(value)
            for key, value in zip(node.keys, node.values)
            if isinstance(key, ast.Constant) and isinstance(key.value, str)
        }
    if isinstance(node, (ast.List, ast.Tuple)):
        return [literal_shape(item) for item in node.elts]
    if isinstance(node, ast.Constant):
        return node.value
    return None


def tool_schema(source: str, method_name: str) -> dict[str, Any]:
    tree = ast.parse(source)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == method_name:
            for statement in node.body:
                if isinstance(statement, ast.Return) and isinstance(statement.value, ast.Dict):
                    payload = literal_shape(statement.value)
                    return payload["inputSchema"]
    raise AssertionError("Console tool method not found: {}".format(method_name))


class RainskillsToolContractTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls) -> None:
        cls.app_assistant = (
            RAINSKILLS_ROOT / "rainbond-app-assistant/SKILL.md"
        ).read_text(encoding="utf-8")
        cls.bootstrap_creation = (
            RAINSKILLS_ROOT / "rainbond-fullstack-bootstrap/modules/30-creation-rules.md"
        ).read_text(encoding="utf-8")

    def test_rainskills_instructions_use_canonical_console_contracts(self) -> None:
        self.assertNotIn("`image_address`", self.app_assistant)
        self.assertIn("rainbond_query_components({enterprise_id, app_id})", self.app_assistant)
        self.assertIn(
            "rainbond_get_operation_failure_context({team_name, region_name, app_id, service_id, event_id?})",
            self.app_assistant,
        )
        self.assertIn("rainbond_get_component_detail", self.app_assistant)
        self.assertIn("is_deploy=false", self.bootstrap_creation)


class ConsoleSourceContractTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls) -> None:
        cls.console_root = resolve_console_root()
        if cls.console_root is None:
            raise unittest.SkipTest(
                "set RAINBOND_CONSOLE_ROOT or place rainbond-console beside rainskills"
            )
        cls.console_source = (
            cls.console_root / "console/services/mcp_query_service.py"
        ).read_text(encoding="utf-8")

    def assert_schema(self, method_name: str, properties: set[str], required: list[str]) -> None:
        schema = tool_schema(self.console_source, method_name)
        self.assertEqual(set(schema["properties"]), properties)
        self.assertEqual(schema["required"], required)

    def test_console_selected_tool_schemas_match_canonical_contract(self) -> None:
        self.assert_schema(
            "_tool_create_component_from_image",
            {
                "team_name", "region_name", "app_id", "service_cname", "image",
                "docker_cmd", "k8s_component_name", "user_name", "password", "is_deploy",
            },
            ["team_name", "region_name", "app_id", "service_cname", "image"],
        )
        self.assert_schema(
            "_tool_get_operation_failure_context",
            {
                "team_name", "region_name", "app_id", "service_id", "event_id",
                "log_tail_lines",
            },
            ["team_name", "region_name", "app_id", "service_id"],
        )
        self.assert_schema(
            "_tool_query_components",
            {"enterprise_id", "app_id", "query", "page", "page_size"},
            ["enterprise_id", "app_id"],
        )
        self.assert_schema(
            "_tool_get_component_detail",
            {"team_name", "region_name", "app_id", "service_id"},
            ["team_name", "region_name", "app_id", "service_id"],
        )

if __name__ == "__main__":
    unittest.main()
