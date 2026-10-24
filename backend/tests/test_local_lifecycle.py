"""Real CLI lifecycle: signals, second instance, worker supervision, lock helper."""

import json
import os
import re
import signal
import socket
import subprocess
import sys
import time
import types
import urllib.request
from pathlib import Path

import pytest

from backend import filelock

ROOT = Path(__file__).resolve().parents[2]


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def clean_env():
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(("APP_", "DATABASE_", "STORAGE_", "OPR_", "LAYOUT_"))
    }
    return {**env, "PYTHONPATH": str(ROOT)}


def spawn(tmp_path, port, data):
    return subprocess.Popen(
        [sys.executable, "-m", "backend.local", "--port", str(port), "--no-browser", "--data", str(data)],
        cwd=tmp_path,
        env=clean_env(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )


def health(port):
    with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/v1/health", timeout=2) as r:
        return json.loads(r.read())


def wait_workers(process, port, want=2):
    for _ in range(300):
        try:
            body = health(port)
            workers = body.get("workers", {})
            if len(workers) >= want and all(v == "running" for v in workers.values()):
                return body
        except OSError:
            if process.poll() is not None:
                raise AssertionError(process.stdout.read())
        time.sleep(0.1)
    raise AssertionError("not up")


def environment(pid):
    """A process's environment: /proc on Linux (ps there does not print it), ps on macOS."""
    proc = f"/proc/{pid}/environ"
    if os.path.exists(proc):
        try:
            with open(proc, "rb") as handle:
                return handle.read().replace(b"\0", b"\n").decode(errors="replace")
        except OSError:
            return ""
    try:
        return subprocess.run(["ps", "eww", "-p", pid], capture_output=True, text=True).stdout
    except OSError:
        return ""


def worker_pids(data_marker):
    # -ww: without a terminal Linux's ps cuts each line at 80 columns, and the
    # interpreter's path on CI is long enough to push "-m backend.…" off the end.
    out = subprocess.run(["ps", "-A", "-ww", "-o", "pid=,command="], capture_output=True, text=True).stdout
    pids = []
    for line in out.splitlines():
        pid, _, cmd = line.strip().partition(" ")
        worker = re.search(r"-m backend\.\w+_worker(\s|$)", cmd)
        if worker and pid.isdigit() and data_marker in environment(pid):
            pids.append(int(pid))
    return pids


def found_workers(process, data, want=2):
    """The workers' pids; failing that, what was running and what the CLI said."""
    pids = worker_pids(str(data))
    if len(pids) >= want:
        return pids
    listing = subprocess.run(["ps", "-A", "-ww", "-o", "pid=,ppid=,command="], capture_output=True, text=True).stdout
    python = "\n".join(line for line in listing.splitlines() if "backend" in line)
    process.kill()
    output, _ = process.communicate(timeout=30)
    raise AssertionError(f"{len(pids)} workers found\n--- processes ---\n{python}\n--- the CLI said ---\n{output}")


def alive(pid):
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


posix = pytest.mark.skipif(os.name == "nt", reason="uses POSIX signals and ps")


@posix
@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGHUP])
def test_signal_stops_the_cli_and_every_worker(tmp_path, sig):
    port, data = free_port(), tmp_path / "data"
    process = spawn(tmp_path, port, data)
    try:
        wait_workers(process, port)
        pids = found_workers(process, data)
        process.send_signal(sig)
        output, _ = process.communicate(timeout=30)
        assert "Stopped." in output
        time.sleep(0.5)
        assert not [p for p in pids if alive(p)]
    finally:
        if process.poll() is None:
            process.kill()


@posix
def test_workers_leave_when_the_cli_is_killed(tmp_path):
    port, data = free_port(), tmp_path / "data"
    process = spawn(tmp_path, port, data)
    try:
        wait_workers(process, port)
        pids = worker_pids(str(data))
        process.kill()
        process.wait()
        for _ in range(100):
            if not [p for p in pids if alive(p)]:
                break
            time.sleep(0.2)
        assert not [p for p in pids if alive(p)]
    finally:
        if process.poll() is None:
            process.kill()


@posix
def test_second_instance_on_the_same_data_folder_says_so(tmp_path):
    port, data = free_port(), tmp_path / "data"
    first = spawn(tmp_path, port, data)
    try:
        wait_workers(first, port)
        second = spawn(tmp_path, free_port(), data)
        output, _ = second.communicate(timeout=30)
        assert second.returncode != 0
        assert f"already running at http://127.0.0.1:{port}" in output
    finally:
        first.send_signal(signal.SIGINT)
        first.communicate(timeout=30)


@posix
def test_a_killed_worker_is_restarted_and_health_says_so(tmp_path):
    port, data = free_port(), tmp_path / "data"
    process = spawn(tmp_path, port, data)
    try:
        wait_workers(process, port)
        victim = found_workers(process, data, want=1)[0]
        os.kill(victim, signal.SIGKILL)
        seen = set()
        for _ in range(400):
            try:
                now = set(health(port)["workers"].values())
            except OSError:
                time.sleep(0.05)
                continue
            seen |= now
            if "restarting" in seen and now == {"running"}:
                break
            time.sleep(0.05)
        assert "restarting" in seen
        assert victim not in worker_pids(str(data))
    finally:
        process.send_signal(signal.SIGINT)
        process.communicate(timeout=30)


def test_supervisor_gives_up_after_the_cap(tmp_path):
    from backend.local.supervisor import Supervisor, worker_health

    logs = []
    sup = Supervisor(["no_such_worker"], tmp_path, log_dir=tmp_path / "logs", log=logs.append, max_restarts=2, backoff=0.01, poll=0.02)
    sup.start()
    try:
        for _ in range(200):
            if worker_health().get("no_such_worker") == "failed":
                break
            time.sleep(0.05)
        assert worker_health() == {"no_such_worker": "failed"}
        assert any("restarting" in line for line in logs)
    finally:
        sup.stop()
    output = (tmp_path / "logs" / "no_such_worker.log").read_text()
    assert output.count("No module named") == 3


def test_lock_helper_posix(tmp_path):
    path = tmp_path / "x.lock"
    with path.open("a") as a, path.open("a") as b:
        filelock.lock_nowait(a)
        with pytest.raises(BlockingIOError):
            filelock.lock_nowait(b)
        filelock.unlock(a)
        filelock.lock_nowait(b)


def test_lock_helper_windows_path(tmp_path, monkeypatch):
    calls = []

    def locking(fd, mode, nbytes):
        calls.append((mode, nbytes))
        if mode == 2 and len(calls) > 1 and calls[-2][0] == 2:
            raise OSError(13, "locked")

    fake = types.SimpleNamespace(LK_NBLCK=2, LK_UNLCK=0, locking=locking)
    monkeypatch.setattr(filelock, "fcntl", None)
    monkeypatch.setattr(filelock, "msvcrt", fake, raising=False)
    with (tmp_path / "w.lock").open("a") as handle:
        filelock.lock_nowait(handle)
        with pytest.raises(BlockingIOError):
            filelock.lock_nowait(handle)
        filelock.unlock(handle)
    assert calls[0] == (2, 1) and calls[-1] == (0, 1)
