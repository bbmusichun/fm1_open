#!/usr/bin/env node
// SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
// Serves the single-file browser preview produced by tools/Build-Web-Preview.mjs.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const page = join(root, 'build/preview/index.html');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';

// The workbench template is written without explicit <head>/<body> tags (the
// parser infers them). Tooling that injects helper scripts by HTML rewrite, such
// as the sandbox preview, needs the tags to be present, so the served copy gets
// them; build/preview/index.html itself is left as the build produced it.
function frameDocument(html) {
  const htmlTag = /<html\b[^>]*>/i.exec(html);
  if (!htmlTag) throw new Error('Preview page has no <html> element.');
  const headPattern = /^\s*(?:<!--[\s\S]*?-->|<(?:meta|link)\b[^>]*>|<(?<tag>title|style)\b[^>]*>[\s\S]*?<\/\k<tag>>)/i;
  const start = htmlTag.index + htmlTag[0].length;
  let cursor = start;
  for (let match = headPattern.exec(html.slice(cursor)); match; match = headPattern.exec(html.slice(cursor))) {
    cursor += match[0].length;
  }
  const head = html.slice(start, cursor);
  const body = html.slice(cursor);
  if (!/<meta\b/i.test(head)) throw new Error('Preview page head not recognised.');
  const closed = /<\/html>\s*$/i.test(body)
    ? body.replace(/<\/html>\s*$/i, '</body>\n</html>\n')
    : `${body}</body>`;
  return `${html.slice(0, start)}<head>${head.trimStart()}</head>\n<body>${closed.replace(/^\s*\n/, '')}`;
}

createServer((request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  if (path !== '/' && path !== '/index.html') {
    response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Not found\n');
    return;
  }
  // Read per request so a rebuilt preview shows up on reload.
  const body = Buffer.from(frameDocument(readFileSync(page, 'utf8')), 'utf8');
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}).listen(port, host, () => {
  console.log(`FM1 web preview listening on http://${host}:${port}`);
});
