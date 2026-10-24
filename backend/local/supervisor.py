"""Keep the local edition's worker subprocesses alive and report their health."""

import os
import subprocess
import sys
import threading
import time

from ..parent_watch import ENV as PARENT_ENV
from .logs import handler, write

_status = {}
_lock = threading.Lock()


def worker_health():
    with _lock:
        return dict(_status)


def _set(name, value):
    with _lock:
        _status[name] = value


class Supervisor:
    """Starts workers, restarts the ones that exit (with backoff, capped)."""

    def __init__(
        self, names, cwd, *, log_dir, log=print, max_restarts=5,
        backoff=1.0, healthy_after=60.0, poll=0.5,
    ):
        self.names = tuple(names)
        self.cwd = cwd
        self.log = log
        self.max_restarts = max_restarts
        self.backoff = backoff
        self.healthy_after = healthy_after
        self.poll = poll
        self.processes = {}
        self.log_dir = log_dir
        self._outputs = {}
        self._readers = []
        self._logs_closed = threading.Event()
        self._stop = threading.Event()
        self._thread = None
        with _lock:
            _status.clear()

    def _spawn(self, name):
        if name not in self._outputs:
            self._outputs[name] = handler(self.log_dir, name)
        env = {**os.environ, PARENT_ENV: str(os.getpid()), "PYTHONUNBUFFERED": "1"}
        process = subprocess.Popen(
            [sys.executable, "-m", "backend." + name],
            cwd=self.cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            start_new_session=True,
        )
        reader = threading.Thread(
            target=self._read_output,
            args=(name, process.stdout),
            name=f"{name}-logs",
            daemon=True,
        )
        self._readers.append(reader)
        reader.start()
        self.processes[name] = process
        _set(name, "running")
        return process

    def _read_output(self, name, stream):
        with stream:
            for line in stream:
                if self._logs_closed.is_set():
                    break
                write(self._outputs[name], line.rstrip("\r\n"))

    def start(self):
        for name in self.names:
            self._spawn(name)
        self._thread = threading.Thread(target=self._loop, name="worker-supervisor", daemon=True)
        self._thread.start()

    def _loop(self):
        started = {name: time.monotonic() for name in self.names}
        restarts = dict.fromkeys(self.names, 0)
        due = {}  # name -> monotonic time of the next restart
        while not self._stop.wait(self.poll):
            now = time.monotonic()
            for name in self.names:
                if worker_health().get(name) == "failed":
                    continue
                if name in due:
                    if now >= due[name] and not self._stop.is_set():
                        del due[name]
                        started[name] = now
                        self._spawn(name)
                    continue
                code = self.processes[name].poll()
                if code is None:
                    if now - started[name] > self.healthy_after:
                        restarts[name] = 0
                    continue
                if restarts[name] >= self.max_restarts:
                    _set(name, "failed")
                    self.log(f"{name} keeps exiting (code {code}); giving up after {restarts[name]} restarts.")
                    continue
                delay = self.backoff * 2 ** restarts[name]
                restarts[name] += 1
                due[name] = now + delay
                _set(name, "restarting")
                self.log(f"{name} exited unexpectedly (code {code}); restarting in {delay:g}s.")

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        processes = list(self.processes.values())
        for process in processes:
            if process.poll() is None:
                process.terminate()
        deadline = time.monotonic() + 8
        for process in processes:
            try:
                process.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for reader in self._readers:
            reader.join(timeout=5)
        self._logs_closed.set()
        for output in self._outputs.values():
            output.close()
