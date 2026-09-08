import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("packaged Linux image admits only the chosen app and verifier inputs", async () => {
  const dockerfile = await read("containers/electron-linux-packaged/Dockerfile");
  const copies = dockerfile.split("\n").filter((line) => line.startsWith("COPY "));
  assert.equal(copies.length, 6);
  assert.ok(copies.every((line) => !line.includes("--chown")));
  assert.equal(copies.filter((line) => line.startsWith("COPY scripts ")).length, 1);
  assert.equal(copies.filter((line) => line.startsWith("COPY .release-build/electron-dev/linux-x64/app ")).length, 1);
  assert.deepEqual(copies.filter((line) => line.startsWith("COPY test/")), [
    "COPY test/linux-credential-mutex-native.test.js ./test/linux-credential-mutex-native.test.js",
  ]);
  assert.deepEqual(copies.filter((line) => line.startsWith(
    "COPY .release-build/electron-dev/linux-x64/app/native/linux-credential-mutex/",
  )), [
    "COPY .release-build/electron-dev/linux-x64/app/native/linux-credential-mutex/build/qualification ./native/linux-credential-mutex/build/qualification",
  ]);
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
  assert.deepEqual(exceptions.filter((line) => line.startsWith("!test")), [
    "!test/", "!test/linux-credential-mutex-native.test.js",
  ]);
  assert.ok(exceptions.every((line) => !/profile|\.git|\.usage-monitor|\.release-deps|darwin|win32/u.test(line)));
});

test("packaged Linux default-state and native smoke have no network or user profile mount", async () => {
  const workflow = await read(".github/workflows/electron-development-packages.yml");
  const start = workflow.indexOf("      - name: Exercise packaged Linux credentials in disposable Secret Service");
  assert.ok(start > 0);
  const end = workflow.indexOf("      - name:", start + 1);
  const step = workflow.slice(start, end);
  assert.equal(
    (step.match(/docker run --rm --init --platform=linux\/amd64 --network none/gu) ?? []).length,
    2,
  );
  for (const mount of ["/home/node", "/run/user/1000"]) {
    assert.equal(
      (step.match(new RegExp(
        `--tmpfs ${mount}:rw,noexec,nosuid,size=\\d+m,uid=1000,gid=1000,mode=0700`,
        "gu",
      )) ?? []).length,
      2,
    );
  }
  assert.doesNotMatch(step, /--privileged|--cap-add|--mount|--volume|\s-v\s|--network[= ]host/u);
  assert.doesNotMatch(step, /--env XDG_STATE_HOME=/u);
  assert.match(step, /USAGE_MONITOR_LINUX_CREDENTIAL_MUTEX_NATIVE_TEST=1/u);
  assert.match(step, /USAGE_MONITOR_LINUX_CREDENTIAL_MUTEX_DEFAULT_STATE_TEST=1/u);
  assert.match(step, /--test-reporter=tap/u);
  assert.match(step, /--test-name-pattern=\^native Linux credential state bootstrap creates the absent passwd-home default only in the isolated lane\$/u);
  assert.match(step, /encoding: "utf8"/u);
  assert.match(step, /maxBuffer: 16 \* 1024/u);
  assert.match(step, /stdio: \["ignore", "pipe", "pipe"\]/u);
  assert.match(step, /LINUX_CREDENTIAL_MUTEX_DEFAULT_STATE_BOOTSTRAP_PASSED/u);
  assert.match(step, /markers\.length !== 1/u);
  assert.match(step, /result\.status !== 0/u);
  assert.match(step, /LINUX_CREDENTIAL_MUTEX_DEFAULT_STATE_EVIDENCE_FAILED/u);
  assert.match(step, /LINUX_CREDENTIAL_MUTEX_DEFAULT_STATE_EVIDENCE_PASSED/u);
  assert.match(step, /--source-revision "\$GITHUB_SHA"/u);
  assert.match(step, /--receipt \/run\/user\/1000\/packaged-credential-receipt\.json/u);
  assert.match(step, /TIBOTATTLE_LINUX_SECRET_SERVICE_ISOLATED=1/u);
  assert.match(step, /--staged-app \/workspace\/\.release-build\/electron-dev\/linux-x64\/app/u);
  assert.match(step, /> "\$host_receipt"/u);
  assert.match(workflow.slice(end), /if: \$\{\{ !cancelled\(\) \}\}/u);
});
