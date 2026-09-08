import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("packaged Linux image admits only the chosen app and verifier inputs", async () => {
  const dockerfile = await read("containers/electron-linux-packaged/Dockerfile");
  const copies = dockerfile.split("\n").filter((line) => line.startsWith("COPY "));
  assert.equal(copies.length, 4);
  assert.ok(copies.every((line) => !line.includes("--chown")));
  assert.equal(copies.filter((line) => line.startsWith("COPY scripts ")).length, 1);
  assert.equal(copies.filter((line) => line.startsWith("COPY .release-build/electron-dev/linux-x64/app ")).length, 1);
  const generated = copies.filter((line) => line.startsWith("COPY .release-build/electron-candidates/"));
  assert.equal(generated.length, 2);
  assert.ok(generated.every((line) => line.includes("${TIBOTATTLE_QUALIFICATION_REVISION}/linux-x64/distribution/")));
  assert.ok(generated.some((line) => line.includes("/linux-unpacked ")));
  assert.ok(generated.some((line) => line.includes("/development-package.json ")));
  assert.match(dockerfile, /process\.argv\[1\] !== process\.env\.TIBOTATTLE_IMAGE_SOURCE_REVISION/u);
  assert.match(dockerfile, /-type d -exec chmod 0755/u);
  assert.match(dockerfile, /-type f -perm \/111 -exec chmod 0555/u);
  assert.match(dockerfile, /-type f ! -perm \/111 -exec chmod 0444/u);
  assert.match(dockerfile, /USER node\nENTRYPOINT/u);

  const exceptions = (await read("containers/electron-linux-packaged/Dockerfile.dockerignore"))
    .trim().split("\n");
  assert.equal(exceptions.shift(), "*");
  const recursive = exceptions.filter((line) => line.endsWith("/**"));
  assert.deepEqual(recursive.sort(), [
    "!.release-build/electron-candidates/*/linux-x64/distribution/linux-unpacked/**",
    "!.release-build/electron-dev/linux-x64/app/**",
    "!scripts/**",
  ]);
  assert.ok(exceptions.every((line) => !/profile|\.git|\.usage-monitor|\.release-deps|darwin|win32/u.test(line)));
});

test("packaged Linux native smoke has no network or user profile mount", async () => {
  const workflow = await read(".github/workflows/electron-development-packages.yml");
  const start = workflow.indexOf("      - name: Exercise packaged Linux credentials in disposable Secret Service");
  assert.ok(start > 0);
  const end = workflow.indexOf("      - name:", start + 1);
  const step = workflow.slice(start, end);
  assert.match(step, /docker run --rm --init --platform=linux\/amd64 --network none/u);
  for (const mount of ["/home/node", "/run/user/1000"]) {
    assert.match(step, new RegExp(`--tmpfs ${mount}:rw,noexec,nosuid,size=\\d+m,uid=1000,gid=1000,mode=0700`, "u"));
  }
  assert.doesNotMatch(step, /--privileged|--cap-add|--mount|--volume|\s-v\s|--network[= ]host/u);
  assert.match(step, /--source-revision "\$GITHUB_SHA"/u);
  assert.match(step, /--receipt \/run\/user\/1000\/packaged-credential-receipt\.json/u);
  assert.match(step, /TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED=1/u);
  assert.match(step, /--staged-app \/workspace\/\.release-build\/electron-dev\/linux-x64\/app/u);
  assert.match(step, /> "\$host_receipt"/u);
  assert.match(workflow.slice(end), /if: \$\{\{ !cancelled\(\) \}\}/u);
});
