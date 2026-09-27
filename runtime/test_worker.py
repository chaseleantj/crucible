import asyncio
import base64
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


class StreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_command_finishing_between_stream_reads_is_fully_drained(self):
        session = worker.Worker()
        finish = asyncio.Event()
        reads = 0

        async def execute(command, **kwargs):
            nonlocal reads
            if "setsid timeout" in command:
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
        packets = [b"\xe2", b"\x82\xac", b""]

        async def execute(command, **kwargs):
            if "base64" in command and "stdout" in command:
                return SimpleNamespace(return_code=0, stdout=base64.b64encode(packets.pop(0)).decode(), stderr="")
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
