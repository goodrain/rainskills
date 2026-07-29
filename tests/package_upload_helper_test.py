#!/usr/bin/env python3

import json
import os
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
HELPER = ROOT / "rainbond-fullstack-bootstrap" / "scripts" / "upload_local_package.py"


class PackageUploadHelperTest(unittest.TestCase):
    def setUp(self):
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.workspace = Path(self.temporary_directory.name) / "workspace with spaces"
        self.workspace.mkdir()
        self.staging = self.workspace / ".rainbond" / "package-upload"

    def run_helper(self, *args, cwd=None, env=None):
        return subprocess.run(
            [sys.executable, str(HELPER), *args],
            cwd=cwd or self.workspace,
            env=env,
            text=True,
            capture_output=True,
        )

    def assert_success_json(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        payload = json.loads(result.stdout)
        self.assertEqual(
            result.stdout.strip(),
            json.dumps(payload, separators=(",", ":"), sort_keys=True),
        )
        return payload

    def assert_helper_error(self, result, message):
        self.assertEqual(result.returncode, 2, result)
        self.assertEqual(result.stdout, "")
        self.assertIn(message, result.stderr)

    def test_prepare_reuses_supported_archive_without_copying_it(self):
        package = self.workspace / "release.TaR.Gz"
        package.write_bytes(b"existing-package")

        result = self.run_helper(
            "prepare",
            "--source",
            package.name,
            "--staging-root",
            ".rainbond/package-upload",
        )

        payload = self.assert_success_json(result)
        self.assertEqual(
            payload,
            {
                "archive_path": str(package.resolve()),
                "file_name": package.name,
                "generated": False,
                "staging_root": str(self.staging.resolve()),
            },
        )
        self.assertEqual(package.read_bytes(), b"existing-package")
        self.assertFalse(self.staging.exists())

    def test_prepare_directory_writes_safe_zip_and_excludes_staging(self):
        source = self.workspace / "source directory"
        nested = source / "nested folder"
        nested.mkdir(parents=True)
        (source / "app.txt").write_text("app", encoding="utf-8")
        (nested / "config.yml").write_text("setting: value", encoding="utf-8")
        staging = source / ".rainbond" / "package-upload"
        staging.mkdir(parents=True)
        (staging / "stale-secret.txt").write_text("exclude me", encoding="utf-8")

        result = self.run_helper(
            "prepare",
            "--source",
            str(source),
            "--staging-root",
            str(staging),
            "--archive-name",
            "../release ZIP",
        )

        payload = self.assert_success_json(result)
        self.assertTrue(payload["generated"])
        self.assertEqual(payload["file_name"], "release ZIP.zip")
        archive = Path(payload["archive_path"])
        self.assertEqual(archive, staging.resolve() / "release ZIP.zip")
        with zipfile.ZipFile(archive) as package_zip:
            self.assertEqual(
                package_zip.namelist(),
                ["app.txt", "nested folder/config.yml"],
            )
            self.assertNotIn("stale-secret.txt", package_zip.namelist())

    def test_prepare_archive_name_uses_only_basename_and_adds_zip_suffix(self):
        source = self.workspace / "source"
        source.mkdir()
        (source / "main.go").write_text("package main", encoding="utf-8")

        result = self.run_helper(
            "prepare",
            "--source",
            str(source),
            "--staging-root",
            str(self.staging),
            "--archive-name",
            r"..\nested\bundle.ZIP",
        )

        payload = self.assert_success_json(result)
        self.assertEqual(payload["file_name"], "bundle.ZIP")
        self.assertEqual(Path(payload["archive_path"]).parent, self.staging.resolve())

    def test_prepare_rejects_bad_source_inputs(self):
        unsupported = self.workspace / "component.txt"
        unsupported.write_text("not a package", encoding="utf-8")
        empty = self.workspace / "empty"
        empty.mkdir()
        missing = self.workspace / "missing.zip"
        source = self.workspace / "source"
        source.mkdir()
        (source / "file.txt").write_text("content", encoding="utf-8")
        source_link = self.workspace / "source-link"
        source_link.symlink_to(source, target_is_directory=True)
        nested_link = source / "linked-file"
        nested_link.symlink_to(unsupported)

        cases = (
            (unsupported, "supported package"),
            (empty, "empty"),
            (missing, "does not exist"),
            (source_link, "symbolic link"),
            (source, "symbolic link"),
        )
        for candidate, expected_error in cases:
            with self.subTest(candidate=candidate):
                result = self.run_helper(
                    "prepare",
                    "--source",
                    str(candidate),
                    "--staging-root",
                    str(self.staging),
                )
                self.assert_helper_error(result, expected_error)

    def test_prepare_rejects_nested_directory_symlink(self):
        source = self.workspace / "source"
        source.mkdir()
        (source / "real.txt").write_text("content", encoding="utf-8")
        linked_directory = source / "linked-directory"
        linked_directory.symlink_to(self.workspace, target_is_directory=True)

        result = self.run_helper(
            "prepare",
            "--source",
            str(source),
            "--staging-root",
            str(self.staging),
        )

        self.assert_helper_error(result, "symbolic link")

    def test_prepare_rejects_unsafe_staging_roots(self):
        source = self.workspace / "source"
        source.mkdir()
        (source / "app.txt").write_text("content", encoding="utf-8")
        outside = Path(self.temporary_directory.name) / "outside"
        staging_link = self.workspace / "staging-link"
        staging_link.symlink_to(outside, target_is_directory=True)

        cases = (
            (outside, "inside the current workspace"),
            (self.workspace, "below the current workspace"),
            (staging_link, "symbolic link"),
            (source, "must differ"),
        )
        for staging, expected_error in cases:
            with self.subTest(staging=staging):
                result = self.run_helper(
                    "prepare",
                    "--source",
                    str(source),
                    "--staging-root",
                    str(staging),
                )
                self.assert_helper_error(result, expected_error)

    def test_prepare_rejects_invalid_archive_name(self):
        source = self.workspace / "source"
        source.mkdir()
        (source / "file.txt").write_text("content", encoding="utf-8")

        result = self.run_helper(
            "prepare",
            "--source",
            str(source),
            "--staging-root",
            str(self.staging),
            "--archive-name",
            "../",
        )

        self.assert_helper_error(result, "archive name")

    def make_package(self, name="component package.zip"):
        package = self.workspace / name
        package.write_bytes(b"package")
        return package

    def make_fake_curl(self, mode="success"):
        fake_bin = self.workspace / ("fake curl " + mode)
        fake_bin.mkdir()
        curl = fake_bin / "curl"
        curl.write_text(
            "#!{}\n".format(sys.executable)
            + "import json, os, pathlib, sys, time\n"
            + "pathlib.Path(os.environ['CURL_ARGV_LOG']).write_text(json.dumps(sys.argv[1:]))\n"
            + "mode = os.environ.get('FAKE_CURL_MODE', 'success')\n"
            + "if mode == 'timeout':\n"
            + "    time.sleep(30)\n"
            + "if mode == 'failure':\n"
            + "    sys.stderr.write('server said credential=should-not-leak')\n"
            + "    sys.exit(22)\n",
            encoding="utf-8",
        )
        curl.chmod(0o755)
        curl_log = self.workspace / ("curl-argv-" + mode + ".json")
        env = os.environ.copy()
        env.update(
            {
                "RAINBOND_URL": "https://console.example/base",
                "PATH": str(fake_bin) + os.pathsep + env.get("PATH", ""),
                "CURL_ARGV_LOG": str(curl_log),
                "FAKE_CURL_MODE": mode,
            }
        )
        return env, curl_log

    def upload_args(self, package, upload_url="/console/upload/events/e1", **overrides):
        values = {
            "archive": str(package),
            "upload_url": upload_url,
            "url_scope": "console_origin",
            "method": "POST",
            "content_type": "multipart/form-data",
            "file_field": "packageTarFile",
            "authorization": "none",
            "timeout": "30",
        }
        values.update(overrides)
        return [
            "upload",
            "--archive",
            values["archive"],
            "--upload-url",
            values["upload_url"],
            "--url-scope",
            values["url_scope"],
            "--method",
            values["method"],
            "--content-type",
            values["content_type"],
            "--file-field",
            values["file_field"],
            "--authorization",
            values["authorization"],
            "--timeout",
            values["timeout"],
        ]

    def test_upload_uses_same_origin_relative_url_and_safe_curl_argv(self):
        package = self.make_package("component package $(touch injected).zip")
        env, curl_log = self.make_fake_curl()

        result = self.run_helper(*self.upload_args(package), env=env)

        payload = self.assert_success_json(result)
        self.assertEqual(payload, {"uploaded": True})
        argv = json.loads(curl_log.read_text(encoding="utf-8"))
        self.assertIn("--fail-with-body", argv)
        self.assertIn("--max-time", argv)
        self.assertIn("--form", argv)
        self.assertIn('packageTarFile=@"{}"'.format(package.resolve()), argv)
        self.assertEqual(argv[-1], "https://console.example/console/upload/events/e1")
        self.assertFalse(any("authorization" in value.lower() for value in argv))
        self.assertFalse((self.workspace / "injected").exists())

    def test_upload_accepts_absolute_url_with_equivalent_default_port(self):
        package = self.make_package()
        env, curl_log = self.make_fake_curl("absolute")
        env["RAINBOND_URL"] = "https://console.example:443/base"

        result = self.run_helper(
            *self.upload_args(package, "https://console.example/upload/e1"),
            env=env,
        )

        self.assert_success_json(result)
        argv = json.loads(curl_log.read_text(encoding="utf-8"))
        self.assertEqual(argv[-1], "https://console.example/upload/e1")

    def test_upload_rejects_invalid_contract_fields(self):
        package = self.make_package()
        env, _ = self.make_fake_curl("invalid-contract")
        cases = (
            ({"url_scope": "arbitrary"}, "console_origin"),
            ({"method": "PUT"}, "POST"),
            ({"method": "post"}, "POST"),
            ({"content_type": "application/json"}, "multipart/form-data"),
            ({"authorization": "bearer"}, "none"),
            ({"file_field": "bad;field"}, "file field"),
            ({"timeout": "0"}, "greater than zero"),
        )
        for overrides, expected_error in cases:
            with self.subTest(overrides=overrides):
                result = self.run_helper(*self.upload_args(package, **overrides), env=env)
                self.assert_helper_error(result, expected_error)

    def test_upload_rejects_invalid_upload_urls(self):
        package = self.make_package()
        env, _ = self.make_fake_curl("invalid-url")
        cases = (
            ("https://other.example/upload", "same Console origin"),
            ("http://console.example/upload", "same Console origin"),
            ("https://user:secret@console.example/upload", "user information"),
            ("https://console.example/upload#fragment", "fragment"),
            ("https://console.example:bad/upload", "invalid port"),
            ("ftp://console.example/upload", "HTTP(S) URL"),
            ("//other.example/upload", "same Console origin"),
            ("", "upload URL"),
        )
        for upload_url, expected_error in cases:
            with self.subTest(upload_url=upload_url):
                result = self.run_helper(
                    *self.upload_args(package, upload_url),
                    env=env,
                )
                self.assert_helper_error(result, expected_error)
                self.assertNotIn("secret", result.stderr)

    def test_upload_rejects_missing_or_invalid_console_base(self):
        package = self.make_package()
        original_env, _ = self.make_fake_curl("invalid-base")
        cases = (
            (None, "RAINBOND_URL"),
            ("console.example", "HTTP(S) URL"),
            ("ftp://console.example", "HTTP(S) URL"),
            ("https://user:base-secret@console.example", "user information"),
            ("https://console.example:bad", "invalid port"),
            ("https://console.example/base#fragment", "fragment"),
        )
        for base_url, expected_error in cases:
            with self.subTest(base_url=base_url):
                env = original_env.copy()
                if base_url is None:
                    env.pop("RAINBOND_URL", None)
                else:
                    env["RAINBOND_URL"] = base_url
                result = self.run_helper(*self.upload_args(package), env=env)
                self.assert_helper_error(result, expected_error)
                self.assertNotIn("base-secret", result.stderr)

    def test_upload_rejects_nondefault_port_change(self):
        package = self.make_package()
        env, _ = self.make_fake_curl("port")
        env["RAINBOND_URL"] = "https://console.example:8443/base"

        result = self.run_helper(
            *self.upload_args(package, "https://console.example/upload"),
            env=env,
        )

        self.assert_helper_error(result, "same Console origin")

    def test_upload_rejects_bad_archives(self):
        env, _ = self.make_fake_curl("bad-archive")
        unsupported = self.workspace / "component.txt"
        unsupported.write_text("not package", encoding="utf-8")
        directory = self.workspace / "directory.zip"
        directory.mkdir()
        missing = self.workspace / "missing.zip"
        real = self.make_package("real.zip")
        link = self.workspace / "linked.zip"
        link.symlink_to(real)
        cases = (
            (unsupported, "supported package"),
            (directory, "file"),
            (missing, "does not exist"),
            (link, "symbolic link"),
        )
        for archive, expected_error in cases:
            with self.subTest(archive=archive):
                result = self.run_helper(*self.upload_args(archive), env=env)
                self.assert_helper_error(result, expected_error)

    def test_upload_reports_curl_failure_without_echoing_output(self):
        package = self.make_package()
        env, _ = self.make_fake_curl("failure")

        result = self.run_helper(*self.upload_args(package), env=env)

        self.assert_helper_error(result, "curl exit 22")
        self.assertNotIn("credential=should-not-leak", result.stderr)
        self.assertNotIn(env["RAINBOND_URL"], result.stderr)

    def test_upload_reports_timeout(self):
        package = self.make_package()
        env, _ = self.make_fake_curl("timeout")

        result = self.run_helper(
            *self.upload_args(package, timeout="1"),
            env=env,
        )

        self.assert_helper_error(result, "timed out")

    def test_upload_reports_missing_curl(self):
        package = self.make_package()
        empty_path = self.workspace / "empty-path"
        empty_path.mkdir()
        env = os.environ.copy()
        env.update(
            {
                "RAINBOND_URL": "https://console.example",
                "PATH": str(empty_path),
            }
        )

        result = self.run_helper(*self.upload_args(package), env=env)

        self.assert_helper_error(result, "curl executable was not found")

    def test_cleanup_deletes_generated_archive_and_is_idempotent(self):
        self.staging.mkdir(parents=True)
        archive = self.staging / "generated.zip"
        archive.write_bytes(b"generated")

        first = self.run_helper(
            "cleanup",
            "--archive",
            str(archive),
            "--staging-root",
            str(self.staging),
            "--generated",
            "true",
        )
        second = self.run_helper(
            "cleanup",
            "--archive",
            str(archive),
            "--staging-root",
            str(self.staging),
            "--generated",
            "true",
        )

        self.assertEqual(self.assert_success_json(first), {"cleaned": True})
        self.assertEqual(self.assert_success_json(second), {"cleaned": True})
        self.assertFalse(archive.exists())
        self.assertFalse(self.staging.exists())

    def test_cleanup_generated_false_preserves_original_as_true_noop(self):
        original = self.make_package("original.war")
        outside_staging = Path(self.temporary_directory.name) / "outside-staging"

        result = self.run_helper(
            "cleanup",
            "--archive",
            str(original),
            "--staging-root",
            str(outside_staging),
            "--generated",
            "false",
        )

        self.assertEqual(self.assert_success_json(result), {"cleaned": False})
        self.assertEqual(original.read_bytes(), b"package")

    def test_cleanup_rejects_outside_root_and_staging_root_itself(self):
        self.staging.mkdir(parents=True)
        outside = self.make_package("outside.zip")
        cases = (
            (outside, "inside staging root"),
            (self.staging, "must not be the staging directory"),
        )
        for archive, expected_error in cases:
            with self.subTest(archive=archive):
                result = self.run_helper(
                    "cleanup",
                    "--archive",
                    str(archive),
                    "--staging-root",
                    str(self.staging),
                    "--generated",
                    "true",
                )
                self.assert_helper_error(result, expected_error)
        self.assertTrue(outside.exists())

    def test_cleanup_rejects_symlink_and_directory(self):
        self.staging.mkdir(parents=True)
        target = self.workspace / "target.zip"
        target.write_bytes(b"keep")
        link = self.staging / "linked.zip"
        link.symlink_to(target)
        directory = self.staging / "directory.zip"
        directory.mkdir()
        cases = (
            (link, "symbolic link"),
            (directory, "regular file"),
        )
        for archive, expected_error in cases:
            with self.subTest(archive=archive):
                result = self.run_helper(
                    "cleanup",
                    "--archive",
                    str(archive),
                    "--staging-root",
                    str(self.staging),
                    "--generated",
                    "true",
                )
                self.assert_helper_error(result, expected_error)
        self.assertEqual(target.read_bytes(), b"keep")

    def test_cleanup_removes_only_empty_staging_leaf(self):
        self.staging.mkdir(parents=True)
        archive = self.staging / "generated.zip"
        archive.write_bytes(b"generated")
        sibling = self.staging / "keep.txt"
        sibling.write_text("keep", encoding="utf-8")

        result = self.run_helper(
            "cleanup",
            "--archive",
            str(archive),
            "--staging-root",
            str(self.staging),
            "--generated",
            "true",
        )

        self.assert_success_json(result)
        self.assertFalse(archive.exists())
        self.assertTrue(sibling.exists())
        self.assertTrue(self.staging.exists())

    def test_cleanup_rejects_invalid_generated_value_and_staging_symlink(self):
        self.staging.mkdir(parents=True)
        archive = self.staging / "generated.zip"
        archive.write_bytes(b"generated")
        for value in ("True", "1", "yes", ""):
            with self.subTest(value=value):
                result = self.run_helper(
                    "cleanup",
                    "--archive",
                    str(archive),
                    "--staging-root",
                    str(self.staging),
                    "--generated",
                    value,
                )
                self.assert_helper_error(result, "generated must be true or false")
        staging_link = self.workspace / "staging-link"
        staging_link.symlink_to(self.staging, target_is_directory=True)
        result = self.run_helper(
            "cleanup",
            "--archive",
            str(archive),
            "--staging-root",
            str(staging_link),
            "--generated",
            "true",
        )
        self.assert_helper_error(result, "symbolic link")
        self.assertTrue(archive.exists())


if __name__ == "__main__":
    unittest.main()
