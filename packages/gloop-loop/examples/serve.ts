#!/usr/bin/env bun
/**
 * Dev server for the browser example.
 * Bundles @hypen-space/gloop-loop for the browser and serves it alongside the HTML.
 *
 * Usage: cd packages/gloop-loop && bun run examples/serve.ts
 */

const PORT = 3333;

// Bundle gloop-loop for the browser
const bundle = await Bun.build({
  entrypoints: [new URL("../src/index.ts", import.meta.url).pathname],
  format: "esm",
  target: "browser",
  minify: false,
});

if (!bundle.success) {
  console.error("Build failed:");
  for (const log of bundle.logs) console.error(log);
  process.exit(1);
}

const bundleJS = await bundle.outputs[0].text();
const htmlSource = await Bun.file(new URL("./browser.html", import.meta.url).pathname).text();

// Inject an importmap so the bare import resolves to our bundle
const importMap = `<script type="importmap">
{"imports":{"@hypen-space/gloop-loop":"/gloop-loop.js"}}
</script>`;
const html = htmlSource.replace("<head>", `<head>\n  ${importMap}`);

Bun.serve({
  port: PORT,
  routes: {
    "/": new Response(html, {
      headers: { "Content-Type": "text/html" },
    }),
    "/gloop-loop.js": new Response(bundleJS, {
      headers: { "Content-Type": "application/javascript" },
    }),
  },
});

console.log(`\n  gloop-loop browser example`);
console.log(`  http://localhost:${PORT}\n`);
