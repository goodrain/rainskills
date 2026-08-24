#!/usr/bin/env python3
import errno
import os
import pty
import select
import time
from pathlib import Path
from typing import Optional

from installer_signal_cleanup_test import terminate_process_tree


REPO_ROOT = Path(__file__).resolve().parent.parent
TOTAL_TIMEOUT_SECONDS = 120
IDLE_TIMEOUT_SECONDS = 45


def timed_out_reason(
    now: float, total_deadline: float, idle_deadline: float
) -> Optional[str]:
    if now >= total_deadline:
        return "exceeded the overall test deadline"
    if now >= idle_deadline:
        return "stopped producing output and may be waiting for hidden terminal input"
    return None


def test_timeout_policy_distinguishes_total_and_idle_deadlines() -> None:
    assert timed_out_reason(10, total_deadline=20, idle_deadline=15) is None
    assert "hidden terminal input" in timed_out_reason(
        16, total_deadline=20, idle_deadline=15
    )
    assert "overall" in timed_out_reason(
        21, total_deadline=20, idle_deadline=25
    )
    assert timed_out_reason(
        44, total_deadline=120, idle_deadline=45
    ) is None, "a legitimate startup silence shorter than the idle threshold must pass"
    assert "hidden terminal input" in timed_out_reason(
        46, total_deadline=120, idle_deadline=45
    ), "a hidden prompt must still fail at the idle threshold"


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
    started_at = time.monotonic()
    total_deadline = started_at + TOTAL_TIMEOUT_SECONDS
    idle_deadline = started_at + IDLE_TIMEOUT_SECONDS
    timeout_reason = None
    try:
        while timeout_reason is None:
            waited_pid, wait_status = os.waitpid(pid, os.WNOHANG)
            if waited_pid == pid:
                child_status = wait_status
                break

            readable, _, _ = select.select([master_fd], [], [], 0.2)
            if readable:
                try:
                    chunk = os.read(master_fd, 4096)
                    output.extend(chunk)
                    if chunk:
                        idle_deadline = time.monotonic() + IDLE_TIMEOUT_SECONDS
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
            time.sleep(0.05)
            timeout_reason = timed_out_reason(
                time.monotonic(), total_deadline, idle_deadline
            )

        if child_status is None:
            waited_pid, wait_status = os.waitpid(pid, os.WNOHANG)
            if waited_pid == pid:
                child_status = wait_status

        if child_status is None:
            raise AssertionError(
                f"install.sh test suite {timeout_reason}; output:\n"
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
    print("INFO: 正在隔离终端中验证 install.sh（约 30 秒；持续输出会继续，无输出 45 秒判定为隐藏等待）...", flush=True)
    test_timeout_policy_distinguishes_total_and_idle_deadlines()
    test_install_suite_does_not_prompt_on_a_real_tty()
    print("PASS: install.sh test suite is TTY-safe")
