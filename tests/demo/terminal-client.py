"""Run the installed Client in an actual terminal without exposing its test password."""
import errno
import json
import os
import pty
import select
import signal
import sys
import termios

configuration = json.loads(sys.stdin.readline())
child_pid, terminal = pty.fork()
if child_pid == 0:
    os.execvpe(configuration["executable"], configuration["arguments"], os.environ)


def forward(signum, _frame):
    try:
        os.kill(child_pid, signum)
    except ProcessLookupError:
        pass


signal.signal(signal.SIGINT, forward)
signal.signal(signal.SIGTERM, forward)
observed = b""
sent = False
try:
    while True:
        if (not sent and b"Review Tunnel password: " in observed
                and not termios.tcgetattr(terminal)[3] & termios.ECHO):
            os.write(terminal, (configuration["password"] + "\n").encode())
            sent = True
        readable, _, _ = select.select([terminal], [], [], 0.05)
        if not readable:
            continue
        try:
            data = os.read(terminal, 65536)
        except OSError as error:
            if error.errno == errno.EIO:
                break
            raise
        if not data:
            break
        observed = (observed + data)[-65536:]
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
finally:
    os.close(terminal)
    _, status = os.waitpid(child_pid, 0)
code = os.waitstatus_to_exitcode(status)
sys.exit(code if code >= 0 else 128 - code)
