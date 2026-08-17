#!/usr/bin/env python3
import errno
import os
import pty
import re
import select
import shutil
import signal
import socket
import stat
import subprocess
import tempfile
import termios
import time
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent
AUTH_READY_PATTERN = re.compile(rb"127\.0\.0\.1:(\d+)/cli-callback")
MANUAL_PASTE_PATTERN = re.compile("请粘贴回调 URL 或 JWT".encode())
NODE_EXECUTABLE = shutil.which("node")
if NODE_EXECUTABLE is None:
    raise RuntimeError("Node.js 18+ is required for installer signal tests")
NODE_BIN_DIR = str(Path(NODE_EXECUTABLE).resolve().parent)


def authorization_shell_argv() -> list[str]:
    script = r'''
source "$1/install.sh" --dest "$HOME/source-probe" --force
trap 'handle_installer_signal 130' INT
trap 'handle_installer_signal 143' TERM
trap 'handle_installer_exit "$?"' EXIT
TARGET=codex
DEPLOYMENT_MODE_INPUT=saas
RAINBOND_TOKEN_INPUT=""
RAINBOND_TOKEN_FROM_FLAG=0
RAINBOND_URL_INPUT=""
RAINBOND_URL_FROM_FLAG=0
SKIP_MCP=0
NON_INTERACTIVE=0
configure_mcp
'''
    return [
        "bash",
        "-c",
        script,
        "rainskills-authorization-test",
        str(REPO_ROOT),
    ]


def write_executable(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)


def read_until(master_fd: int, pattern: re.Pattern[bytes], timeout: float) -> tuple[bytes, re.Match[bytes]]:
    output = bytearray()
    deadline = time.monotonic() + timeout

    while time.monotonic() < deadline:
        readable, _, _ = select.select([master_fd], [], [], 0.2)
        if not readable:
            continue
        try:
            chunk = os.read(master_fd, 4096)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not chunk:
            break
        output.extend(chunk)
        match = pattern.search(output)
        if match:
            return bytes(output), match

    raise AssertionError(
        "installer did not reach browser authorization callback; output:\n"
        + output.decode("utf-8", errors="replace")
    )


def wait_for_terminal_echo(master_fd: int, enabled: bool, timeout: float) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        echo_enabled = bool(termios.tcgetattr(master_fd)[3] & termios.ECHO)
        if echo_enabled == enabled:
            return
        time.sleep(0.01)
    state = "enabled" if enabled else "disabled"
    raise AssertionError(f"terminal echo was not {state}")


def wait_for_exit(pid: int, master_fd: int, timeout: float, signal_name: str) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        waited_pid, status = os.waitpid(pid, os.WNOHANG)
        if waited_pid == pid:
            return status
        readable, _, _ = select.select([master_fd], [], [], 0.05)
        if readable:
            try:
                os.read(master_fd, 4096)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
        time.sleep(0.05)
    raise AssertionError(f"installer did not exit after {signal_name}")


def assert_port_closed(port: int) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
        client.settimeout(0.5)
        assert client.connect_ex(("127.0.0.1", port)) != 0, (
            f"authorization callback port {port} is still accepting connections"
        )


def descendant_pids(root_pid: int) -> list[int]:
    process_rows = subprocess.check_output(
        ["ps", "-axo", "pid=,ppid="], text=True
    ).splitlines()
    children_by_parent: dict[int, list[int]] = {}
    for row in process_rows:
        process_id_raw, parent_id_raw = row.split()
        children_by_parent.setdefault(int(parent_id_raw), []).append(int(process_id_raw))

    descendants = []
    pending = list(children_by_parent.get(root_pid, []))
    while pending:
        process_id = pending.pop()
        descendants.append(process_id)
        pending.extend(children_by_parent.get(process_id, []))
    return descendants


