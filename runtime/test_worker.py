import asyncio
import base64
import json
import subprocess
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import worker


class PoolTests(unittest.IsolatedAsyncioTestCase):
    async def test_capacity_applies_across_sessions_and_queue_cancellation(self):
        with tempfile.TemporaryDirectory() as root:
            slots = [worker.Slot(Path(root)) for _ in range(3)]
            await slots[0].acquire(2, "crucible-" + "a" * 32)
            await slots[1].acquire(2, "crucible-" + "b" * 32)
            queued = asyncio.create_task(slots[2].acquire(2, "crucible-" + "c" * 32))
            await asyncio.sleep(0.05)
            self.assertFalse(queued.done())
            queued.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await queued
            self.assertIsNone(slots[2].handle)
            for slot in slots:
                slot.release(True)

    async def test_capacity_cannot_expand_while_another_session_owns_a_slot(self):
        with tempfile.TemporaryDirectory() as root:
            first, second = worker.Slot(Path(root)), worker.Slot(Path(root))
            await first.acquire(1, "crucible-" + "a" * 32)
            try:
                with self.assertRaisesRegex(RuntimeError, "cannot change"):
                    await second.acquire(2, "crucible-" + "b" * 32)
            finally:
                first.release(True)

    async def test_stale_owned_vm_removed_before_reusing_its_slot(self):
        with tempfile.TemporaryDirectory() as root:
            old = worker.Slot(Path(root))
            name = "crucible-" + "a" * 32
            await old.acquire(1, name)
            old.release(False)
            replacement = worker.Slot(Path(root))
            with patch.object(worker, "remove_owned", new_callable=AsyncMock) as remove:
                await replacement.acquire(1, "crucible-" + "b" * 32)
                remove.assert_awaited_once_with(name)
            replacement.release(True)

    async def test_refuses_unowned_cleanup_names(self):
        with self.assertRaisesRegex(ValueError, "Invalid owned"):
            await worker.remove_owned("user-database")


class BoundaryTests(unittest.TestCase):
    def test_collection_cannot_escape_via_parent_or_symlink(self):
        with tempfile.TemporaryDirectory() as root:
            workspace = Path(root) / "arm"
            workspace.mkdir()
            (workspace / "outside").symlink_to(Path(root), target_is_directory=True)
            for relative in ("../other-arm", "/etc", "outside"):
                with self.assertRaises(ValueError):
                    worker.workspace_path(workspace, relative)

    def test_upload_rejects_external_links_but_preserves_internal_links(self):
        with tempfile.TemporaryDirectory() as root:
            arm = Path(root) / "arm"
            arm.mkdir()
            (arm / "safe").write_text("assigned")
            (arm / "link").symlink_to("safe")
            worker.validate_upload(arm)
            (arm / "withheld").symlink_to(Path(root) / "other-arm")
            with self.assertRaisesRegex(ValueError, "escapes"):
                worker.validate_upload(arm)


class SupervisorTests(unittest.TestCase):
    def run_supervisor(self, waits, oom_kills=0):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            group = root / "cgroup"
            group.mkdir()
            (root / "stdin").write_text("")
            for name, value in {"memory.events": f"oom 1\noom_kill {oom_kills}\n", "memory.max": "768", "memory.peak": "700"}.items():
                (group / name).write_text(value)
            process = Mock()
            process.wait.side_effect = waits
            with patch.object(subprocess, "Popen", return_value=process) as spawn, patch.object(worker.os, "killpg"):
                exec(worker.execution_script(str(root), str(group), "echo ok", 2, {"HOME": "/home/agent"}), {})
            self.assertEqual((group / "cgroup.kill").read_text(), "1")
            entry = spawn.call_args.args[0][2]
            self.assertLess(entry.index("cgroup.procs"), entry.index("/cancelled"))
            self.assertLess(entry.index("/cancelled"), entry.index("setpriv"))
            self.assertIn("--bounding-set=-all", entry)
            self.assertIn("--no-new-privs", entry)
            return json.loads((root / "result").read_text())

    def test_oom_is_confirmed_by_kernel_counter_and_overrides_timeout(self):
        result = self.run_supervisor([subprocess.TimeoutExpired("agent", 2), -9, -9], oom_kills=1)
        self.assertEqual(result, {"code": 137, "timedOut": False, "memory": {"limitBytes": 768, "peakBytes": 700, "oomKilled": True}})

    def test_timeout_and_arbitrary_sigkill_are_distinct(self):
        timeout = self.run_supervisor([subprocess.TimeoutExpired("agent", 2), -9, -9])
        killed = self.run_supervisor([-9, -9])
        self.assertTrue(timeout["timedOut"])
        self.assertFalse(timeout["memory"]["oomKilled"])
        self.assertFalse(killed["timedOut"])
        self.assertFalse(killed["memory"]["oomKilled"])

    def test_success_still_kills_detached_descendants(self):
        result = self.run_supervisor([0, 0])
        self.assertEqual(result["code"], 0)
        self.assertFalse(result["memory"]["oomKilled"])


class StreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_execute_requires_memory_isolation(self):
        session = worker.Worker()
        session.environment = SimpleNamespace(exec=AsyncMock())
        try:
            with self.assertRaisesRegex(RuntimeError, "memory isolation"):
                await session.execute({"id": 1, "command": "ignored"})
            session.environment.exec.assert_not_called()
        finally:
            session.scratch.cleanup()

    async def test_failed_poll_kills_workload_before_cancelling_transport(self):
        session = worker.Worker()
        session.memory_limit = 768 * 1024 * 1024
        started = asyncio.Event()
        commands = []

        async def execute(command, **kwargs):
            commands.append(command)
            if "start_new_session" in command:
                started.set()
                try:
                    await asyncio.Event().wait()
                except asyncio.CancelledError:
                    self.assertIn("cgroup.kill", commands[-1])
                    raise
            return SimpleNamespace(return_code=0, stdout="", stderr="")

        async def failed_read(*args):
            await started.wait()
            raise RuntimeError("lost transport")

        session.environment = SimpleNamespace(exec=execute, upload_file=AsyncMock())
        session.read_output = failed_read
        try:
            with self.assertRaisesRegex(RuntimeError, "lost transport"):
                await session.execute({"id": 1, "command": "ignored"})
            self.assertIn("/cancelled; echo 1 >", commands[-1])
            self.assertIn("cgroup.kill", commands[-1])
        finally:
            session.scratch.cleanup()

    async def test_transient_output_timeout_preserves_offsets_and_running_command(self):
        session = worker.Worker()
        session.memory_limit = 768 * 1024 * 1024
        finish = asyncio.Event()
        stdout_reads = []
        stderr_reads = 0
        cancelled = False

        async def execute(command, **kwargs):
            nonlocal stderr_reads, cancelled
            if "start_new_session" in command:
                try:
                    await finish.wait()
                except asyncio.CancelledError:
                    cancelled = True
                    raise
            elif "base64" in command and "stdout" in command:
                stdout_reads.append(command)
                if len(stdout_reads) == 2:
                    raise RuntimeError("Command timed out after 30 seconds")
                data = {1: b"first", 3: b"last"}.get(len(stdout_reads), b"")
                return SimpleNamespace(return_code=0, stdout=base64.b64encode(data).decode(), stderr="")
            elif "base64" in command and "stderr" in command:
                stderr_reads += 1
                if stderr_reads == 2:
                    finish.set()
                    await asyncio.sleep(0)
            if command.startswith("cat /tmp/crucible-exec-"):
                return SimpleNamespace(return_code=0, stdout=json.dumps({"code": 0, "timedOut": False, "memory": {"limitBytes": session.memory_limit, "peakBytes": 1024, "oomKilled": False}}), stderr="")
            return SimpleNamespace(return_code=0, stdout="", stderr="")

        session.environment = SimpleNamespace(exec=execute, upload_file=AsyncMock())
        events = []
        try:
            with patch.object(worker, "emit", events.append), patch.object(worker, "OUTPUT_READ_RETRY_SECONDS", 0):
                result = await session.execute({"id": 1, "command": "ignored"})
            self.assertEqual(result["stdout"], "firstlast")
            self.assertEqual([event["data"] for event in events], ["first", "last"])
            self.assertEqual(stdout_reads[1], stdout_reads[2])
            self.assertTrue(all(command.startswith("/usr/bin/python3 -I -c ") for command in stdout_reads))
            self.assertIn("f.seek(5)", stdout_reads[2])
            self.assertIn("f.seek(9)", stdout_reads[3])
            self.assertFalse(cancelled)
        finally:
            session.scratch.cleanup()

    async def test_persistent_output_timeout_reports_vm_and_stops_retrying(self):
        session = worker.Worker()
        session.memory_limit = 768 * 1024 * 1024
        session.environment = SimpleNamespace(exec=AsyncMock(side_effect=RuntimeError("Command timed out after 30 seconds")))
        try:
            with patch.object(worker, "OUTPUT_READ_RETRY_SECONDS", 0):
                with self.assertRaisesRegex(RuntimeError, f"Reading stderr from VM {session.name}.*3 attempts.*vminitd.log.*runtime.memoryMb"):
                    await session.read_output("/tmp/output", "stderr", 17)
            self.assertEqual(session.environment.exec.await_count, 3)
        finally:
            session.scratch.cleanup()

    async def test_output_errors_other_than_transport_timeouts_are_not_retried(self):
        session = worker.Worker()
        session.memory_limit = 768 * 1024 * 1024
        try:
            for error in (RuntimeError("Guest provisioning failed: permission denied"), asyncio.CancelledError()):
                session.environment = SimpleNamespace(exec=AsyncMock(side_effect=error))
                with self.assertRaises(type(error)):
                    await session.read_output("/tmp/output", "stdout", 0)
                session.environment.exec.assert_awaited_once()
        finally:
            session.scratch.cleanup()

    async def test_command_finishing_between_stream_reads_is_fully_drained(self):
        session = worker.Worker()
        session.memory_limit = 768 * 1024 * 1024
        finish = asyncio.Event()
        reads = 0

        async def execute(command, **kwargs):
            nonlocal reads
            if "start_new_session" in command:
                await finish.wait()
            elif "base64" in command and "stdout" in command:
                reads += 1
                data = b"grok-4.7-low - Grok 4.7 Low\n" if reads == 2 else b""
                return SimpleNamespace(return_code=0, stdout=base64.b64encode(data).decode(), stderr="")
            elif "base64" in command and "stderr" in command:
                # The process writes its final stdout after stdout was polled,
                # while the worker is still waiting for the stderr read.
                finish.set()
                await asyncio.sleep(0)
            if command.startswith("cat /tmp/crucible-exec-"):
                return SimpleNamespace(return_code=0, stdout=json.dumps({"code": 0, "timedOut": False, "memory": {"limitBytes": session.memory_limit, "peakBytes": 1024, "oomKilled": False}}), stderr="")
            return SimpleNamespace(return_code=0, stdout="", stderr="")

        session.environment = SimpleNamespace(exec=execute, upload_file=AsyncMock())
        events = []
        try:
            with patch.object(worker, "emit", events.append):
                result = await session.execute({"id": 1, "command": "ignored"})
            self.assertEqual(result["stdout"], "grok-4.7-low - Grok 4.7 Low\n")
            self.assertEqual("".join(event["data"] for event in events), result["stdout"])
        finally:
            session.scratch.cleanup()

    async def test_stopping_stdin_reader_does_not_cancel_vm_cleanup(self):
        parent = Mock()
        reader = asyncio.StreamReader()
        task = asyncio.create_task(worker.read_requests(reader, asyncio.Queue(), parent))
        await asyncio.sleep(0)
        task.cancel()
        await task
        parent.cancel.assert_not_called()

    async def test_utf8_character_split_between_reads_is_not_corrupted(self):
        session = worker.Worker()
        session.memory_limit = 768 * 1024 * 1024
        packets = [b"\xe2", b"\x82\xac", b""]

        async def execute(command, **kwargs):
            if "base64" in command and "stdout" in command:
                return SimpleNamespace(return_code=0, stdout=base64.b64encode(packets.pop(0)).decode(), stderr="")
            if command.startswith("cat /tmp/crucible-exec-"):
                return SimpleNamespace(return_code=0, stdout=json.dumps({"code": 0, "timedOut": False, "memory": {"limitBytes": session.memory_limit, "peakBytes": 1024, "oomKilled": False}}), stderr="")
            return SimpleNamespace(return_code=0, stdout="", stderr="")

        session.environment = SimpleNamespace(exec=execute, upload_file=AsyncMock())
        events = []
        try:
            with patch.object(worker, "emit", events.append):
                result = await session.execute({"id": 1, "command": "ignored"})
            self.assertEqual(result["stdout"], "€")
            self.assertEqual([event["data"] for event in events], ["€"])
        finally:
            session.scratch.cleanup()


if __name__ == "__main__":
    unittest.main()
