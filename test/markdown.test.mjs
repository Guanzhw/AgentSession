import assert from "node:assert/strict";
import test from "node:test";

import { renderMarkdown } from "../dist/src/markdown.js";
import { messageBubble, reasoningBlock, toolCallBlock } from "../dist/src/views/components.js";
import { setLocale } from "../dist/src/i18n.js";

// ---------------------------------------------------------------------------
// Block features
// ---------------------------------------------------------------------------

test("markdown renders headings, paragraphs, rules, quotes, and lists", () => {
  const html = renderMarkdown(
    "# Title\n\nSome **bold** and *italic* text.\n\n---\n\n> quoted\n\n- one\n- two\n\n1. first\n2. second"
  );
  assert.ok(html.includes("<h1>Title</h1>"));
  assert.ok(html.includes("<strong>bold</strong>"));
  assert.ok(html.includes("<em>italic</em>"));
  assert.ok(html.includes("<hr>"));
  assert.ok(html.includes("<blockquote><p>quoted</p></blockquote>"));
  assert.ok(html.includes("<ul>\n<li>one</li>\n<li>two</li>\n</ul>"));
  assert.ok(html.includes("<ol>\n<li>first</li>\n<li>second</li>\n</ol>"));
});

test("markdown renders fenced code with language and escaped body", () => {
  const html = renderMarkdown("```ts\nconst x = `<script>`;\n```");
  assert.ok(html.includes("<pre><code class=\"language-ts\">const x = `&lt;script&gt;`;</code></pre>"));
  assert.ok(!html.includes("<script>"));
  // Unclosed fences still render everything safely.
  const open = renderMarkdown("```\nnever closed");
  assert.ok(open.includes("<pre><code>never closed</code></pre>"));
});

test("markdown supports nested lists and ordered list start numbers", () => {
  const html = renderMarkdown("- a\n  - a1\n  - a2\n- b");
  assert.ok(html.includes("<ul>\n<li>a<ul>\n<li>a1</li>\n<li>a2</li>\n</ul></li>\n<li>b</li>\n</ul>"));
  const numbered = renderMarkdown("3. three\n4. four");
  assert.ok(numbered.includes('<ol start="3">\n<li>three</li>\n<li>four</li>\n</ol>'));
});

test("markdown renders GFM task lists", () => {
  const html = renderMarkdown("- [x] done\n- [ ] pending");
  assert.ok(html.includes('<li class="task-list-item"><input type="checkbox" disabled checked> done</li>'));
  assert.ok(html.includes('<li class="task-list-item"><input type="checkbox" disabled> pending</li>'));
});

test("markdown renders GFM tables with alignment", () => {
  const html = renderMarkdown("| Name | Qty |\n| :--- | ---: |\n| A | 1 |\n| B | 2 |");
  assert.ok(html.includes("<table>"));
  assert.ok(html.includes('<thead><tr><th style="text-align:left">Name</th><th style="text-align:right">Qty</th></tr></thead>'));
  assert.ok(html.includes('<tbody><tr><td style="text-align:left">A</td><td style="text-align:right">1</td></tr>'));
});

test("markdown supports inline code, strikethrough, and protected markers", () => {
  const html = renderMarkdown("Use `code *not em*` and ~~gone~~.");
  assert.ok(html.includes("<code>code *not em*</code>"));
  assert.ok(html.includes("<del>gone</del>"));
  // Strong/em markers inside code spans stay literal and both render.
  const mixed = renderMarkdown("`**x**` **y**");
  assert.ok(mixed.includes("<code>**x**</code>"));
  assert.ok(mixed.includes("<strong>y</strong>"));
  const nested = renderMarkdown("**bold [link](https://example.com)**");
  assert.ok(nested.includes('<strong>bold <a href="https://example.com"'));
  assert.ok(nested.includes("</a></strong>"));
});

