#!/usr/bin/env python3
import json
import os
import pty
import re
import shutil
import signal
import stat
import subprocess
import tempfile
from pathlib import Path

from installer_signal_cleanup_test import (
    AUTH_READY_PATTERN,
    assert_port_closed,
    descendant_pids,
    process_exists,
    read_until,
    terminate_process_tree,
    wait_for_exit,
    write_executable,
)


REPO_ROOT = Path(__file__).resolve().parent.parent
TTY_PATTERN = re.compile(rb"RAINSKILLS_TTY stdin=1 stdout=1 stderr=1")


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


def test_npx_pty_signal_cleanup() -> None:
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
        write_executable(bin_dir / "uname", "#!/bin/sh\nprintf 'Linux\\n'\n")
        write_executable(bin_dir / "curl", "#!/bin/sh\nexit 0\n")

        env = os.environ.copy()
        env.update(
            {
                "HOME": str(home),
                "TMPDIR": str(temp_dir),
                "PATH": f"{bin_dir}:{env.get('PATH', '')}",
                "SHELL": "/bin/bash",
                "RAINBOND_LOGIN_TIMEOUT": "60",
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
        tracked_pids = [pid]
        try:
            output, match = read_until(master_fd, AUTH_READY_PATTERN, timeout=30)
            assert TTY_PATTERN.search(output), output.decode("utf-8", errors="replace")
            port = int(match.group(1))
            tracked_pids.extend(descendant_pids(pid))

            os.write(master_fd, b"\x03")
            status = wait_for_exit(pid, master_fd, timeout=10, signal_name="Ctrl+C")

            exit_code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else None
            assert os.WIFSIGNALED(status) or exit_code in (1, 130), (
                f"expected SIGINT or npm signal exit code, got wait status {status}"
            )
            assert_port_closed(port)
            assert not list(temp_dir.glob("rainskills-auth.*")), (
                "authorization temporary files were not removed"
            )
            remaining_pids = [
                process_id for process_id in tracked_pids if process_exists(process_id)
            ]
            assert not remaining_pids, (
                "npx authorization processes are still running: "
                + ", ".join(str(process_id) for process_id in remaining_pids)
            )
        finally:
            os.close(master_fd)
            if status is None:
                terminate_process_tree(pid)
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass


if __name__ == "__main__":
    test_npx_pty_signal_cleanup()
    print("PASS: npx PTY signal cleanup test")
