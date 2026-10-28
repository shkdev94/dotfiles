"""Run the pinned browser-use MCP server with isolated temporary Chrome profiles."""

from __future__ import annotations

import argparse
import asyncio
from contextlib import suppress
import os
from pathlib import Path
import shutil
import signal
import sys
import tempfile
import traceback

from browser_use.mcp.server import BrowserUseServer


async def close_server(server: BrowserUseServer) -> None:
    """Stop owned sessions, including a session whose initialization failed."""
    if server._cleanup_task is not None:
        server._cleanup_task.cancel()
        with suppress(asyncio.CancelledError):
            await server._cleanup_task

    sessions = {
        entry["session"].id: entry["session"]
        for entry in server.active_sessions.values()
    }
    if server.browser_session is not None:
        sessions[server.browser_session.id] = server.browser_session

    results = await asyncio.gather(
        *(session.kill() for session in sessions.values()), return_exceptions=True
    )
    errors = [result for result in results if isinstance(result, BaseException)]
    if errors:
        raise BaseExceptionGroup("Failed to close temporary browser sessions", errors)


async def serve() -> None:
    """Keep SDK-created temporary profiles within one owned runtime directory."""
    runtime_directory = Path(tempfile.mkdtemp(prefix="browser-use-mcp-"))
    previous_tempdir = tempfile.tempdir
    previous_tmpdir = os.environ.get("TMPDIR")
    tempfile.tempdir = str(runtime_directory)
    os.environ["TMPDIR"] = str(runtime_directory)

    loop = asyncio.get_running_loop()
    shutdown_requested = asyncio.Event()
    shutdown_signal = signal.SIGTERM
    previous_handlers = {
        sig: signal.getsignal(sig) for sig in (signal.SIGINT, signal.SIGTERM)
    }

    def request_shutdown(sig: signal.Signals) -> None:
        nonlocal shutdown_signal
        shutdown_signal = sig
        shutdown_requested.set()

    for sig in previous_handlers:
        loop.add_signal_handler(sig, request_shutdown, sig)
    server = None
    server_task = None
    shutdown_task = None
    exit_after_cleanup = False
    exit_code = 0

    try:
        server = BrowserUseServer()
        # Override the MCP defaults after loading config: its loader drops JSON null.
        # The SDK then creates a fresh profile for every new browser session.
        server.config["browser_profile"].update(
            user_data_dir=None,
            cdp_url=None,
            headless=True,
            keep_alive=False,
            channel="chrome",
            executable_path=None,
            file_system_path=str(runtime_directory / "files"),
        )
        server_task = asyncio.create_task(server.run())
        shutdown_task = asyncio.create_task(shutdown_requested.wait())
        done, _ = await asyncio.wait(
            (server_task, shutdown_task), return_when=asyncio.FIRST_COMPLETED
        )
        if server_task in done:
            await server_task
        else:
            exit_after_cleanup = True
            exit_code = 128 + shutdown_signal
    finally:
        try:
            if server_task is not None and not server_task.done():
                server_task.cancel()
            if shutdown_task is not None:
                shutdown_task.cancel()
                with suppress(asyncio.CancelledError):
                    await shutdown_task
            if server is not None:
                try:
                    await close_server(server)
                except BaseException:
                    # Never delete a profile that a failed shutdown may still be using.
                    print(
                        f"MCP_CLEANUP_FAILED: runtime files retained at {runtime_directory}",
                        file=sys.stderr,
                    )
                    raise
            shutil.rmtree(runtime_directory)
        except BaseException:
            if exit_after_cleanup:
                exit_code = 1
                traceback.print_exc()
            raise
        finally:
            for sig, handler in previous_handlers.items():
                loop.remove_signal_handler(sig)
                signal.signal(sig, handler)
            tempfile.tempdir = previous_tempdir
            if previous_tmpdir is None:
                os.environ.pop("TMPDIR", None)
            else:
                os.environ["TMPDIR"] = previous_tmpdir
            if exit_after_cleanup:
                # The SDK's blocking stdin worker cannot finish until the client
                # closes its pipe. Exit only after explicitly releasing our resources.
                os._exit(exit_code)


def main() -> int:
    argparse.ArgumentParser(description=__doc__).parse_args()
    try:
        asyncio.run(serve())
    except KeyboardInterrupt:
        return 130
    except asyncio.CancelledError:
        return 143
    return 0


if __name__ == "__main__":
    sys.exit(main())