test("markdown nests blockquotes with a bounded depth", () => {
  const html = renderMarkdown("> a\n> > b");
  assert.ok(html.includes("<blockquote><p>a</p>\n<blockquote><p>b</p></blockquote></blockquote>"));
  const deep = renderMarkdown(`${"> ".repeat(30)}x`);
  assert.ok(!deep.includes(`<blockquote>`.repeat(10)), "blockquote nesting is depth-bounded");
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

test("markdown always escapes raw HTML", () => {
  const html = renderMarkdown('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n<p onclick="x()">y</p>');
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.ok(!html.includes("<p onclick"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror=alert(2)&gt;"));
});

test("markdown rejects unsafe URL schemes in links", () => {
  const html = renderMarkdown(
    "[ok](https://example.com) [js](javascript:alert(1)) [Js](JavaScript:alert(1)) [data](data:text/html,x) [vb](vbscript:x) [rel](/local) [hash](#frag) [mail](mailto:a@b.c)"
  );
  assert.ok(html.includes('<a href="https://example.com" target="_blank" rel="noopener">ok</a>'));
  assert.ok(html.includes("js (javascript:alert(1))"), "javascript: renders as inert text");
  assert.ok(html.includes("Js (JavaScript:alert(1))"), "mixed-case schemes are rejected");
  assert.ok(html.includes("data (data:text/html,x)"));
  assert.ok(html.includes("vb (vbscript:x)"));
  assert.ok(html.includes('<a href="/local" target="_blank" rel="noopener">rel</a>'));
  assert.ok(html.includes('<a href="#frag" target="_blank" rel="noopener">hash</a>'));
  assert.ok(html.includes('<a href="mailto:a@b.c" target="_blank" rel="noopener">mail</a>'));
  assert.ok(!html.includes("href=\"javascript:"));
  assert.ok(!html.includes("href=\"data:"));
});

test("markdown strips control characters from URL schemes", () => {
  const html = renderMarkdown("[x](java\u0000script:alert(1)) [y](java\u0001script:alert(2))");
  assert.ok(html.includes("x (java\u0000script:alert(1))"));
  assert.ok(html.includes("y (java\u0001script:alert(2))"));
  assert.ok(!html.includes("href=\"java"));
  const invisible = renderMarkdown("[z](\u200Bjavascript:alert(3))");
  assert.ok(!invisible.includes("href="));
});

test("markdown autolinks bare http(s) URLs", () => {
  const html = renderMarkdown("see https://example.com/a?b=1 now");
  assert.ok(html.includes('<a href="https://example.com/a?b=1" target="_blank" rel="noopener">https://example.com/a?b=1</a>'));
});

test("markdown renders images as safe links", () => {
  const html = renderMarkdown("![alt text](https://example.com/i.png)");
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes('<a href="https://example.com/i.png" target="_blank" rel="noopener">alt text</a>'));
});

test("markdown handles empty and falsy input", () => {
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown(null), "");
  assert.equal(renderMarkdown("   \n  "), "");
});

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

test("human message roles render Markdown; machine roles stay plain", () => {
  setLocale("en");
  const user = messageBubble("user", "# Hello\n\nworld");
  assert.ok(user.includes('<div class="message-body markdown">'));
  assert.ok(user.includes("<h1>Hello</h1>\n<p>world</p>"));
  const agent = messageBubble("agent", "**strong**");
  assert.ok(agent.includes("<p><strong>strong</strong></p>"));
  const assistant = messageBubble("assistant", "*em*");
  assert.ok(assistant.includes("<p><em>em</em></p>"));
  const system = messageBubble("system", "<b>x</b>");
  assert.ok(system.includes('<pre class="message-body plain">&lt;b&gt;x&lt;/b&gt;</pre>'));
  const tool = messageBubble("tool", "raw {json}");
  assert.ok(tool.includes('<pre class="message-body plain">raw {json}</pre>'));
});

test("long Markdown messages use server-backed continuation", () => {
  setLocale("en");
  const html = messageBubble("assistant", `# Title\n\n${"body\n".repeat(4000)}`, { partId: "text-1" });
  assert.ok(html.includes("<h1>Title</h1>"));
  assert.ok(html.includes('data-part-id="text-1"'));
  assert.ok(html.includes('data-field="text"'));
  assert.ok(html.includes("progressive-more"));
  assert.ok(html.length < 20000, "the full message is not embedded in initial HTML");
});

// ---------------------------------------------------------------------------
// Progressive expansion (no permanent data loss)
// ---------------------------------------------------------------------------

test("reasoningBlock bounds initial HTML and adds a server continuation marker", () => {
  setLocale("en");
  const long = "x".repeat(7000);
  const html = reasoningBlock(long, "", "reasoning-1");
  assert.ok(html.includes('class="progressive"'));
  assert.ok(html.includes("progressive-more"));
  assert.ok(html.includes('data-part-id="reasoning-1"'));
  assert.ok(html.includes('data-field="reasoning"'));
  assert.ok(html.includes('data-next-offset="6000"'));
  assert.ok(html.includes("Show more"));
  assert.ok(!html.includes("truncated"), "no permanent truncation marker");
  assert.ok(html.includes("x".repeat(6000)), "the complete first chunk is present");
  assert.ok(!html.includes("x".repeat(6001)), "the remainder is not embedded initially");
});

test("reasoningBlock renders short content without a wrapper", () => {
  const html = reasoningBlock("short reasoning");
  assert.ok(!html.includes("progressive"));
  assert.ok(html.includes("<p>short reasoning</p>"));
});

test("reasoningBlock splits at paragraph boundaries and localizes the button", () => {
  setLocale("zh");
  const paragraphs = "para two\n\n".repeat(700);
  const zh = reasoningBlock(paragraphs, "", "reasoning-zh");
  assert.ok(zh.includes("显示更多"));
  assert.ok((zh.match(/<p>para two<\/p>/g) || []).length < 700, "later paragraphs are not embedded initially");
  setLocale("en");
});

test("toolCallBlock keeps full input/output with bounded initial rendering", () => {
  setLocale("en");
  const longInput = "z".repeat(3500);
  const longOutput = "y".repeat(3500);
  const html = toolCallBlock("grep", longInput, longOutput, "completed", "", "p1");
  assert.ok(html.includes('id="part-p1"'));
  assert.ok(html.includes("progressive-more"));
  assert.ok(html.includes("z".repeat(3000)) && !html.includes("z".repeat(3001)), "input is bounded");
  assert.ok(html.includes("y".repeat(3000)) && !html.includes("y".repeat(3001)), "output is bounded");
  assert.ok(html.includes('data-field="input"'));
  assert.ok(html.includes('data-field="output"'));
  assert.ok(!html.includes("truncated"));
  // Labels are preserved.
  assert.ok(html.includes(">Input</h4>"));
  assert.ok(html.includes(">Output</h4>"));
});

test("toolCallBlock renders string output as Markdown when appropriate", () => {
  setLocale("en");
  const html = toolCallBlock("read", { filePath: "a.md" }, "# Heading\n\n- one\n- two", "completed", "", "");
  assert.ok(html.includes('<div class="tool-output-body markdown"><h1>Heading</h1>'));
  assert.ok(html.includes("<li>one</li>"));
  const long = toolCallBlock(
    "read",
    {},
    `# Heading\n\n${"plain text\n".repeat(500)}\n- final item`,
    "completed",
    "",
    "markdown-tool"
  );
  assert.ok(long.includes('class="tool-output-body markdown"'));
  assert.ok(long.includes('data-part-id="markdown-tool"'));
  assert.ok(long.includes('data-field="output"'));
});

test("toolCallBlock keeps structured output as escaped formatted JSON", () => {
  const html = toolCallBlock("search", { pattern: "x" }, { hits: 2, items: [1, 2] }, "completed", "", "");
  assert.ok(html.includes("<pre>{"));
  assert.ok(html.includes("&quot;hits&quot;: 2"));
  assert.ok(html.includes("&quot;items&quot;: ["));
  assert.ok(!html.includes("<div class=\"tool-output-body markdown\">"));
  // Plain string output with no markdown constructs stays raw.
  const plain = toolCallBlock("exec", {}, "exit code 0\nall good", "completed", "", "");
  assert.ok(plain.includes("<pre>exit code 0\nall good</pre>"));
  assert.ok(!plain.includes("tool-output-body"));
});

test("renderMarkdown keeps four-space-indented block markers inside paragraphs", () => {
  const source = [
    "commit message",
    "    ---",
    "    Codex, GPT-5"
  ].join("\n");

  const html = renderMarkdown(source);
  assert.match(html, /<p>commit message --- Codex, GPT-5<\/p>/);
});

test("renderMarkdown does not consume placeholder-shaped null-byte input", () => {
  const html = renderMarkdown("before \u0000as:0\u0000 after");
  assert.ok(html.includes("before \u0000as:0\u0000 after"));
});
