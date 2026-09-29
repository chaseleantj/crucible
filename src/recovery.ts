import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { join, relative } from "node:path";
import type { GuestMemory, HarborSession } from "./harbor.js";
import { writeJson } from "./json.js";
import { errorMessage, UserError } from "./errors.js";

/** Keep failed work outside the disposable workspace, including across relaunches. */
export async function collectAgentOutput(
  session: Pick<HarborSession, "collect">,
  directory: string,
  logDir: string,
  path: string,
  failure?: { error: string; memory?: GuestMemory },
): Promise<void> {
  // Record the diagnosis even when the VM can no longer return its files.
  let recovery: string | undefined;
  if (failure) {
    await mkdir(logDir, { recursive: true, mode: 0o700 });
    recovery = await mkdtemp(join(logDir, "recovery-"));
    await writeJson(join(recovery, "failure.json"), { ...failure, collected: false });
  }
  try {
    await session.collect(path);
    if (recovery) {
      const source = join(directory, path);
      await cp(source, join(recovery, "output"), {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
        // Judge workspaces also contain host runtime configuration and frozen inputs.
        filter: (entry) => path !== "." || ![".runtime", ".context", "input"].includes(relative(source, entry).split(/[\\/]/)[0]!),
      });
      await writeJson(join(recovery, "failure.json"), { ...failure, collected: true });
    }
  } catch (error) {
    if (!failure || !recovery) throw error;
    const collectionError = errorMessage(error);
    await writeJson(join(recovery, "failure.json"), { ...failure, collected: false, collectionError });
    throw new UserError(`${failure.error}; partial output collection failed: ${collectionError}`);
  }
}
