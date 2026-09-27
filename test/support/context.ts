import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SHARED_NAMES = ["crafts", "styles"];

/** A crafts and a styles folder of shared guidance under `guidance`. */
export async function withSharedContext(guidance: string): Promise<string> {
  for (const name of SHARED_NAMES) {
    await mkdir(join(guidance, name), { recursive: true });
    await writeFile(join(guidance, name, `${name}.md`), `shared ${name}\n`);
  }
  return guidance;
}

/** The shared folders `withSharedContext` made, as a config lists them. */
export const sharedFolders = (guidance: string) => SHARED_NAMES.map((name) => join(guidance, name));

/** The same, written as a YAML flow list for an experiment file. */
export const sharedYaml = (guidance: string) => `[${sharedFolders(guidance).join(", ")}]`;

/** Run `body` with a user config file holding `yaml` in place of the real one. */
export async function withUserConfig<T>(root: string, yaml: string, body: () => Promise<T>): Promise<T> {
  const file = join(root, "user-config.yaml");
  await writeFile(file, yaml);
  const previous = process.env.CRUCIBLE_CONFIG;
  process.env.CRUCIBLE_CONFIG = file;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.CRUCIBLE_CONFIG;
    else process.env.CRUCIBLE_CONFIG = previous;
  }
}
