#!/usr/bin/env python3
import json
import errno
import os
import pty
import re
import select
import shutil
import stat
import subprocess
import tempfile
import time
from pathlib import Path

from installer_signal_cleanup_test import (
    terminate_process_tree,
    write_executable,
)


REPO_ROOT = Path(__file__).resolve().parent.parent
TTY_PATTERN = re.compile(rb"RAINSKILLS_TTY stdin=1 stdout=1 stderr=1")
APPROVED_CAPABILITY_SUMMARY = """Rainskills 安装完成，下一条消息即可直接使用。

下一步可以直接说：

- 帮我部署当前项目
- 帮我部署一个 Git 仓库
- 帮我通过镜像或安装包部署应用
- 帮我安装一个应用模板
- 帮我分析当前项目应该如何部署

也可以直接告诉我你想部署什么应用。"""
AGENT_SUMMARY_REQUIREMENT = "[RAINSKILLS_AGENT_SUMMARY_REQUIRED:include-next-actions]"


def read_process_output(pid: int, master_fd: int, timeout: float) -> tuple[bytes, int]:
    output = bytearray()
    status = None
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if status is None:
            waited_pid, wait_status = os.waitpid(pid, os.WNOHANG)
            if waited_pid == pid:
                status = wait_status
        readable, _, _ = select.select([master_fd], [], [], 0.1)
        if readable:
            try:
                output.extend(os.read(master_fd, 4096))
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                break
        elif status is not None:
            break
    if status is None:
        raise AssertionError(
            "npx Skills-only installer did not exit; output:\n"
            + output.decode("utf-8", errors="replace")
        )
    return bytes(output), status


def pack_package(destination: Path, env: dict[str, str]) -> Path:
    result = subprocess.run(
        ["npm", "pack", "--json", "--pack-destination", str(destination)],
        cwd=REPO_ROOT,
        env=env,
        check=True,
        text=True,
        capture_output=True,
    )
    [packed] = json.loads(result.stdout)
    return destination / packed["filename"]


def test_npx_pty_skills_only_completion() -> None:
    if not shutil.which("npm") or not shutil.which("npx"):
        raise AssertionError("npm and npx are required for the package PTY test")

    with tempfile.TemporaryDirectory(prefix="rainskills-npx-pty-") as workdir_raw:
        workdir = Path(workdir_raw)
        home = workdir / "home"
        temp_dir = workdir / "tmp"
        pack_dir = workdir / "pack"
        bin_dir = workdir / "bin"
        for directory in (home, temp_dir, pack_dir, bin_dir):
            directory.mkdir()

        write_executable(
            bin_dir / "bash",
            """#!/bin/sh
stdin_tty=0
stdout_tty=0
stderr_tty=0
test -t 0 && stdin_tty=1
test -t 1 && stdout_tty=1
test -t 2 && stderr_tty=1
printf 'RAINSKILLS_TTY stdin=%s stdout=%s stderr=%s\n' \
  "$stdin_tty" "$stdout_tty" "$stderr_tty" >&2
exec /bin/bash "$@"
""",
        )
        write_executable(
            bin_dir / "python3",
            "#!/bin/sh\nexec /usr/bin/python3 \"$@\"\n",
        )
        write_executable(bin_dir / "uname", "#!/bin/sh\nprintf 'Linux\\n'\n")
        write_executable(
            bin_dir / "curl",
            """#!/bin/sh
printf '%s\n' "$*" >> "$RAINSKILLS_CURL_LOG"
exit 0
""",
        )
        curl_log = workdir / "curl.log"

        env = os.environ.copy()
        env.update(
            {
                "HOME": str(home),
                "TMPDIR": str(temp_dir),
                "PATH": f"{bin_dir}:{env.get('PATH', '')}",
                "SHELL": "/bin/bash",
                "RAINSKILLS_CURL_LOG": str(curl_log),
            }
        )
        for name in (
            "RAINBOND_JWT",
            "RAINBOND_URL",
            "RAINBOND_USERNAME",
            "RAINBOND_PASSWORD",
        ):
            env.pop(name, None)

        tarball = pack_package(pack_dir, env)
        pid, master_fd = pty.fork()
        if pid == 0:
            os.chdir(workdir)
            os.execvpe(
                "npx",
                [
                    "npx",
                    "--yes",
                    f"--package={tarball}",
                    "rainskills",
                    "codex",
                    "--saas",
                    "--no-cached-token",
                    "--force",
                ],
                env,
            )

        status = None
        try:
            output, status = read_process_output(pid, master_fd, timeout=30)
            decoded = output.decode("utf-8", errors="replace").replace("\r\n", "\n")
            assert os.WIFEXITED(status) and os.WEXITSTATUS(status) == 0, (
                f"expected normal Skills-only exit, got wait status {status}:\n{decoded}"
            )
            assert TTY_PATTERN.search(output), decoded
            assert decoded.count(APPROVED_CAPABILITY_SUMMARY) == 1, decoded
            assert decoded.count(AGENT_SUMMARY_REQUIREMENT) == 1, decoded
            assert decoded.index(APPROVED_CAPABILITY_SUMMARY) < decoded.index(AGENT_SUMMARY_REQUIREMENT), decoded
            assert "[RAINSKILLS_USER_MESSAGE_BEGIN:install.completed]" in decoded, decoded
            assert "[RAINSKILLS_USER_MESSAGE_END:install.completed]" in decoded, decoded
            for forbidden in (
                "Rainbond Cloud",
                "私有",
                "MCP",
                "登录",
                "授权",
                "Rainbond Console",
                "rainskills.next-action.v1",
            ):
                assert forbidden not in decoded, f"default npx output contains {forbidden}"
            assert (home / ".codex" / "skills" / "rainbond-app-assistant" / "SKILL.md").is_file()
            assert not (home / ".rainbond" / "mcp.env").exists()
            assert not (home / ".rainbond" / "rainskills-onboarding-v1.json").exists()
            assert not (home / ".rainbond" / "platform-installer").exists()
            assert not (home / ".codex" / "config.toml").exists()
            assert not list(temp_dir.glob("rainskills-auth.*")), (
                "authorization temporary files were not removed"
            )
            curl_calls = curl_log.read_text(encoding="utf-8") if curl_log.exists() else ""
            assert "/console/" not in curl_calls, curl_calls
        finally:
            os.close(master_fd)
            if status is None:
                terminate_process_tree(pid)
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass


if __name__ == "__main__":
    test_npx_pty_skills_only_completion()
    print("PASS: npx PTY Skills-only completion test")
