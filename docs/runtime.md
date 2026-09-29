# Runtime and isolation

| Setting | Default or limit | Scope |
| --- | --- | --- |
| Arms per experiment | 1–10 | Includes the reference arm |
| Active VMs (`runtime.concurrency`) | 2 | Shared across Crucible processes under the same macOS user |
| CPUs (`runtime.cpus`) | 2 | Per active VM |
| Memory (`runtime.memoryMb`) | 4096 MiB (4 GiB) | Per active VM |
| Producer timeout | 120 minutes | Per producer |
| Judge timeout | 30 minutes | Per judge |

A ten-arm experiment still runs at most two arms at once with these defaults. The remaining arms queue without starting VMs. Each producer gets a fresh VM; subagents share their parent's VM. The judge gets a separate VM and uses the same queue and resource settings. Guests are deleted after output collection. Queue, boot, and setup time are excluded from reported agent time.

Set resources in the **experiment YAML**, independently of the number of arms:

```yaml
runtime:
  concurrency: 2
  cpus: 2
  memoryMb: 4096
```

Omitted fields keep their defaults. These values must be positive integers; concurrency has no fixed software maximum. Simultaneous runs must agree on concurrency, and a conflicting setting is rejected while slots are occupied. Two default VMs have 8 GiB of configured guest memory in total, plus host overhead.

For small tasks, `cpus: 1` and `memoryMb: 2048` may suffice. Increasing concurrency to 10 configures 40 GiB of guest memory at the default size, or 20 GiB at 2048 MiB. Allow room for macOS, other apps, and VM overhead, and measure the actual workload before increasing concurrency. Crucible does not automatically choose resources based on the task.

For browser-heavy 3D tasks, start with `memoryMb: 8192` per VM. Multiple Chromium captures using software rendering can exhaust a 4 GiB guest. Producer and judge instructions ask agents to capture sequentially and close each browser before opening the next; the memory limit below is enforced even if an agent ignores that guidance.

### Memory exhaustion and recovery

Each setup or agent command and all its descendants share a root-owned Linux memory cgroup. Crucible reserves the smaller of 512 MiB or 25% of guest RAM outside that workload limit for supervision and recovery. Workloads cannot increase their own limit or move themselves outside it. Provisioning fails if memory enforcement is unavailable.

If the workload exceeds its limit, Linux kills the workload group while the supervisor remains able to retrieve files. Crucible reads kernel OOM counters and peak usage, reports an explicit out-of-memory failure, and saves `memory.json` in the producer's or judge's agent log directory. Setup commands save numbered `setup-memory-*.json` records. An OOM is never treated as a timeout or a successful result, even when the agent wrote output or emitted a completion event.

Failed execution triggers partial-output collection before VM cleanup. A `recovery-*` directory beside the agent logs retains the output and `failure.json` across later relaunches. If collection fails, the diagnosis remains with `collected: false`. These snapshots are unfinished work and are not scored. Host runtime configuration and frozen judge inputs are excluded from judge recovery snapshots.

Log-read transport timeouts have bounded retries; they are separate from the producer's time budget and from confirmed OOM. If a VM is still present, `container logs --boot <name>` exposes its kernel log. Automatic model reruns and memory increases are not enabled: adjust the experiment's resources and prepare a new run so its recorded configuration describes the comparison accurately.

## Isolation and credentials

Harbor creates a disposable Linux guest for each producer and judge. Crucible uploads the selected project and that arm's frozen skills and inputs, then retrieves outputs before deleting the guest. No host home, project checkout, or sibling arm is mounted. The guest is the outer execution boundary. Native automatic permission review is also enabled for producers and judges:

| Agent | Permission mode | Inner sandbox |
| --- | --- | --- |
| Codex | `--approve-for-me` | Native Linux workspace sandbox |
| Claude | `--permission-mode auto --permission-prompts none` | No additional sandbox enabled by Crucible |
| Cursor | `--auto-review` | Disabled; the VM provides isolation |

These modes review eligible actions automatically; they do not send every action to a reviewer. An action needing manual approval can be denied in an unattended run. Crucible never retries a denied action with bypass permissions. Model or account restrictions on automatic review can prevent a run from completing. Review may add latency or usage, and different harnesses apply different policies. Native usage reports may not itemize reviewer costs.

Public network access remains available at the VM boundary; native review and sandbox rules may impose further restrictions. Review reduces risk but does not make assigned data safe from every prompt injection.

The credential broker stays on the host. Agents receive stand-in tokens, and the broker substitutes your existing login only on the provider's API routes. Bedrock, Vertex, and a bare Cursor API key without a login are rejected because those authentication flows are not brokered; see [credential setup](../CREDENTIALS.md). Agents can spend model budget and send their assigned project data over the network.

The judge receives anonymous outputs in shuffled order. Preparation checks for explicit candidate names and copied withheld inputs; output style can still reveal a treatment. Reports and the dashboard reveal the arm labels after judging.

`sandbox: false` is no longer supported. Remove it when migrating an older experiment. Host `nodeModules` sharing is also rejected; use a Linux setup command such as `producer: {agent: claude, setup: npm ci}` with a frozen package manifest and lockfile. Old reports and archives remain readable.
