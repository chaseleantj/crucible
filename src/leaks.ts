import { glob, readFile, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { buildManifest, sha256File } from "./files.js";
import type { ForbiddenIdentity, ForbiddenMaterial, LeakFinding } from "./types.js";

interface SkillIdentity {
  name: string;
  title?: string;
  aliases: string[];
}

export async function readSkillIdentity(candidatePath: string): Promise<SkillIdentity> {
  const skillPath = join(candidatePath, "SKILL.md");
  const content = await readFile(skillPath, "utf8");
  const frontmatter = readFrontmatter(content);
  const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
  const aliases = Array.isArray(frontmatter.aliases)
    ? frontmatter.aliases.filter((value): value is string => typeof value === "string")
    : [];
  return {
    name: typeof frontmatter.name === "string" ? frontmatter.name : basename(candidatePath),
    ...(heading ? { title: heading } : {}),
    aliases,
  };
}

/** What names one arm's candidate: its slug, title, aliases, and the paths it was frozen from. */
export async function buildForbiddenIdentities(candidatePath: string, dependencies: string[], arm: string): Promise<ForbiddenIdentity[]> {
  const identity = await readSkillIdentity(candidatePath);
  const values: ForbiddenIdentity[] = [
    { label: "candidate slug", value: identity.name, kind: "identifier", arm },
    { label: "candidate path", value: resolve(candidatePath), kind: "path", arm },
  ];
  if (identity.title && identity.title.toLocaleLowerCase() !== identity.name.toLocaleLowerCase()) {
    values.push({ label: "candidate title", value: identity.title, kind: "identifier", arm });
  }
  for (const alias of identity.aliases) values.push({ label: "candidate alias", value: alias, kind: "identifier", arm });
  for (const path of dependencies) values.push({ label: "candidate dependency path", value: resolve(path), kind: "path", arm });
  return deduplicateIdentities(values);
}

/**
 * The identities and file hashes hidden from one arm: everything belonging to
 * another arm and not also belonging to this arm, plus what no arm may see. Pass null for the whole set, which is
 * what the source and the judge package are checked against.
 */
export function hiddenFrom(material: ForbiddenMaterial, arm: string | null): { identities: ForbiddenIdentity[]; hashes: Set<string> } {
  const identityKey = (identity: ForbiddenIdentity) => `${identity.kind}:${identity.value}`;
  const allowedIdentities = new Set(material.identities.filter((identity) => identity.arm === arm).map(identityKey));
  const allowedHashes = new Set(material.hashes.filter((hash) => hash.arm === arm).map((hash) => hash.value));
  return {
    identities: material.identities.filter((identity) => identity.arm === undefined || !allowedIdentities.has(identityKey(identity))),
    hashes: new Set(material.hashes.filter((hash) => hash.arm === undefined || !allowedHashes.has(hash.value)).map((hash) => hash.value)),
  };
}

/**
 * Every file that belongs to one candidate, by content. A dependency may be a
 * single file rather than a folder — a craft is one Markdown file — so each
 * root is checked before it is walked.
 */
export async function collectForbiddenHashes(candidatePath: string, dependencies: string[]): Promise<Set<string>> {
  const hashes = new Set<string>();
  for (const root of [candidatePath, ...dependencies]) {
    if (!(await stat(root).catch(() => null))?.isDirectory()) {
      const hash = await sha256File(root).catch(() => null);
      if (hash) hashes.add(hash);
      continue;
    }
    for await (const entry of glob(["**/*", "**/.*", ".*"], { cwd: root })) {
      const path = join(root, entry);
      try {
        hashes.add(await sha256File(path));
      } catch {
        // Directories are yielded by fs.glob and do not have content hashes.
      }
    }
  }
  return hashes;
}

export async function scanFiles(
  root: string,
  relativePaths: string[],
  identities: ForbiddenIdentity[],
  forbiddenHashes: Set<string>,
): Promise<LeakFinding[]> {
  const findings: LeakFinding[] = [];
  for (const relativePath of relativePaths) {
    const path = join(root, relativePath);
    const hash = await sha256File(path);
    if (forbiddenHashes.has(hash)) {
      findings.push({
        path: relativePath,
        identity: { label: "forbidden file hash", value: hash, kind: "identifier" },
      });
      continue;
    }
    const content = await readFile(path, "utf8");
    for (const identity of identities) {
      if (matchesIdentity(content, identity)) findings.push({ path: relativePath, identity });
    }
  }
  return findings;
}

export async function scanTree(
  root: string,
  identities: ForbiddenIdentity[],
  forbiddenHashes: Set<string>,
): Promise<LeakFinding[]> {
  const manifest = await buildManifest(root);
  return scanFiles(root, manifest.entries.map((entry) => entry.path), identities, forbiddenHashes);
}

/**
 * Frozen skills live under `.context/skills/<slug>/`. Following the skill
 * writes that folder into logs and imports. Those files identify the arm, but
 * they are not a prose confession. Remove them from a judge copy.
 */
export async function omitSkillPathEchoes(
  root: string,
  identities: ForbiddenIdentity[],
): Promise<string[]> {
  const slugs = identities.filter((identity) => identity.kind === "identifier").map((identity) => identity.value);
  const removed: string[] = [];
  const manifest = await buildManifest(root);
  for (const entry of manifest.entries) {
    const path = join(root, entry.path);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch {
      continue;
    }
    if (!identities.some((identity) => matchesIdentity(content, identity))) continue;
    const remainder = slugs.reduce((text, slug) => stripSkillPathEchoes(text, slug), content);
    if (identities.some((identity) => matchesIdentity(remainder, identity))) continue;
    await rm(path);
    removed.push(entry.path);
  }
  return removed;
}

export function matchesIdentity(content: string, identity: ForbiddenIdentity): boolean {
  if (identity.value.length < 3) return false;
  if (identity.kind === "path") return content.includes(identity.value);
  const escaped = identity.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = /^[\p{L}\p{N}_]/u.test(identity.value) ? "(?<![\\p{L}\\p{N}_-])" : "";
  const suffix = /[\p{L}\p{N}_]$/u.test(identity.value) ? "(?![\\p{L}\\p{N}_-])" : "";
  return new RegExp(`${prefix}${escaped}${suffix}`, "iu").test(content);
}

function stripSkillPathEchoes(content: string, slug: string): string {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content
    .replace(new RegExp(`\\.context/skills/${escaped}`, "gi"), "")
    .replace(new RegExp(`skills/${escaped}`, "gi"), "");
}

function readFrontmatter(content: string): Record<string, unknown> {
  const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(content);
  if (!match?.[1]) return {};
  const value = parseYaml(match[1]);
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function deduplicateIdentities(values: ForbiddenIdentity[]): ForbiddenIdentity[] {
  const seen = new Set<string>();
  return values.filter((identity) => {
    const key = `${identity.arm ?? ""}:${identity.kind}:${identity.value.toLocaleLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
