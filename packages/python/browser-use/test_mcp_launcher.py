"""Offline lifecycle regression tests for the temporary-profile MCP launcher."""

import asyncio
from contextlib import redirect_stderr
import importlib.util
import io
import os
from pathlib import Path
import shutil
import signal
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from browser_use.browser.profile import BrowserProfile

spec = importlib.util.spec_from_file_location(
    "mcp_launcher", Path(__file__).with_name("mcp-launcher.py")
)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


def make_server():
    return SimpleNamespace(
        config={
            "browser_profile": {
                "user_data_dir": "/existing/profile",
                "cdp_url": "http://127.0.0.1:9222",
                "headless": False,
                "keep_alive": True,
                "executable_path": "/existing/browser",
                "allowed_domains": ["example.com"],
                "storage_state": "/existing/auth.json",
            },
            "llm": {"model": "configured-model"},
        },
        browser_session=None,
        active_sessions={},
        _cleanup_task=None,
        run=AsyncMock(),
    )


class TemporaryProfileLauncherTests(unittest.IsolatedAsyncioTestCase):
    async def test_sdk_creates_distinct_profiles_and_shutdown_removes_only_runtime_files(self):
        # Persistent browser settings must not leak into isolated MCP sessions.
        server = make_server()
        profiles = []
        runtime_directories = []
        previous_tempdir = tempfile.tempdir
        previous_tmpdir = os.environ.get("TMPDIR")
        previous_handlers = {
            sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)
        }

        async def inspect_configuration():
            config = server.config["browser_profile"]
            runtime_directories.append(Path(tempfile.gettempdir()))
            self.assertIsNone(config["user_data_dir"])
            self.assertIsNone(config["cdp_url"])
            self.assertTrue(config["headless"])
            self.assertFalse(config["keep_alive"])
            self.assertEqual(config["channel"], "chrome")
            self.assertIsNone(config["executable_path"])
            self.assertEqual(config["allowed_domains"], ["example.com"])
            self.assertEqual(config["storage_state"], "/existing/auth.json")
            self.assertEqual(server.config["llm"], {"model": "configured-model"})
            for _ in range(2):
                profile = BrowserProfile(user_data_dir=config["user_data_dir"], headless=True)
                profiles.append(Path(profile.user_data_dir))
                self.assertEqual(profiles[-1].parent.resolve(), runtime_directories[-1].resolve())

        server.run.side_effect = inspect_configuration

        # Each new browser uses the SDK's native temporary-directory behavior.
        with patch.object(launcher, "BrowserUseServer", return_value=server):
            await launcher.serve()
            await launcher.serve()

        # Normal shutdown removes both runs and restores process-local settings.
        self.assertNotEqual(runtime_directories[0], runtime_directories[1])
        self.assertEqual(len(set(profiles)), 4)
        self.assertTrue(all(not path.exists() for path in runtime_directories + profiles))
        self.assertEqual(tempfile.tempdir, previous_tempdir)
        self.assertEqual(os.environ.get("TMPDIR"), previous_tmpdir)
        self.assertEqual(
            {sig: signal.getsignal(sig) for sig in previous_handlers}, previous_handlers
        )

    async def test_shutdown_closes_each_owned_session_once_and_cancels_idle_cleanup(self):
        # The current browser may also appear in the active-session registry.
        server = make_server()
        first = SimpleNamespace(id="first", kill=AsyncMock())
        second = SimpleNamespace(id="second", kill=AsyncMock())
        server.browser_session = first
        server.active_sessions = {"first": {"session": first}, "second": {"session": second}}
        server._cleanup_task = asyncio.create_task(asyncio.Event().wait())

        # Ending the MCP connection must release every browser, not only the current one.
        with patch.object(launcher, "BrowserUseServer", return_value=server):
            await launcher.serve()

        # Deduplication avoids stopping the current browser twice.
        first.kill.assert_awaited_once()
        second.kill.assert_awaited_once()
        self.assertTrue(server._cleanup_task.cancelled())

    async def test_initialization_failure_closes_an_unregistered_partial_session(self):
        # Upstream assigns browser_session before startup finishes and tracking begins.
        server = make_server()
        partial = SimpleNamespace(id="partial", kill=AsyncMock())
        runtime_directories = []
        failure = RuntimeError("Browser startup failed")

        async def fail_after_creating_session():
            runtime_directories.append(Path(tempfile.gettempdir()))
            server.browser_session = partial
            raise failure

        server.run.side_effect = fail_after_creating_session

        # A failed tool initialization must preserve its original exception.
        with patch.object(launcher, "BrowserUseServer", return_value=server):
            with self.assertRaises(RuntimeError) as raised:
                await launcher.serve()

        # Even an unregistered session must be stopped before its profile is removed.
        self.assertIs(raised.exception, failure)
        partial.kill.assert_awaited_once()
        self.assertFalse(runtime_directories[0].exists())

    async def test_cancellation_still_closes_the_browser_and_removes_runtime_files(self):
        # A cancelled MCP connection still owns a browser that must be stopped.
        server = make_server()
        session = SimpleNamespace(id="cancelled", kill=AsyncMock())
        server.browser_session = session
        runtime_directories = []

        async def cancel_connection():
            runtime_directories.append(Path(tempfile.gettempdir()))
            raise asyncio.CancelledError()

        server.run.side_effect = cancel_connection

        # Cancellation must remain cancellation rather than becoming a successful run.
        with patch.object(launcher, "BrowserUseServer", return_value=server):
            with self.assertRaises(asyncio.CancelledError):
                await launcher.serve()

        # Browser cleanup is awaited even on the cancellation path.
        session.kill.assert_awaited_once()
        self.assertFalse(runtime_directories[0].exists())

    async def test_shutdown_failure_preserves_runtime_files_and_attempts_other_sessions(self):
        # A failed browser shutdown must not lead to deleting an in-use profile.
        server = make_server()
        failure = RuntimeError("Browser shutdown failed")
        first = SimpleNamespace(id="first", kill=AsyncMock(side_effect=failure))
        second = SimpleNamespace(id="second", kill=AsyncMock())
        server.active_sessions = {"first": {"session": first}, "second": {"session": second}}
        runtime_directories = []
        output = io.StringIO()

        async def record_directory():
            runtime_directories.append(Path(tempfile.gettempdir()))

        server.run.side_effect = record_directory

        try:
            # Surface cleanup failures instead of reporting a clean shutdown.
            with patch.object(launcher, "BrowserUseServer", return_value=server), redirect_stderr(output):
                with self.assertRaises(ExceptionGroup) as raised:
                    await launcher.serve()

            # Other owned sessions still close, while potentially live profile files remain.
            self.assertIn(failure, raised.exception.exceptions)
            first.kill.assert_awaited_once()
            second.kill.assert_awaited_once()
            self.assertTrue(runtime_directories[0].exists())
            self.assertIn("MCP_CLEANUP_FAILED", output.getvalue())
        finally:
            for path in runtime_directories:
                shutil.rmtree(path)

    async def test_termination_signals_clean_up_even_with_a_blocked_stdin_worker(self):
        # The upstream stdio reader can remain blocked while the client keeps stdin open.
        child_code = """
import asyncio
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace

source, marker = sys.argv[1:]
spec = importlib.util.spec_from_file_location("mcp_launcher", source)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)

async def close_browser():
    Path(marker).write_text("closed")

async def run_server():
    print(tempfile.gettempdir(), flush=True)
    await asyncio.to_thread(sys.stdin.readline)

launcher.BrowserUseServer = lambda: SimpleNamespace(
    config={"browser_profile": {}},
    browser_session=SimpleNamespace(id="owned", kill=close_browser),
    active_sessions={},
    _cleanup_task=None,
    run=run_server,
)
sys.argv = [sys.argv[0]]
sys.exit(launcher.main())
"""
        for termination_signal in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=termination_signal), tempfile.TemporaryDirectory() as directory:
                marker = Path(directory) / "browser-closed"
                process = await asyncio.create_subprocess_exec(
                    sys.executable, "-c", child_code,
                    str(Path(__file__).with_name("mcp-launcher.py")), str(marker),
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                try:
                    runtime = Path((await asyncio.wait_for(process.stdout.readline(), 10)).decode().strip())
                    self.assertTrue(runtime.name.startswith("browser-use-mcp-"))

                    # Termination must finish without requiring the client to close its pipe.
                    process.send_signal(termination_signal)
                    await asyncio.wait_for(process.wait(), 10)

                    # The owned browser closes before the runtime directory is deleted.
                    self.assertEqual(process.returncode, 128 + termination_signal)
                    self.assertEqual(marker.read_text(), "closed")
                    self.assertFalse(runtime.exists())
                    self.assertEqual(await process.stderr.read(), b"")
                finally:
                    if process.returncode is None:
                        process.kill()
                        await process.wait()
                    process.stdin.close()


if __name__ == "__main__":
    unittest.main()
