import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("speed attribution occupies a disclosure row without displacing overhead cards", async () => {
  const [styles, source] = await Promise.all([
    readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  ]);
  assert.match(source, /node\("p", "annotation accounting-speed-coverage"\)/u);
  assert.match(
    styles,
    /\.accounting-summary > \.accounting-speed-coverage\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;/u,
  );
  // This rule still stretches a lone allowance card, but must not mistake the
  // accounting disclosure for a card when deciding which metric is alone.
  assert.match(
    styles,
    /\.metric-grid:not\(\.accounting-summary\) > :last-child:nth-child\(odd\)/u,
  );
  assert.doesNotMatch(styles, /\.metric-grid > :last-child:nth-child\(odd\)/u);
});
