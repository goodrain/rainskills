#!/usr/bin/env python3
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / "rainbond-app-assistant" / "references" / "workflow-rules.md"
PROJECT_INIT = ROOT / "rainbond-project-init" / "SKILL.md"
BOOTSTRAP = ROOT / "rainbond-fullstack-bootstrap" / "SKILL.md"


class LocalProjectInitGateTest(unittest.TestCase):
    def test_local_package_initialization_gate_runs_before_upload(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        gate = workflow.split("### 1. Local artifact initialization gate", 1)[1].split("### 2.", 1)[0]

        self.assertIn("本地软件包部署必须先完成本地项目初始化", gate)
        self.assertIn("rainbond.app.json", gate)
        self.assertIn(".rainbond/local.json", gate)
        self.assertIn("rainbond-project-init", gate)
        self.assertIn("source.local_path", gate)

    def test_existing_platform_app_requires_adopt_for_local_package(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")

        self.assertIn("本地软件包部署必须先完成本地项目初始化", workflow)
        self.assertIn("adopt/link", workflow)

    def test_address_only_source_and_image_do_not_require_local_files(self) -> None:
        workflow = WORKFLOW.read_text(encoding="utf-8")
        gate = workflow.split("### 1. Local artifact initialization gate", 1)[1].split("### 2.", 1)[0]

        self.assertIn("address-only source/image requests do not require local project files", gate)
        self.assertIn("bare Git URL", gate)
        self.assertIn("image reference", gate)
        self.assertIn("不得要求生成 `rainbond.app.json` 或 `.rainbond/local.json`", gate)

    def test_project_init_allows_orchestrated_local_project_initialization(self) -> None:
        project_init = PROJECT_INIT.read_text(encoding="utf-8")
        frontmatter = project_init.split("---", 2)[1]

        self.assertIn("rainbond-app-assistant", frontmatter)
        self.assertIn("local package", frontmatter)
        self.assertNotIn("Use only when the user explicitly asks", frontmatter)
        self.assertIn("address-only guard", project_init)

    def test_bootstrap_requires_init_only_for_local_artifacts(self) -> None:
        bootstrap = BOOTSTRAP.read_text(encoding="utf-8")

        self.assertIn("Local artifact precondition", bootstrap)
        self.assertIn("just-completed `rainbond-project-init`", bootstrap)
        self.assertIn("address-only Git or image", bootstrap)


if __name__ == "__main__":
    unittest.main()
