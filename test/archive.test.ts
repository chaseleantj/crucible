import assert from "node:assert/strict";
import test from "node:test";
import { localReferences } from "../src/archive.js";

const dandelion = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">'
  + '<style>body:after{content:"";position:fixed;inset:0}</style>  <script type="module" crossorigin src="./assets/index-8upa3DuJ.js"></script></head><body></body></html>';

test("archive reference scanning survives empty quoted strings before a script asset", () => {
  const references = localReferences(dandelion);
  assert.ok(references.includes("./assets/index-8upa3DuJ.js"), JSON.stringify(references));
  assert.ok(!references.some((reference) => reference.includes("crossorigin src=")), JSON.stringify(references));
});

test("an apostrophe in prose does not shift the pairing of double-quoted attribute values", () => {
  const references = localReferences("<p>Ada's notes</p><link rel=\"stylesheet\" href=\"style.css\"><img src=\"hero.png\" alt=\"Ada's dog\"><script src=\"app.js\"></script>");
  for (const expected of ["style.css", "hero.png", "app.js"]) assert.ok(references.includes(expected), `${expected} in ${JSON.stringify(references)}`);
});

test("module literals, CSS urls, and Markdown links are found; absolute URLs and fragments are not", () => {
  const references = localReferences([
    "import { a } from './lib/a.js';",
    'const img = new URL("./img/x.svg", import.meta.url);',
    "body { background: url(./bg.png) } a { background: url( 'tile.png' ) }",
    "[docs](notes/readme.md) [site](https://example.com) [top](#top)",
    'fetch("https://api.example.com/data"); location.hash = "#x"; src="/absolute.js"',
  ].join("\n"));
  for (const expected of ["./lib/a.js", "./img/x.svg", "./bg.png", "tile.png", "notes/readme.md"]) {
    assert.ok(references.includes(expected), `${expected} in ${JSON.stringify(references)}`);
  }
  for (const excluded of ["https://example.com", "https://api.example.com/data", "#top", "#x", "/absolute.js"]) {
    assert.ok(!references.includes(excluded), `${excluded} excluded from ${JSON.stringify(references)}`);
  }
});
