#!/usr/bin/env python3

"""Prepare, upload, and clean local packages for Rainbond MCP workflows."""

import argparse
import json
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit


SUPPORTED_SUFFIXES = (".zip", ".jar", ".war", ".tar", ".tar.gz")
FIELD_NAME_RE = re.compile(r"^[A-Za-z0-9_.-]+$")


class HelperError(Exception):
    """Raised when an operation would violate the helper contract."""


def resolve_argument_path(value):
    path = Path(value).expanduser()
    return path if path.is_absolute() else Path.cwd() / path


def require_staging_root(value):
    workspace = Path.cwd().resolve()
    raw_staging = resolve_argument_path(value)
    if raw_staging.is_symlink():
        raise HelperError("staging root must not be a symbolic link")
    staging = raw_staging.resolve(strict=False)
    try:
        relative = staging.relative_to(workspace)
    except ValueError:
        raise HelperError("staging root must be inside the current workspace")
    if not relative.parts:
        raise HelperError("staging root must be below the current workspace")
    return staging


def require_supported_suffix(name):
    if not name.lower().endswith(SUPPORTED_SUFFIXES):
        raise HelperError(
            "source file must be a supported package: zip, jar, war, tar, or tar.gz"
        )


def safe_archive_name(value):
    normalized = str(value or "").replace("\\", "/").rstrip("/")
    name = normalized.rsplit("/", 1)[-1] if normalized else ""
    if name in ("", ".", ".."):
        raise HelperError("archive name must contain a file name")
    if not name.lower().endswith(".zip"):
        name += ".zip"
    return name


def collect_regular_files(source, excluded_root):
    files = []
    for root, directory_names, file_names in os.walk(
        source, topdown=True, followlinks=False
    ):
        root_path = Path(root)
        if root_path.resolve() == excluded_root:
            directory_names[:] = []
            continue

        kept_directories = []
        for name in sorted(directory_names):
            child = root_path / name
            if child.is_symlink():
                raise HelperError(
                    "source contains symbolic link: {}".format(child.relative_to(source))
                )
            if child.resolve(strict=False) != excluded_root:
                kept_directories.append(name)
        directory_names[:] = kept_directories

        for name in sorted(file_names):
            child = root_path / name
            if child.is_symlink():
                raise HelperError(
                    "source contains symbolic link: {}".format(child.relative_to(source))
                )
            if child.is_file():
                files.append(child)
    return files


def prepare_package(source_value, staging_value, archive_name):
    raw_source = resolve_argument_path(source_value)
    if raw_source.is_symlink():
        raise HelperError("source must not be a symbolic link")
    try:
        source = raw_source.resolve(strict=True)
    except FileNotFoundError:
        raise HelperError("source does not exist")
    if not source.exists():
        raise HelperError("source does not exist")

    staging = require_staging_root(staging_value)
    if source.is_file():
        require_supported_suffix(source.name)
        return {
            "archive_path": str(source),
            "file_name": source.name,
            "generated": False,
            "staging_root": str(staging),
        }
    if not source.is_dir():
        raise HelperError("source must be a package file or directory")
    if source == staging:
        raise HelperError("source directory and staging root must differ")

    files = collect_regular_files(source, staging)
    if not files:
        raise HelperError("source directory is empty")

    staging.mkdir(parents=True, exist_ok=True)
    archive = staging / safe_archive_name(archive_name or source.name)
    if archive.is_symlink():
        raise HelperError("generated archive must not be a symbolic link")
    with zipfile.ZipFile(str(archive), "w", compression=zipfile.ZIP_DEFLATED) as output:
        for file_path in files:
            output.write(str(file_path), file_path.relative_to(source).as_posix())
    return {
        "archive_path": str(archive),
        "file_name": archive.name,
        "generated": True,
        "staging_root": str(staging),
    }


def parse_http_url(value, label):
    if not value:
        raise HelperError("{} must be provided".format(label))
    if any(character.isspace() for character in value):
        raise HelperError("{} must be an HTTP(S) URL".format(label))
    try:
        parsed = urlsplit(value)
    except ValueError:
        raise HelperError("{} must be an HTTP(S) URL".format(label))
    try:
        hostname = parsed.hostname
        username = parsed.username
        password = parsed.password
    except ValueError:
        raise HelperError("{} must be an HTTP(S) URL".format(label))
    if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc or not hostname:
        raise HelperError("{} must be an HTTP(S) URL".format(label))
    if username is not None or password is not None:
        raise HelperError("{} must not contain user information".format(label))
    try:
        port = parsed.port
    except ValueError:
        raise HelperError("{} has an invalid port".format(label))
    if parsed.fragment:
        raise HelperError("{} must not contain a fragment".format(label))
    effective_port = port or (443 if parsed.scheme.lower() == "https" else 80)
    origin = (parsed.scheme.lower(), hostname.lower(), effective_port)
    return parsed, origin


