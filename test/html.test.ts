import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "../src/html.js";

test("the report's markdown renderer covers a judge's verdict", () => {
  const html = renderMarkdown([
    "# Verdict",
    "",
    "Both **render** with `code` and a [link](https://example.com).",
    "",
    "| | A | B |",
    "|---|---|---|",
    "| Words | 2744 | 1954 |",
    "",
    "- one",
    "- two",
    "  continued",
    "",
    "```",
    "<pre> stays literal",
    "```",
  ].join("\n"));
  assert.match(html, /<h2>Verdict<\/h2>/);
  assert.match(html, /<b>render<\/b> with <code>code<\/code> and a <a href="https:\/\/example.com">link<\/a>/);
  assert.match(html, /<td class="num">2744<\/td>/);
  assert.match(html, /<li>two continued<\/li>/);
  assert.match(html, /&lt;pre&gt; stays literal/);
});

test("the markdown renderer links only web, mail, relative, and anchor targets", () => {
  const html = renderMarkdown([
    "[web](https://example.com) [mail](mailto:a@example.com) [page](outputs/a/index.html) [top](#verdict)",
    "[script](javascript:alert(1)) [data](data:text/html,x) [hidden](\u0001javascript:alert(1)) [Upper](JavaScript:alert(1))",
  ].join("\n"));
  for (const target of ["https://example.com", "mailto:a@example.com", "outputs/a/index.html", "#verdict"]) assert.ok(html.includes(`href="${target}"`), target);
  assert.doesNotMatch(html, /href="(javascript|data|JavaScript):/i);
  assert.match(html, /script/);
  assert.equal((html.match(/<a /g) ?? []).length, 4);
});
