#!/usr/bin/env python3
import json
import re
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCE_AND_PACKAGE_RULES = (
    REPO_ROOT
    / "rainbond-fullstack-bootstrap"
    / "modules"
    / "40-source-and-package-rules.md"
)
APP_ASSISTANT_SKILL = REPO_ROOT / "rainbond-app-assistant" / "SKILL.md"
BOOTSTRAP_SKILL = REPO_ROOT / "rainbond-fullstack-bootstrap" / "SKILL.md"


class PackageUploadWorkflowContractTest(unittest.TestCase):
    def test_client_package_upload_contract_is_documented_in_execution_order(self) -> None:
        guidance = SOURCE_AND_PACKAGE_RULES.read_text(encoding="utf-8")
        ordered_tokens = (
            "upload_local_package.py prepare",
            "rainbond_init_package_upload",
            "input_commands.package_upload.argv",
            "upload_local_package.py cleanup",
            "rainbond_get_package_upload_status",
            "rainbond_create_component_from_package",
        )

        previous_position = -1
        for token in ordered_tokens:
            position = guidance.find(token)
            self.assertNotEqual(position, -1, f"missing package-upload contract token: {token}")
            self.assertGreater(
                position,
                previous_position,
                f"package-upload contract token is out of order: {token}",
            )
            previous_position = position

        self.assertIn("Never pass `source.local_path` to a Rainbond Tool", guidance)
        self.assertIn("complete `upload_request` object through stdin", guidance)
        self.assertNotIn("--operation-id", guidance)
        self.assertNotIn("environment already bound to the protected operation", guidance)
        self.assertNotIn("`upload_request.url` -> `--upload-url`", guidance)
        self.assertNotIn("`upload_request.upload_url`", guidance)
        self.assertNotIn("Run `upload_local_package.py upload`", guidance)

    def test_runtime_contract_pins_the_complete_package_upload_argv(self) -> None:
        skill = BOOTSTRAP_SKILL.read_text(encoding="utf-8")
        gate = skill.split("<!-- rainskills-runtime-gate:start -->", 1)[1].split(
            "<!-- rainskills-runtime-gate:end -->", 1
        )[0]
        match = re.search(r"```json\n([\s\S]*?)\n```", gate)
        self.assertIsNotNone(match, "bootstrap runtime gate JSON is missing")
        contract = json.loads(match.group(1))

        self.assertEqual(
            contract["input_commands"]["package_upload"]["argv"],
            [
                "node",
                "<home>/.rainbond/bin/rainskills-tools.js",
                "package-upload",
                "--archive",
                "<archive-path>",
                "--input",
                "-",
                "--skill-id",
                "rainbond-fullstack-bootstrap",
            ],
        )
        self.assertEqual(
            contract["input_commands"]["package_upload"]["stdin_schema_source"],
            "rainbond_init_package_upload.upload_request",
        )

        guidance = SOURCE_AND_PACKAGE_RULES.read_text(encoding="utf-8")
        self.assertIn("input_commands.package_upload.argv", guidance)
        self.assertIn("不得替换为 runtime launcher", guidance)

    def test_app_assistant_does_not_offer_server_local_package_tools(self) -> None:
        guidance = APP_ASSISTANT_SKILL.read_text(encoding="utf-8")

        self.assertNotIn("rainbond_upload_package_file", guidance)
        self.assertNotIn("rainbond_create_component_from_local_package", guidance)


if __name__ == "__main__":
    unittest.main()