def resolve_upload_url(base_value, upload_value):
    if not base_value:
        raise HelperError("RAINBOND_URL must be provided")
    _, base_origin = parse_http_url(base_value, "RAINBOND_URL")
    if not upload_value:
        raise HelperError("upload URL must be provided")
    resolved = urljoin(base_value.rstrip("/") + "/", upload_value)
    parsed, upload_origin = parse_http_url(resolved, "upload URL")
    if upload_origin != base_origin:
        raise HelperError("upload URL must use the same Console origin as RAINBOND_URL")
    return urlunsplit(parsed)


def validate_upload_contract(args):
    if args.url_scope != "console_origin":
        raise HelperError("url scope must be console_origin")
    if args.method != "POST":
        raise HelperError("upload method must be POST")
    if args.content_type != "multipart/form-data":
        raise HelperError("content type must be multipart/form-data")
    if args.authorization != "none":
        raise HelperError("upload authorization must be none")
    if not FIELD_NAME_RE.fullmatch(args.file_field):
        raise HelperError("file field contains unsupported characters")


def curl_file_form(field, archive):
    escaped = str(archive).replace("\\", "\\\\").replace('"', '\\"')
    return '{}=@"{}"'.format(field, escaped)


def upload_package(args):
    validate_upload_contract(args)
    raw_archive = resolve_argument_path(args.archive)
    if raw_archive.is_symlink():
        raise HelperError("archive must not be a symbolic link")
    try:
        archive = raw_archive.resolve(strict=True)
    except FileNotFoundError:
        raise HelperError("archive does not exist")
    if not archive.is_file():
        raise HelperError("archive must be a file")
    require_supported_suffix(archive.name)

    target = resolve_upload_url(os.environ.get("RAINBOND_URL"), args.upload_url)
    command = [
        "curl",
        "--disable",
        "--fail-with-body",
        "--silent",
        "--show-error",
        "--max-time",
        str(args.timeout),
        "--request",
        "POST",
        "--form",
        curl_file_form(args.file_field, archive),
        target,
    ]
    try:
        result = subprocess.run(
            command,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            timeout=args.timeout + 1,
        )
    except FileNotFoundError:
        raise HelperError("curl executable was not found")
    except subprocess.TimeoutExpired:
        raise HelperError("package upload timed out")
    if result.returncode:
        raise HelperError("package upload failed with curl exit {}".format(result.returncode))
    return {"uploaded": True}


def parse_generated(value):
    if value not in ("true", "false"):
        raise HelperError("generated must be true or false")
    return value == "true"


def cleanup_package(archive_value, staging_value, generated_value):
    if not parse_generated(generated_value):
        return {"cleaned": False}

    staging = require_staging_root(staging_value)
    raw_archive = resolve_argument_path(archive_value)
    if raw_archive.is_symlink():
        raise HelperError("generated archive must not be a symbolic link")
    archive = raw_archive.resolve(strict=False)
    try:
        relative = archive.relative_to(staging)
    except ValueError:
        raise HelperError("generated archive must be inside staging root")
    if not relative.parts:
        raise HelperError("generated archive must not be the staging directory")

    if archive.exists():
        if not archive.is_file():
            raise HelperError("generated archive must be a regular file")
        archive.unlink()
    try:
        staging.rmdir()
    except OSError:
        pass
    return {"cleaned": True}


def positive_int(value):
    try:
        parsed = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("must be an integer")
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be greater than zero")
    return parsed


def build_parser():
    parser = argparse.ArgumentParser(
        description="Prepare, upload, and clean Rainbond local packages"
    )
    commands = parser.add_subparsers(dest="command", required=True)

    prepare = commands.add_parser("prepare")
    prepare.add_argument("--source", required=True)
    prepare.add_argument("--staging-root", required=True)
    prepare.add_argument("--archive-name", default="")

    upload = commands.add_parser("upload")
    upload.add_argument("--archive", required=True)
    upload.add_argument("--upload-url", required=True)
    upload.add_argument("--url-scope", required=True)
    upload.add_argument("--method", required=True)
    upload.add_argument("--content-type", required=True)
    upload.add_argument("--file-field", required=True)
    upload.add_argument("--authorization", required=True)
    upload.add_argument("--timeout", type=positive_int, default=1800)

    cleanup = commands.add_parser("cleanup")
    cleanup.add_argument("--archive", required=True)
    cleanup.add_argument("--staging-root", required=True)
    cleanup.add_argument("--generated", required=True)
    return parser


def main():
    args = build_parser().parse_args()
    try:
        if args.command == "prepare":
            payload = prepare_package(args.source, args.staging_root, args.archive_name)
        elif args.command == "upload":
            payload = upload_package(args)
        else:
            payload = cleanup_package(args.archive, args.staging_root, args.generated)
    except (HelperError, OSError, RuntimeError, zipfile.BadZipFile) as error:
        print("package upload helper: {}".format(error), file=sys.stderr)
        return 2
    print(json.dumps(payload, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
