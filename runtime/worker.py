"""One Harbor VM and one machine-wide execution slot per parent session."""
import asyncio
import base64
import codecs
import fcntl
import ipaddress
import importlib.metadata
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import shutil
import signal
import sys
import tempfile
import uuid

RUNTIME = Path(__file__).resolve().parent
STATE = Path.home() / ".local/state/crucible/harbor"
GUEST_WORKSPACE = "/workspace"
CLEANUP_SECONDS = 20
OUTPUT_READ_TIMEOUT_SECONDS = 30
OUTPUT_READ_ATTEMPTS = 3
OUTPUT_READ_RETRY_SECONDS = 1
OWNED_NAME = re.compile(r"^crucible-[a-f0-9]{32}$")


def emit(message):
    print(json.dumps(message), flush=True)


async def container_command(*args):
    process = await asyncio.create_subprocess_exec(
        "container", *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(process.communicate(), CLEANUP_SECONDS)
    except BaseException:
        process.kill()
        await process.communicate()
        raise
    return process.returncode, out.decode(errors="replace"), err.decode(errors="replace")


async def remove_owned(name):
    if not OWNED_NAME.fullmatch(name):
        raise ValueError("Invalid owned VM name in slot record")
    await container_command("stop", name)
    code, _, _ = await container_command("rm", name)
    if code:
        code, listing, _ = await container_command("list", "--all", "--format", "json")
        if code:
            raise RuntimeError("Cannot confirm VM cleanup while Apple container service is unavailable")
        def contains_name(value):
            if isinstance(value, dict):
                return any(contains_name(item) for item in value.values())
            if isinstance(value, list):
                return any(contains_name(item) for item in value)
            return value == name
        if contains_name(json.loads(listing)):
            raise RuntimeError(f"Could not remove owned VM {name}; slot retained for recovery")


def try_lock(path):
    handle = path.open("a+")
    try:
        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return handle
    except BlockingIOError:
        handle.close()
        return None


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


class Slot:
    def __init__(self, state=STATE):
        self.state = state
        self.handle = None
        self.record = None

    async def acquire(self, capacity, name):
        if not isinstance(capacity, int) or capacity < 1:
            raise ValueError("Concurrency must be a positive integer")
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        while True:
            guard = try_lock(self.state / "pool.lock")
            if guard is None:
                await asyncio.sleep(0.1)
                continue
            available = []
            try:
                config = self.state / "capacity.json"
                previous = json.loads(config.read_text()) if config.exists() else capacity
                busy = False
                for index in range(max(previous, capacity)):
                    handle = try_lock(self.state / f"slot-{index}.lock")
                    if handle is None:
                        busy = True
                    else:
                        available.append((index, handle))
                if previous != capacity and busy:
                    raise RuntimeError(f"Harbor pool already has capacity {previous}; cannot change to {capacity} while VMs are active")
                if not busy:
                    # Recover every unlocked prior owner, including slots above a reduced limit.
                    for index, _ in available:
                        record = self.state / f"slot-{index}.json"
                        if record.exists():
                            await remove_owned(json.loads(record.read_text())["name"])
                            record.unlink()
                write_json(config, capacity)
                for index, handle in available:
                    if index >= capacity:
                        continue
                    record = self.state / f"slot-{index}.json"
                    if record.exists():
                        await remove_owned(json.loads(record.read_text())["name"])
                    write_json(record, {"name": name, "pid": os.getpid()})
                    self.handle, self.record = handle, record
                    return
            finally:
                for _, handle in available:
                    if handle is not self.handle:
                        handle.close()
                guard.close()
            await asyncio.sleep(0.2)

    def release(self, clean):
        if self.record and clean:
            self.record.unlink(missing_ok=True)
        if self.handle:
            self.handle.close()
            self.handle = None


def workspace_path(workspace, relative):
    part = PurePosixPath(relative)
    if part.is_absolute() or ".." in part.parts:
        raise ValueError("Collection path must stay inside the assigned workspace")
    target = workspace.joinpath(*part.parts)
    if not target.resolve().is_relative_to(workspace.resolve()):
        raise ValueError("Collection path follows a link outside the workspace")
    return target


def validate_upload(source):
    # Do not let a user-provided link import a withheld sibling or host file.
    root = source.resolve() if source.is_dir() else source.parent.resolve()
    for path in [source, *(source.rglob("*") if source.is_dir() else [])]:
        if path.is_symlink() and not path.resolve().is_relative_to(root):
            raise ValueError(f"Input symlink escapes the assigned tree: {path.name}")


def firewall_script():
    # Root provisions this once; all setup and agent commands run as uid 1000.
    return """set -eu
mkdir -p /run/crucible
chmod 700 /run/crucible
iptables -N CRUCIBLE
iptables -A OUTPUT -m owner --uid-owner 1000 -j CRUCIBLE
iptables -A CRUCIBLE -o lo -j ACCEPT
for dns in $(awk '/^nameserver / {print $2}' /etc/resolv.conf); do
  case "$dns" in *:*) continue;; esac
  iptables -A CRUCIBLE -d "$dns" -p udp --dport 53 -j ACCEPT
  iptables -A CRUCIBLE -d "$dns" -p tcp --dport 53 -j ACCEPT
done
for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16 224.0.0.0/4 240.0.0.0/4; do
  iptables -A CRUCIBLE -d "$range" -j REJECT
done
ip6tables -N CRUCIBLE
ip6tables -A OUTPUT -m owner --uid-owner 1000 -j CRUCIBLE
ip6tables -A CRUCIBLE -o lo -j ACCEPT
ip6tables -A CRUCIBLE -d fc00::/7 -j REJECT
ip6tables -A CRUCIBLE -d fe80::/10 -j REJECT
ip6tables -A CRUCIBLE -d ff00::/8 -j REJECT
"""


CGROUP_ROOT = "/sys/fs/cgroup"
WORKLOAD_CGROUP = CGROUP_ROOT + "/crucible-workload"
MEMORY_RESERVE_BYTES = 512 * 1024 * 1024


def memory_provision_script(memory_mb):
    return f"""import json
from pathlib import Path
root = Path({CGROUP_ROOT!r})
if 'memory' not in (root / 'cgroup.controllers').read_text().split():
    raise RuntimeError('Memory isolation requires a writable cgroup v2 memory controller')
supervisor = root / 'crucible-supervisor'
supervisor.mkdir()
# Snapshot before moving: mutating cgroup.procs while iterating skips PIDs.
for pid in (root / 'cgroup.procs').read_text().split():
    try:
        (supervisor / 'cgroup.procs').write_text(pid)
    except ProcessLookupError:
        pass
(root / 'cgroup.subtree_control').write_text('+memory')
total = int(next(line.split()[1] for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemTotal:'))) * 1024
total = min(total, {memory_mb!r} * 1024 * 1024)
limit = total - min({MEMORY_RESERVE_BYTES}, total // 4)
workload = Path({WORKLOAD_CGROUP!r})
workload.mkdir()
(workload / 'memory.max').write_text(str(limit))
(workload / 'memory.swap.max').write_text('0')
(workload / 'memory.oom.group').write_text('1')
(workload / 'cgroup.subtree_control').write_text('+memory')
(workload / 'cgroup.kill').write_text('1')
(workload / 'memory.peak').read_text()
print(json.dumps({{'limitBytes': limit}}))
"""


def execution_script(directory, cgroup, command, timeout, env):
    agent_env = shlex.join(["/usr/bin/env", *[f"{key}={value}" for key, value in env.items()], "bash", "-c", command])
    restricted = "exec /usr/bin/setpriv --reuid=1000 --regid=1000 --init-groups --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs " + agent_env
    enter = f"echo $$ >{cgroup}/cgroup.procs || exit 125; test ! -e {directory}/cancelled || exit 125; " + restricted
    return f"""import json, os, signal, subprocess
from pathlib import Path
root = Path({directory!r})
group = Path({cgroup!r})
timed_out = False
with (root / 'stdin').open('rb') as stdin, (root / 'stdout').open('wb') as stdout, (root / 'stderr').open('wb') as stderr:
    child = subprocess.Popen(['/bin/bash', '-c', {enter!r}], stdin=stdin, stdout=stdout, stderr=stderr, start_new_session=True)
    try:
        code = child.wait(timeout={timeout!r})
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=3)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            pass
    finally:
        # Kill the entire workload, including detached grandchildren.
        (group / 'cgroup.kill').write_text('1')
        # A very short deadline can expire before the child enters its cgroup.
        child.kill()
        code = child.wait()
events = dict(line.split() for line in (group / 'memory.events').read_text().splitlines())
oom = int(events['oom_kill']) > 0
(root / 'result').write_text(json.dumps({{'code': 128 - code if code < 0 else code, 'timedOut': timed_out and not oom, 'memory': {{'limitBytes': int((group / 'memory.max').read_text()), 'peakBytes': int((group / 'memory.peak').read_text()), 'oomKilled': oom}}}}))
"""


class Worker:
    def __init__(self):
        self.environment = None
        self.workspace = None
        self.name = "crucible-" + uuid.uuid4().hex
        self.slot = Slot()
        self.scratch = tempfile.TemporaryDirectory(prefix="crucible-harbor-")
        self.host_address = None
        self.memory_limit = None

    async def checked(self, command, **kwargs):
        kwargs.setdefault("timeout_sec", 30)
        if kwargs.get("user") == "root":
            kwargs.setdefault("env", {})["PATH"] = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        result = await self.environment.exec(command, **kwargs)
        if result.return_code:
            raise RuntimeError(f"Guest provisioning failed: {(result.stderr or result.stdout or '')[-1500:]}")
        return result

    async def start(self, request):
        from harbor.environments.apple_container import AppleContainerEnvironment

        AppleContainerEnvironment.preflight()
        self.workspace = Path(request["workspace"]).resolve(strict=True)
        validate_upload(self.workspace)
        await self.slot.acquire(request["maxConcurrent"], self.name)
        return await asyncio.wait_for(self.boot(request), 600)

    async def boot(self, request):
        from harbor.environments.apple_container import AppleContainerEnvironment
        from harbor.models.task.config import EnvironmentConfig
        from harbor.models.trial.paths import TrialPaths

        class FirewallEnvironment(AppleContainerEnvironment):
            async def _run_container_command(self, args, **kwargs):
                # Harbor owns lifecycle; its Apple adapter has no capability option.
                if args and args[0] == "run":
                    args = ["run", "--cap-add", "CAP_NET_ADMIN", *args[1:]]
                return await super()._run_container_command(args, **kwargs)

        image = json.loads((RUNTIME / "image.json").read_text())["name"]
        self.environment = FirewallEnvironment(
            environment_dir=RUNTIME, environment_name="crucible", session_id=self.name,
            trial_paths=TrialPaths(trial_dir=Path(self.scratch.name)),
            task_env_config=EnvironmentConfig(docker_image=image, cpus=request["cpus"], memory_mb=request["memoryMb"], workdir=GUEST_WORKSPACE),
            mounts=[],
        )
        await self.environment.start(force_build=False)
        await self.checked(firewall_script(), user="root")
        memory = await self.checked("/usr/bin/python3 -I -c " + shlex.quote(memory_provision_script(request["memoryMb"])), user="root")
        self.memory_limit = json.loads(memory.stdout)["limitBytes"]
        route = await self.checked("ip -4 route show default", user="root")
        match = re.search(r"\bvia\s+(\S+)", route.stdout or "")
        if not match:
            raise RuntimeError("Guest network has no host gateway")
        self.host_address = str(ipaddress.IPv4Address(match[1]))
        await self.upload(self.workspace, GUEST_WORKSPACE)
        _, image_details, _ = await container_command("image", "inspect", image)
        versions = await self.checked("claude --version && codex --version && cursor-agent --version", user="agent")
        return {"workspace": GUEST_WORKSPACE, "hostAddress": self.host_address, "name": self.name,
                "metadata": {"image": json.loads(image_details), "cliVersions": versions.stdout,
                             "harborVersion": importlib.metadata.version("harbor"),
                             "harborCommit": json.loads(importlib.metadata.distribution("harbor").read_text("direct_url.json"))["vcs_info"]["commit_id"]}}

    async def restore_permissions(self):
        await self.checked("chown -R 1000:1000 /workspace; chown root:root /workspace; chmod 1777 /workspace; for p in /workspace/.context /workspace/input; do if [ -e \"$p\" ]; then chown -R root:root \"$p\"; chmod -R a+rX,a-w \"$p\"; fi; done", user="root")

    async def upload(self, source, destination):
        source = Path(source).resolve(strict=True)
        destination_path = PurePosixPath(destination)
        if not destination_path.is_relative_to(PurePosixPath(GUEST_WORKSPACE)) or ".." in destination_path.parts:
            raise ValueError("Uploads must stay inside /workspace")
        validate_upload(source)
        if source.is_dir():
            await asyncio.wait_for(self.environment.upload_dir(source, destination), 300)
        else:
            await asyncio.wait_for(self.environment.upload_file(source, destination), 300)
        await self.restore_permissions()
        return {}

    async def forward(self, port):
        if not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("Invalid broker port")
        command = f"nohup /usr/bin/python3 -I /opt/crucible/relay.py {shlex.quote(self.host_address)} {port} >/run/crucible/relay-{port}.log 2>&1 </dev/null &"
        await self.checked(command, user="root")
        await self.checked(f"/usr/bin/python3 -I -c 'import socket,time; time.sleep(0.15); s=socket.create_connection((\"127.0.0.1\",{port}),timeout=3); s.close()'", user="root")
        return {"port": port}

    async def read_output(self, directory, stream, offset):
        script = f"import base64,pathlib; p=pathlib.Path({directory + '/' + stream!r}); f=p.open('rb') if p.exists() else None; f.seek({offset}) if f else None; print(base64.b64encode(f.read(262144) if f else b'').decode())"
        for attempt in range(OUTPUT_READ_ATTEMPTS):
            try:
                result = await self.checked("/usr/bin/python3 -I -c " + shlex.quote(script), user="root", timeout_sec=OUTPUT_READ_TIMEOUT_SECONDS)
                return base64.b64decode((result.stdout or "").strip())
            except RuntimeError as error:
                # Harbor reports its transport timeout as RuntimeError. Only
                # these read-only polls are safe to repeat at the same offset.
                if str(error) != f"Command timed out after {OUTPUT_READ_TIMEOUT_SECONDS} seconds":
                    raise
                if attempt + 1 == OUTPUT_READ_ATTEMPTS:
                    raise RuntimeError(
                        f"Reading {stream} from VM {self.name} timed out after {OUTPUT_READ_ATTEMPTS} attempts. "
                        "Check the VM's vminitd.log for memory exhaustion or container failures; "
                        "browser-heavy tasks may need a higher runtime.memoryMb."
                    ) from error
                await asyncio.sleep(OUTPUT_READ_RETRY_SECONDS)

    async def execute(self, request):
        identifier = request["id"]
        directory = f"/tmp/crucible-exec-{uuid.uuid4().hex}"
        if self.memory_limit is None:
            raise RuntimeError("Guest memory isolation was not provisioned")
        cgroup = f"{WORKLOAD_CGROUP}/{uuid.uuid4().hex}"
        await self.checked(f"set -eu; mkdir -m 700 {directory}; mkdir {cgroup}; echo {self.memory_limit} >{cgroup}/memory.max; echo 0 >{cgroup}/memory.swap.max; echo 1 >{cgroup}/memory.oom.group; test -w {cgroup}/cgroup.kill; test -r {cgroup}/memory.peak", user="root")
        stdin_path = Path(self.scratch.name) / "stdin"
        stdin_path.write_text(request.get("stdin", ""))
        stdin_path.chmod(0o600)
        await self.environment.upload_file(stdin_path, directory + "/stdin")
        stdin_path.unlink()
        args = request.get("args")
        command = shlex.join([request["command"], *args]) if args is not None else request["command"]
        timeout = request.get("timeoutMs", 3600000) / 1000
        command_env = {"HOME": "/home/agent", **request.get("env", {})}
        script = execution_script(directory, cgroup, command, timeout, command_env)
        run = asyncio.create_task(self.environment.exec("/usr/bin/python3 -I -c " + shlex.quote(script), cwd=request.get("cwd", GUEST_WORKSPACE), user="root"))
        offsets = {"stdout": 0, "stderr": 0}
        outputs = {"stdout": [], "stderr": []}
        decoders = {key: codecs.getincrementaldecoder("utf-8")("replace") for key in offsets}
        completed = False
        try:
            while True:
                # Only an empty poll begun after exit proves both streams are
                # drained. The process can finish between these awaited reads.
                finished_before_read = run.done()
                received = False
                for stream in offsets:
                    raw = await self.read_output(directory, stream, offsets[stream])
                    received = received or bool(raw)
                    offsets[stream] += len(raw)
                    data = decoders[stream].decode(raw)
                    if data:
                        outputs[stream].append(data)
                        emit({"id": identifier, "event": stream, "data": data})
                if finished_before_read and not received:
                    result = await run
                    if result.return_code:
                        raise RuntimeError(f"Guest execution supervisor failed: {result.stderr or result.stdout or result.return_code}")
                    status = await self.checked(f"cat {directory}/result", user="root")
                    status = json.loads(status.stdout)
                    completed = True
                    for stream in offsets:
                        tail = decoders[stream].decode(b"", final=True)
                        if tail:
                            outputs[stream].append(tail)
                            emit({"id": identifier, "event": stream, "data": tail})
                    return {**status, **{k: "".join(v) for k, v in outputs.items()}}
                await asyncio.sleep(0.2)
        finally:
            pending_error = sys.exception()
            try:
                if not completed:
                    # Host cancellation or failed polling must not leave browsers running.
                    await self.checked(f"touch {directory}/cancelled; echo 1 >{cgroup}/cgroup.kill", user="root")
            except Exception as error:
                if pending_error is None:
                    raise
                print(f"Workload cleanup failed: {error}", file=sys.stderr)
            finally:
                if not run.done():
                    run.cancel()
                    await asyncio.gather(run, return_exceptions=True)

    async def collect(self, relative):
        target = workspace_path(self.workspace, relative)
        with tempfile.TemporaryDirectory(prefix=".crucible-collect-", dir=target.parent) as temporary:
            staging = Path(temporary) / "result"
            guest_source = str(PurePosixPath(GUEST_WORKSPACE) / relative)
            retained = (".runtime", ".context", "input") if relative in (".", "") else ()
            if retained:
                guest_source = "/run/crucible/collect-" + uuid.uuid4().hex
                await self.checked(f"mkdir {guest_source}; find /workspace -mindepth 1 -maxdepth 1 ! -name .runtime ! -name .context ! -name input -exec cp -a -- {{}} {guest_source}/ \\;", user="root")
            try:
                await asyncio.wait_for(self.environment.download_dir(guest_source, staging), 300)
            finally:
                await self.restore_permissions()
                if retained:
                    await self.checked("rm -rf -- " + shlex.quote(guest_source), user="root")
            validate_upload(staging)
            backup = Path(temporary) / "previous"
            # Host-only runtime logs/configuration are never replaced by guest files.
            for name in retained:
                if (target / name).exists():
                    if (target / name).is_dir() and not (target / name).is_symlink():
                        shutil.copytree(target / name, staging / name, symlinks=True)
                    else:
                        shutil.copy2(target / name, staging / name, follow_symlinks=False)
            if target.exists():
                target.rename(backup)
            try:
                staging.rename(target)
            except BaseException:
                if backup.exists():
                    backup.rename(target)
                raise
        return {}

    async def close(self):
        clean = self.environment is None
        try:
            if self.environment:
                await asyncio.wait_for(self.environment.stop(delete=True), CLEANUP_SECONDS)
                await asyncio.wait_for(remove_owned(self.name), CLEANUP_SECONDS)
                clean = True
        finally:
            self.slot.release(clean)
            self.scratch.cleanup()


async def read_requests(reader, queue, parent):
    try:
        while line := await reader.readline():
            await queue.put(json.loads(line))
    except asyncio.CancelledError:
        return
    except Exception:
        parent.cancel()
        raise
    parent.cancel()


async def main():
    worker = Worker()
    current = asyncio.current_task()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, current.cancel)
    reader = asyncio.StreamReader(limit=16 * 1024 * 1024)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    queue = asyncio.Queue()

    input_task = asyncio.create_task(read_requests(reader, queue, current))
    try:
        while True:
            request = await queue.get()
            try:
                operation = request["op"]
                if operation == "start":
                    result = await worker.start(request)
                elif operation == "execute":
                    result = await worker.execute(request)
                elif operation == "upload":
                    result = await worker.upload(request["source"], request["destination"])
                elif operation == "forward":
                    result = await worker.forward(request["port"])
                elif operation == "collect":
                    result = await worker.collect(request.get("relative", "."))
                elif operation == "close":
                    break
                else:
                    raise ValueError("Unknown worker operation")
                emit({"id": request["id"], "result": result})
            except Exception as error:
                emit({"id": request["id"], "error": str(error)})
                if request["op"] == "start":
                    break
    except asyncio.CancelledError:
        pass
    finally:
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.add_signal_handler(sig, lambda: None)
        input_task.cancel()
        await asyncio.gather(input_task, return_exceptions=True)
        try:
            await worker.close()
        except Exception as error:
            print(f"Harbor cleanup failed: {error}", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
