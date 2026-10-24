"""Local-only subprocesses and temporary logs; no app startup or providers."""

import io
import json
import logging
import sys

import pytest

from backend.local import cli, logs
from backend.local.supervisor import Supervisor


@pytest.mark.parametrize("name", ["agent_worker", "preparation_worker", "translation_worker", "research_worker"])
def test_supervisor_logs_stdout_stderr_and_appends(tmp_path, name):
    package = tmp_path / "backend"
    package.mkdir()
    (package / "__init__.py").touch()
    (package / f"{name}.py").write_text(
        "import sys\nprint('stdout: ready')\nprint('stderr: ready', file=sys.stderr)\n"
        "print(\"Authorization: Bearer fake-credential\")\n"
        "sys.stdout.write('tail without newline')\n"
    )
    directory = tmp_path / "data" / "logs"
    for _ in range(2):
        supervisor = Supervisor([name], tmp_path, log_dir=directory)
        try:
            supervisor._spawn(name).wait(timeout=10)
        finally:
            supervisor.stop()
    text = (directory / f"{name}.log").read_text()
    assert text.count("stdout: ready") == text.count("stderr: ready") == 2
    assert "fake-credential" not in text
    assert "[redacted]" in text
    assert text.count("tail without newline") == 2


def test_supervisor_rotates_and_keeps_three_backups(tmp_path, monkeypatch):
    assert logs.MAX_BYTES == 5 * 1024 * 1024
    assert logs.BACKUP_COUNT == 3
    monkeypatch.setattr(logs, "MAX_BYTES", 512)
    package = tmp_path / "backend"
    package.mkdir()
    (package / "__init__.py").touch()
    (package / "fixture_worker.py").write_text(
        "for n in range(80): print(f'{n:02d}: ' + 'x' * 100)\n"
    )
    supervisor = Supervisor(["fixture_worker"], tmp_path, log_dir=tmp_path / "logs")
    try:
        supervisor._spawn("fixture_worker").wait(timeout=10)
    finally:
        supervisor.stop()
    files = sorted((tmp_path / "logs").iterdir())
    assert [p.name for p in files] == [
        "fixture_worker.log", "fixture_worker.log.1", "fixture_worker.log.2", "fixture_worker.log.3"
    ]
    assert all(p.stat().st_size < 512 for p in files)
    assert "79: " in files[0].read_text()


@pytest.mark.parametrize("text", [
    "Authorization: Bearer private-value",
    "Proxy-Authorization: Basic private-value",
    "Authorization: Custom credential signature private-value",
    "{'Authorization': 'Bearer private-value', 'other': 1}",
    json.dumps({"error": "headers: " + json.dumps({"Authorization": "Bearer private-value"})}),
    '{"api_key": "private-value", "refresh_token": "private-value"}',
    "https://example.invalid?api_key=private-value&access_token=private-value",
    "Cookie: private-value; session=private-value",
    "{'Cookie': 'session=private-value; csrf=private-value'}",
    "https://user:private-value@example.invalid/v1",
    "Bearer private-value",
    "sk-private-value",
    "eyJfixture.private-value.signature",
])
def test_local_logs_redact_credentials(text):
    assert "private-value" not in logs.redact(text)


def test_app_log_captures_output_traceback_and_rotates(tmp_path, monkeypatch):
    monkeypatch.setattr(logs, "MAX_BYTES", 512)
    monkeypatch.setattr("sys.stdout", io.StringIO())
    monkeypatch.setattr("sys.stderr", io.StringIO())
    for _ in range(2):
        with logs.app_logging(tmp_path):
            print("app stdout")
            print("app stderr", file=sys.stderr)
            try:
                raise ValueError("Authorization: Bearer private-value")
            except ValueError:
                logging.getLogger("fixture").warning("Model response not understood", exc_info=True)
    files = list((tmp_path / "logs").glob("app.log*"))
    text = "\n".join(p.read_text() for p in files)
    assert len(files) > 1
    assert "app stdout" in text and "app stderr" in text
    assert "Traceback" in text and "ValueError" in text
    assert "Model response not understood" in text
    assert "private-value" not in text


def test_cli_startup_failures_go_to_app_log_without_raw_traceback(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(cli, "running", lambda _: False)
    monkeypatch.setattr(cli, "configure", lambda *args: None)

    def serve(*args):
        print("startup")
        raise ValueError("Authorization: Bearer private-value")

    monkeypatch.setattr(cli, "serve", serve)
    assert cli.main(["--data", str(tmp_path), "--no-browser"]) == 1
    text = (tmp_path / "logs" / "app.log").read_text()
    assert "startup" in text and "Traceback" in text
    assert "private-value" not in text
    captured = capsys.readouterr()
    assert "private-value" not in captured.out + captured.err


def test_large_unicode_lines_rotate_by_bytes_without_dropping_output(tmp_path, monkeypatch):
    monkeypatch.setattr(logs, "MAX_BYTES", 512)
    output = logs.handler(tmp_path, "unicode")
    try:
        logs.write(output, "文" * 180)
    finally:
        output.close()
    files = list(tmp_path.glob("unicode.log*"))
    assert len(files) > 1
    assert all(path.stat().st_size <= 512 for path in files)
    assert sum(path.read_text().count("文") for path in files) == 180
