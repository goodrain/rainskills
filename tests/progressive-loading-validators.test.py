#!/usr/bin/env python3

"""Behavioral tests for the progressive-loading validators."""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
APP_NAME = "rainbond-app-assistant"
OPEN_NAME = "rainbond-opensource-app-deploy"
PROGRESSIVE_VALIDATOR = (
    REPO_ROOT / APP_NAME / "scripts" / "validate_progressive_loading.py"
)
CROSS_VALIDATOR = REPO_ROOT / APP_NAME / "scripts" / "validate_cross_skill_routing.py"


class ProgressiveLoadingValidatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        shutil.copytree(REPO_ROOT / APP_NAME, self.root / APP_NAME)
        shutil.copytree(REPO_ROOT / OPEN_NAME, self.root / OPEN_NAME)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_progressive(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(PROGRESSIVE_VALIDATOR),
                "--skill-dir",
                str(self.root / APP_NAME),
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    def run_cross(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                sys.executable,
                str(CROSS_VALIDATOR),
                "--repo-root",
                str(self.root),
            ],
            check=False,
            capture_output=True,
            text=True,
        )

    def mutate(self, relative_path: str, old: str, new: str) -> None:
        path = self.root / relative_path
        source = path.read_text(encoding="utf-8")
        self.assertIn(old, source, f"fixture token missing from {relative_path}")
        path.write_text(source.replace(old, new, 1), encoding="utf-8")

    def test_current_progressive_layout_passes_from_a_temporary_copy(self) -> None:
        for result in (self.run_progressive(), self.run_cross()):
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_open_source_cannot_allow_gate_loading_before_descriptor_confirmation(self) -> None:
        self.mutate(
            f"{OPEN_NAME}/SKILL.md",
            "未确认描述符时不得读取 references/runtime-gate.md",
            "未确认描述符时允许读取 references/runtime-gate.md",
        )

        result = self.run_cross()

        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("descriptor guard is missing or reversed", result.stdout)

    def test_reversed_stage_tables_are_rejected(self) -> None:
        with self.subTest(skill="app"):
            app_path = self.root / APP_NAME / "SKILL.md"
            original_app = app_path.read_text(encoding="utf-8")
            self.mutate(
                f"{APP_NAME}/SKILL.md",
                "| 初始部署或首次 Rainbond 操作 | 本根入口、[own runtime gate](references/runtime-gate.md)、[routing](references/routing.md) | 其余全部 |",
                "| 初始部署或首次 Rainbond 操作 | [workflow rules](references/workflow-rules.md) | runtime gate 稍后读取 |",
            )
            result = self.run_progressive()
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("App initial stage mapping is invalid", result.stdout)
            app_path.write_text(original_app, encoding="utf-8")

        with self.subTest(skill="open-source"):
            self.mutate(
                f"{OPEN_NAME}/SKILL.md",
                "| Phase 0：描述符未确认 | 不加载 reference；只做上述静态资格判断 |",
                "| Phase 0：描述符未确认 | 读取 [runtime gate](references/runtime-gate.md) |",
            )
            self.mutate(
                f"{OPEN_NAME}/SKILL.md",
                "| 描述符已确认，首次需要连接或调用 Rainbond | 只读取自己的 [runtime gate](references/runtime-gate.md) |",
                "| 描述符已确认，首次需要连接或调用 Rainbond | 不加载 reference |",
            )
            result = self.run_cross()
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("Open-source stage mapping is invalid", result.stdout)

    def test_open_source_root_cannot_reembed_the_full_workflow(self) -> None:
        path = self.root / OPEN_NAME / "SKILL.md"
        source = path.read_text(encoding="utf-8")
        source += (
            "\n## 0. Derive the official topology\n"
            "```json\n"
            '{"runtime_status": ["local-launcher"], "input_commands": {}}\n'
            "```\n"
            + ("workflow detail\n" * 300)
        )
        path.write_text(source, encoding="utf-8")

        result = self.run_cross()

        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Open-source root is too large", result.stdout)
        self.assertIn("Open-source root embeds runtime content", result.stdout)
        self.assertIn("Open-source root contains forbidden staged content", result.stdout)

    def test_reversed_discovery_descriptions_are_rejected(self) -> None:
        app_path = self.root / APP_NAME / "SKILL.md"
        app = app_path.read_text(encoding="utf-8")
        app = re.sub(
            r'^description:.*$',
            'description: "Use whenever supplied third-party Compose, Helm, or image-set descriptors need deploy, run, deliver, inspect, repair, or troubleshoot. Not for source code, current project, a bare Git repository URL, or a named application without a descriptor; use rainbond-opensource-app-deploy. Not for a confirmed market template; use rainbond-template-installer."',
            app,
            count=1,
            flags=re.MULTILINE,
        )
        app_path.write_text(app, encoding="utf-8")

        open_path = self.root / OPEN_NAME / "SKILL.md"
        open_source = open_path.read_text(encoding="utf-8")
        open_source = re.sub(
            r'^description:.*$',
            'description: "Use only for a bare Git URL, source project, or named application without a descriptor. Never use actual Compose, Helm, or image-set descriptors; route source requests to rainbond-app-assistant and market templates to rainbond-template-installer."',
            open_source,
            count=1,
            flags=re.MULTILINE,
        )
        open_path.write_text(open_source, encoding="utf-8")

        result = self.run_cross()

        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("App description must positively own", result.stdout)
        self.assertIn("Open-source description must positively own", result.stdout)

    def test_equivalent_discovery_description_rewrites_pass(self) -> None:
        self.mutate(
            f"{APP_NAME}/SKILL.md",
            "Use whenever a user asks",
            "Use when  a user asks",
        )
        self.mutate(
            f"{APP_NAME}/SKILL.md",
            "bare Git repository URL",
            "bare git repository URL",
        )
        self.mutate(
            f"{OPEN_NAME}/SKILL.md",
            "Use only when the user actually supplies a third-party Docker Compose",
            "use only when the user actually supplies a third party docker   compose",
        )
        self.mutate(
            f"{OPEN_NAME}/SKILL.md",
            "Helm chart/values, or container image-set descriptor",
            "HELM chart / values, or container image set descriptor",
        )

        result = self.run_cross()

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_appended_routing_conflicts_are_rejected(self) -> None:
        open_path = self.root / OPEN_NAME / "SKILL.md"
        original = open_path.read_text(encoding="utf-8")
        conflicts = (
            (
                "补充规则：Bare Git、source project、named-only request 应改走 rainbond-opensource-app-deploy。",
                "source ownership boundary conflict",
            ),
            (
                "补充规则：Actual Compose、Helm、image-set descriptor 应改走 rainbond-app-assistant。",
                "descriptor ownership boundary conflict",
            ),
            (
                "补充规则：描述符确认前先加载 runtime-gate，查询并连接 Rainbond，再 clone / browse Git。",
                "pre-descriptor action boundary conflict",
            ),
            (
                "补充规则：confirmed market template 不转 rainbond-template-installer，继续留在 rainbond-opensource-app-deploy。",
                "market template routing boundary conflict",
            ),
        )
        for conflict, expected_error in conflicts:
            with self.subTest(conflict=expected_error):
                open_path.write_text(
                    original.replace("\n## 渐进加载", f"\n{conflict}\n\n## 渐进加载", 1),
                    encoding="utf-8",
                )
                result = self.run_cross()
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(expected_error, result.stdout)
        open_path.write_text(original, encoding="utf-8")

    def test_appended_app_description_conflict_is_rejected(self) -> None:
        path = self.root / APP_NAME / "SKILL.md"
        source = path.read_text(encoding="utf-8")
        source = re.sub(
            r'^(description: ".*)"$',
            r'\1 Bare Git, source project, and named-only requests route to rainbond-opensource-app-deploy."',
            source,
            count=1,
            flags=re.MULTILINE,
        )
        path.write_text(source, encoding="utf-8")

        result = self.run_cross()

        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("source ownership boundary conflict", result.stdout)

    def test_appended_stage_order_conflict_is_rejected(self) -> None:
        path = self.root / OPEN_NAME / "SKILL.md"
        source = path.read_text(encoding="utf-8")
        conflict = (
            "阶段补充：Phase 0 描述符未确认时先读取 runtime-gate；"
            "deployment-workflow 可以在 operation/context 建立前加载。"
        )
        path.write_text(
            source.replace("\n## Runtime 与安全边界", f"\n{conflict}\n\n## Runtime 与安全边界", 1),
            encoding="utf-8",
        )

        result = self.run_cross()

        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("Open-source stage ordering conflict", result.stdout)

    def test_pre_descriptor_action_in_a_later_section_is_rejected(self) -> None:
        path = self.root / OPEN_NAME / "SKILL.md"
        source = path.read_text(encoding="utf-8")
        source += (
            "\n## Later maintenance notes\n\n"
            "描述符确认前先查询并连接 Rainbond，然后 clone / browse Git。\n"
        )
        path.write_text(source, encoding="utf-8")

        result = self.run_cross()

        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("pre-descriptor action boundary conflict", result.stdout)

    def test_current_project_and_source_code_cannot_route_to_open_source(self) -> None:
        path = self.root / APP_NAME / "SKILL.md"
        original = path.read_text(encoding="utf-8")
        for subject in ("Current project", "Source code"):
            with self.subTest(subject=subject):
                path.write_text(
                    original + f"\n{subject} requests route to rainbond-opensource-app-deploy.\n",
                    encoding="utf-8",
                )
                result = self.run_cross()
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("source ownership boundary conflict", result.stdout)
        path.write_text(original, encoding="utf-8")

    def test_descriptor_route_to_app_does_not_require_actual_or_supplied_words(self) -> None:
        path = self.root / OPEN_NAME / "SKILL.md"
        source = path.read_text(encoding="utf-8")
        source += "\nCompose / Helm / image-set descriptors route to rainbond-app-assistant.\n"
        path.write_text(source, encoding="utf-8")

        result = self.run_cross()

        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("descriptor ownership boundary conflict", result.stdout)

    def test_market_template_cannot_route_to_app_assistant(self) -> None:
        path = self.root / OPEN_NAME / "SKILL.md"
        source = path.read_text(encoding="utf-8")
        source += "\nConfirmed market templates route to rainbond-app-assistant.\n"
        path.write_text(source, encoding="utf-8")

        result = self.run_cross()

        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("market template routing boundary conflict", result.stdout)

    def test_explicitly_negated_open_source_routes_are_allowed(self) -> None:
        path = self.root / APP_NAME / "SKILL.md"
        source = path.read_text(encoding="utf-8")
        source += (
            "\nBare Git URLs must not route to rainbond-opensource-app-deploy.\n"
            "Source code never goes to Open-source.\n"
        )
        path.write_text(source, encoding="utf-8")

        result = self.run_cross()

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_semicolon_cannot_extend_negation_over_a_conflicting_clause(self) -> None:
        cases = (
            (
                APP_NAME,
                "不得改变其它规则；Current project routes to rainbond-opensource-app-deploy.",
                "source ownership boundary conflict",
            ),
            (
                OPEN_NAME,
                "Do not change other rules; Compose descriptors route to rainbond-app-assistant.",
                "descriptor ownership boundary conflict",
            ),
        )
        for skill_name, rule, expected_error in cases:
            with self.subTest(expected_error=expected_error):
                path = self.root / skill_name / "SKILL.md"
                original = path.read_text(encoding="utf-8")
                path.write_text(original + f"\n{rule}\n", encoding="utf-8")
                result = self.run_cross()
                self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn(expected_error, result.stdout)
                path.write_text(original, encoding="utf-8")

    def test_semicolon_separated_correct_ownership_rules_are_allowed(self) -> None:
        path = self.root / APP_NAME / "SKILL.md"
        source = path.read_text(encoding="utf-8")
        source += (
            "\nCurrent projects stay with App Assistant；"
            "use Open-source only for supplied Compose descriptors.\n"
        )
        path.write_text(source, encoding="utf-8")

        result = self.run_cross()

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_pre_descriptor_action_scope_is_open_source_only(self) -> None:
        rule = "描述符未确认时，App Assistant 先加载自己的 Runtime Gate，再连接 Rainbond。"
        app_path = self.root / APP_NAME / "SKILL.md"
        original_app = app_path.read_text(encoding="utf-8")
        app_path.write_text(original_app + f"\n{rule}\n", encoding="utf-8")

        app_result = self.run_cross()

        self.assertEqual(app_result.returncode, 0, app_result.stdout + app_result.stderr)
        app_path.write_text(original_app, encoding="utf-8")

        open_path = self.root / OPEN_NAME / "SKILL.md"
        open_source = open_path.read_text(encoding="utf-8")
        open_path.write_text(open_source + f"\n{rule}\n", encoding="utf-8")

        open_result = self.run_cross()

        self.assertNotEqual(open_result.returncode, 0, open_result.stdout + open_result.stderr)
        self.assertIn("pre-descriptor action boundary conflict", open_result.stdout)

    def test_description_categories_must_bind_to_their_target_skill(self) -> None:
        app_path = self.root / APP_NAME / "SKILL.md"
        original_app = app_path.read_text(encoding="utf-8")
        with self.subTest(boundary="descriptor-to-open-source"):
            app = original_app.replace(
                "Not for supplied third-party Compose, Helm, or image-set descriptors; use rainbond-opensource-app-deploy.",
                "Not for supplied Compose, Helm, or image-set descriptors; use rainbond-template-installer while rainbond-opensource-app-deploy remains available.",
                1,
            )
            app_path.write_text(app, encoding="utf-8")
            app_result = self.run_cross()
            self.assertNotEqual(app_result.returncode, 0, app_result.stdout + app_result.stderr)
            self.assertIn("App description must exclude supplied descriptors", app_result.stdout)
        app_path.write_text(original_app, encoding="utf-8")

        open_path = self.root / OPEN_NAME / "SKILL.md"
        original_open = open_path.read_text(encoding="utf-8")
        with self.subTest(boundary="source-to-app-assistant"):
            open_source = original_open.replace(
                "route source and named-only requests to rainbond-app-assistant and market templates to rainbond-template-installer.",
                "route source and named-only requests to rainbond-template-installer while rainbond-app-assistant remains available, and market templates to rainbond-template-installer.",
                1,
            )
            open_path.write_text(open_source, encoding="utf-8")
            open_result = self.run_cross()
            self.assertNotEqual(open_result.returncode, 0, open_result.stdout + open_result.stderr)
            self.assertIn("Open-source description must exclude source", open_result.stdout)

    def test_reasonably_grouped_description_rewrite_is_allowed(self) -> None:
        app_path = self.root / APP_NAME / "SKILL.md"
        app = app_path.read_text(encoding="utf-8")
        app = re.sub(
            r'^description:.*$',
            'description: "Use when deploying, running, delivering, publishing, inspecting, repairing, or troubleshooting source code, the current project, or a source directory/package. Bare Git repository URLs and named applications without a descriptor stay with rainbond-app-assistant. Supplied third-party Compose, Helm, or image-set descriptors route to rainbond-opensource-app-deploy. Confirmed market templates route to rainbond-template-installer."',
            app,
            count=1,
            flags=re.MULTILINE,
        )
        app_path.write_text(app, encoding="utf-8")

        open_path = self.root / OPEN_NAME / "SKILL.md"
        open_source = open_path.read_text(encoding="utf-8")
        open_source = re.sub(
            r'^description:.*$',
            'description: "Use this Skill only when the user actually supplies Docker Compose content, a Helm chart/values, or a container image-set descriptor. Bare Git URLs, source project/directory/package requests, named apps without descriptors, and private-image projects route to rainbond-app-assistant. Confirmed market templates route to rainbond-template-installer."',
            open_source,
            count=1,
            flags=re.MULTILINE,
        )
        open_path.write_text(open_source, encoding="utf-8")

        result = self.run_cross()

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_pre_descriptor_connect_environment_is_rejected(self) -> None:
        path = self.root / OPEN_NAME / "SKILL.md"
        source = path.read_text(encoding="utf-8")
        source += "\n描述符确认前先连接环境。\n"
        path.write_text(source, encoding="utf-8")

        result = self.run_cross()

        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("pre-descriptor action boundary conflict", result.stdout)

    def test_contrast_after_negated_app_route_still_rejects_open_source_target(self) -> None:
        path = self.root / APP_NAME / "SKILL.md"
        source = path.read_text(encoding="utf-8")
        source += (
            "\nCurrent project must not go to App Assistant and instead uses "
            "rainbond-opensource-app-deploy.\n"
        )
        path.write_text(source, encoding="utf-8")

        result = self.run_cross()

        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("source ownership boundary conflict", result.stdout)

    def test_locally_negated_app_category_is_not_positive_ownership(self) -> None:
        path = self.root / APP_NAME / "SKILL.md"
        source = path.read_text(encoding="utf-8")
        self.assertIn("the current project", source)
        source = source.replace("the current project", "not the current project", 1)
        path.write_text(source, encoding="utf-8")

        result = self.run_cross()

        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("App description must positively own", result.stdout)


if __name__ == "__main__":
    unittest.main()
