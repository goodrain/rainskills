#!/usr/bin/env python3
import errno
import os
import pty
import select
import time
from pathlib import Path

from installer_signal_cleanup_test import terminate_process_tree


REPO_ROOT = Path(__file__).resolve().parent.parent


def test_install_suite_does_not_prompt_on_a_real_tty() -> None:
    env = os.environ.copy()
    env.update(
        {
            "RAINBOND_JWT": "host.jwt.placeholder",
            "RAINBOND_URL": "https://host.example.com",
            "RAINBOND_USERNAME": "host-user",
            "RAINBOND_PASSWORD": "host-password",
        }
    )

    pid, master_fd = pty.fork()
    if pid == 0:
        os.chdir(REPO_ROOT)
        os.execve(
            "/bin/bash",
            ["bash", str(REPO_ROOT / "tests" / "install.sh.test")],
            env,
        )

    output = bytearray()
    child_status = None
    deadline = time.monotonic() + 45
    try:
        while time.monotonic() < deadline:
            waited_pid, wait_status = os.waitpid(pid, os.WNOHANG)
            if waited_pid == pid:
                child_status = wait_status
                break

            readable, _, _ = select.select([master_fd], [], [], 0.2)
            if readable:
                try:
                    output.extend(os.read(master_fd, 4096))
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
            time.sleep(0.05)

        if child_status is None:
            raise AssertionError(
                "install.sh test suite waited for hidden terminal input; output:\n"
                + output.decode("utf-8", errors="replace")[-4000:]
            )

        exit_code = os.waitstatus_to_exitcode(child_status)
        assert exit_code == 0, (
            f"install.sh test suite exited with {exit_code}; output:\n"
            + output.decode("utf-8", errors="replace")[-4000:]
        )
    finally:
        os.close(master_fd)
        if child_status is None:
            terminate_process_tree(pid)
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass


if __name__ == "__main__":
    print("INFO: 正在隔离终端中验证 install.sh（约 15 秒，无需输入）...", flush=True)
    test_install_suite_does_not_prompt_on_a_real_tty()
    print("PASS: install.sh test suite is TTY-safe")
