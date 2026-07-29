#!/usr/bin/env python3
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


class PackageUploadWorkflowContractTest(unittest.TestCase):
    def test_client_package_upload_contract_is_documented_in_execution_order(self) -> None:
        guidance = SOURCE_AND_PACKAGE_RULES.read_text(encoding="utf-8")
        ordered_tokens = (
            "upload_local_package.py prepare",
            "rainbond_init_package_upload",
            "upload_local_package.py upload",
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

        self.assertIn("Never pass `source.local_path` to an MCP tool", guidance)
        self.assertIn("`upload_request.url` -> `--upload-url`", guidance)
        self.assertNotIn("`upload_request.upload_url`", guidance)

    def test_app_assistant_does_not_offer_server_local_package_tools(self) -> None:
        guidance = APP_ASSISTANT_SKILL.read_text(encoding="utf-8")

        self.assertNotIn("rainbond_upload_package_file", guidance)
        self.assertNotIn("rainbond_create_component_from_local_package", guidance)


if __name__ == "__main__":
    unittest.main()