def process_exists(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def terminate_process_tree(root_pid: int) -> None:
    process_ids = [*reversed(descendant_pids(root_pid)), root_pid]
    for process_id in process_ids:
        try:
            os.kill(process_id, signal.SIGKILL)
        except ProcessLookupError:
            pass


def assert_signal_cleans_browser_authorization_processes(
    signal_name: str, expected_exit_code: int
) -> None:
    with tempfile.TemporaryDirectory(prefix="rainskills-signal-test-") as workdir_raw:
        workdir = Path(workdir_raw)
        home = workdir / "home"
        temp_dir = workdir / "tmp"
        bin_dir = workdir / "bin"
        home.mkdir()
        temp_dir.mkdir()
        bin_dir.mkdir()

        write_executable(bin_dir / "uname", "#!/bin/sh\nprintf 'Linux\\n'\n")
        write_executable(
            bin_dir / "curl",
            """#!/bin/sh
if echo "$*" | grep -q '/console/mcp/device/code'; then
  output_file=''
  header_file=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --output) output_file="$2"; shift 2 ;;
      --dump-header) header_file="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  printf 'Not Found' > "$output_file"
  printf 'HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\n' > "$header_file"
  printf '404'
fi
exit 0
""",
        )

        env = os.environ.copy()
        env.update(
            {
                "HOME": str(home),
                "TMPDIR": str(temp_dir),
                "PATH": f"{bin_dir}:{NODE_BIN_DIR}:/usr/bin:/bin",
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

        pid, master_fd = pty.fork()
        if pid == 0:
            os.chdir(REPO_ROOT)
            os.execve("/bin/bash", authorization_shell_argv(), env)

        status = None
        tracked_pids = [pid]
        try:
            output, match = read_until(master_fd, AUTH_READY_PATTERN, timeout=15)
            assert "无需在终端按回车" in output.decode("utf-8", errors="replace"), (
                "browser authorization did not explain that terminal input is unnecessary"
            )
            port = int(match.group(1))
            tracked_pids.extend(descendant_pids(pid))

            if signal_name == "Ctrl+C":
                os.write(master_fd, b"\x03")
            else:
                os.kill(pid, signal.SIGTERM)
            status = wait_for_exit(pid, master_fd, timeout=5, signal_name=signal_name)

            assert os.WIFSIGNALED(status) or os.WEXITSTATUS(status) == expected_exit_code, (
                f"expected {signal_name} or exit code {expected_exit_code}, "
                f"got wait status {status}"
            )
            assert_port_closed(port)
            assert not list(temp_dir.iterdir()), (
                "authorization temporary files were not removed: "
                + ", ".join(path.name for path in temp_dir.iterdir())
            )
            remaining_pids = [process_id for process_id in tracked_pids if process_exists(process_id)]
            assert not remaining_pids, (
                "authorization processes are still running: "
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


def assert_manual_callback_input_is_not_echoed() -> None:
    with tempfile.TemporaryDirectory(prefix="rainskills-no-echo-test-") as workdir_raw:
        workdir = Path(workdir_raw)
        home = workdir / "home"
        temp_dir = workdir / "tmp"
        bin_dir = workdir / "bin"
        home.mkdir()
        temp_dir.mkdir()
        bin_dir.mkdir()

        real_curl = subprocess.check_output(
            ["/usr/bin/env", "sh", "-c", "command -v curl"], text=True
        ).strip()
        write_executable(bin_dir / "uname", "#!/bin/sh\nprintf 'Linux\\n'\n")
        write_executable(
            bin_dir / "curl",
            """#!/bin/sh
if echo "$*" | grep -q '/console/mcp/device/code'; then
  output_file=''
  header_file=''
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --output) output_file="$2"; shift 2 ;;
      --dump-header) header_file="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  printf 'Not Found' > "$output_file"
  printf 'HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\n\r\n' > "$header_file"
  printf '404'
  exit 0
fi
case "$*" in
  *http://127.0.0.1:*) exec "$REAL_CURL" "$@" ;;
esac
exit 0
""",
        )

        env = os.environ.copy()
        env.update(
            {
                "HOME": str(home),
                "TMPDIR": str(temp_dir),
                "PATH": f"{bin_dir}:{NODE_BIN_DIR}:/usr/bin:/bin",
                "SHELL": "/bin/bash",
                "REAL_CURL": real_curl,
                "RAINBOND_LOGIN_TIMEOUT": "60",
                "RAINSKILLS_NO_BROWSER": "1",
            }
        )
        for name in (
            "RAINBOND_JWT",
            "RAINBOND_URL",
            "RAINBOND_USERNAME",
            "RAINBOND_PASSWORD",
        ):
            env.pop(name, None)

        test_jwt = b"noecho.payload.signature"
        pid, master_fd = pty.fork()
        if pid == 0:
            os.chdir(REPO_ROOT)
            os.execve("/bin/bash", authorization_shell_argv(), env)

        output = bytearray()
        status = None
        try:
            prompt_output, _ = read_until(master_fd, MANUAL_PASTE_PATTERN, timeout=15)
            output.extend(prompt_output)
            port_match = AUTH_READY_PATTERN.search(prompt_output)
            assert port_match, prompt_output.decode("utf-8", errors="replace")

            wait_for_terminal_echo(master_fd, enabled=False, timeout=2)
            os.write(master_fd, test_jwt + b"\n")
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                waited_pid, wait_status = os.waitpid(pid, os.WNOHANG)
                if waited_pid == pid:
                    status = wait_status
                    break
                readable, _, _ = select.select([master_fd], [], [], 0.1)
                if readable:
                    try:
                        output.extend(os.read(master_fd, 4096))
                    except OSError as error:
                        if error.errno != errno.EIO:
                            raise
                        break

            assert test_jwt not in output, (
                "manual callback input was echoed to terminal output"
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
    assert_manual_callback_input_is_not_echoed()
    assert_signal_cleans_browser_authorization_processes("Ctrl+C", 130)
    assert_signal_cleans_browser_authorization_processes("SIGTERM", 143)
    print("PASS: installer signal cleanup test")
