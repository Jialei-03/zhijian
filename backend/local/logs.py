"""Rotating local logs. Redact after formatting, including exception tracebacks."""

import contextlib
import io
import logging
import re
import sys
import threading
from logging.handlers import RotatingFileHandler
from pathlib import Path

MAX_BYTES = 5 * 1024 * 1024
BACKUP_COUNT = 3

# Cover header dumps, JSON/repr configuration, URL query parameters and common
# unlabelled provider keys. Never log request headers/configuration deliberately.
AUTH = re.compile(
    r"(?im)((?:proxy-)?authorization\s*[:=]\s*)[^\r\n]+"
)
QUOTED_CREDENTIAL = re.compile(
    r"(?i)((?:\\?[\"'])?(?:(?:proxy-)?authorization|[\w-]*(?:api[_-]?key|"
    r"token|secret|password)|cookie|set-cookie)(?:\\?[\"'])?\s*[:=]\s*)"
    r"(?P<quote>\\?[\"'])(?:(?!(?P=quote)).)*(?P=quote)"
)
CREDENTIAL = re.compile(
    r"(?i)((?:[\"']?(?:[\w-]*(?:api[_-]?key|token|secret|password)|"
    r"cookie|set-cookie)[\"']?\s*[:=]\s*)[\"']?)[^\s\"'&,;}\\]+"
)
BEARER = re.compile(r"(?i)\b(bearer|basic)\s+[^\s\"',}\\]+")
KEY = re.compile(r"\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+)\b")
JWT = re.compile(r"\beyJ[\w-]+\.[\w-]+\.[\w-]+\b")
USERINFO = re.compile(r"(https?://)[^\s/@]+:[^\s/@]+@", re.I)
COOKIE = re.compile(r"(?im)((?:set-)?cookie\s*[:=]\s*)[^\r\n]+")


def redact(text):
    text = QUOTED_CREDENTIAL.sub(r"\1\g<quote>[redacted]\g<quote>", text)
    text = COOKIE.sub(r"\1[redacted]", text)
    text = AUTH.sub(r"\1[redacted]", text)
    text = CREDENTIAL.sub(r"\1[redacted]", text)
    text = BEARER.sub(r"\1 [redacted]", text)
    text = KEY.sub("[redacted]", text)
    text = JWT.sub("[redacted]", text)
    return USERINFO.sub(r"\1[redacted]@", text)


class RedactingFormatter(logging.Formatter):
    def format(self, record):
        return redact(super().format(record))


class ByteRotatingHandler(RotatingFileHandler):
    def shouldRollover(self, record):
        if self.stream is None:
            self.stream = self._open()
        self.stream.seek(0, 2)
        size = len((self.format(record) + self.terminator).encode("utf-8"))
        return self.stream.tell() + size >= self.maxBytes


def handler(directory, name):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    output = ByteRotatingHandler(
        directory / f"{name}.log",
        maxBytes=MAX_BYTES,
        backupCount=BACKUP_COUNT,
        encoding="utf-8",
    )
    output.setFormatter(RedactingFormatter("%(asctime)s %(message)s"))
    return output


def write(output, text):
    # Redact the whole line before splitting: credentials can cross a chunk
    # boundary. Four bytes per character plus the timestamp fit in one file.
    text = redact(text)
    chunk = max(1, (output.maxBytes - 64) // 4)
    for start in range(0, max(1, len(text)), chunk):
        output.handle(logging.LogRecord(
            "local", logging.INFO, "", 0, text[start:start + chunk], (), None
        ))


class Tee(io.TextIOBase):
    """Keep CLI/desktop output and write full lines so split writes redact together."""

    def __init__(self, stream, output):
        self.stream = stream
        self.output = output
        self.pending = ""
        self.lock = threading.RLock()

    @property
    def encoding(self):
        return "utf-8"

    def isatty(self):
        return self.stream.isatty()

    def write(self, text):
        with self.lock:
            self.pending += text
            while "\n" in self.pending:
                line, self.pending = self.pending.split("\n", 1)
                write(self.output, line)
                self.stream.write(redact(line) + "\n")
        return len(text)

    def flush(self):
        with self.lock:
            if self.pending:
                write(self.output, self.pending)
                self.stream.write(redact(self.pending))
                self.pending = ""
            self.stream.flush()


@contextlib.contextmanager
def app_logging(data):
    output = handler(Path(data) / "logs", "app")
    stdout, stderr = sys.stdout, sys.stderr
    out, err = Tee(stdout, output), Tee(stderr, output)
    root = logging.getLogger()
    console = logging.StreamHandler(err)
    console.setFormatter(logging.Formatter("%(levelname)s:%(name)s:%(message)s"))
    root.addHandler(console)
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                yield
            except Exception:
                logging.getLogger(__name__).exception("Local app failed")
                raise
    finally:
        root.removeHandler(console)
        out.flush()
        err.flush()
        output.close()
