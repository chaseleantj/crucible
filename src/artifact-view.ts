import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { renderMarkdown } from "./html.js";

export const ARTIFACT_VIEW_FLAG = "crucible-viewer";
export const isMarkdown = (file: string): boolean => /\.(md|markdown)$/i.test(file);
export const isViewableArtifact = (file: string): boolean => /\.(html?|svg|md|markdown)$/i.test(file);

/** The same reading surface for runner captures and the dashboard's live viewer. */
export async function artifactPage(file: string): Promise<string | null> {
  if (/\.svg$/i.test(file)) {
    const name = basename(file);
    const src = encodeURIComponent(name).replace(/'/g, "%27");
    return `<!doctype html><meta charset="utf-8"><title>${name.replace(/[<&]/g, "")}</title>`
      + `<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#fff}img{max-width:100%;max-height:100%}</style>`
      + `<img src="./${src}" alt="">`;
  }
  if (!isMarkdown(file)) return null;
  return '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Document</title>'
    + '<style>html{color:#222;background:#fff;font:18px/1.6 system-ui,sans-serif}body{max-width:760px;margin:0 auto;padding:32px 24px;overflow-wrap:anywhere}h1,h2,h3{line-height:1.2}pre{padding:16px;background:#f4f4f4;overflow:auto}code{font-size:.9em}blockquote{margin-left:0;padding-left:20px;border-left:3px solid #ddd}table{border-collapse:collapse;display:block;overflow:auto}th,td{padding:8px 12px;border:1px solid #ddd;text-align:left}img{max-width:100%;height:auto}a{color:#1759a8}</style>'
    + `<main>${renderMarkdown(await readFile(file, "utf8"), 0)}</main>`;
}
