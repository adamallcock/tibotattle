import { chmod, lstat, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function fail(message) {
  throw new Error(message);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) fail(`Missing ${name}`);
  return process.argv[index + 1];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(argument("--output"));
const image = argument("--image");
const serviceAccount = argument("--service-account");
const bucket = argument("--bucket");
if (!/^[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/u
  .test(serviceAccount)
    || !/^[a-z0-9.-]+\/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$/u
      .test(image)
    || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/u.test(bucket)
    || output !== resolve(root, "service.rendered.yaml")) {
  fail("Rendered service arguments are invalid");
}
await lstat(output).then(
  () => fail("Refusing to overwrite an existing rendered service"),
  (error) => {
    if (error.code !== "ENOENT") throw error;
  },
);
const template = await readFile(
  resolve(root, "cloud-run-service.template.yaml"),
  "utf8",
);
const rendered = template
  .replaceAll("__RUNTIME_SERVICE_ACCOUNT__", serviceAccount)
  .replaceAll("__CONTAINER_IMAGE__", image)
  .replaceAll("__PRIVATE_BUCKET__", bucket);
if (rendered.includes("__")) fail("Rendered service contains a placeholder");
await writeFile(output, rendered, { flag: "wx", mode: 0o600 });
await chmod(output, 0o600);
process.stdout.write(`${JSON.stringify({
  schemaVersion: "contained-cloud-run-render-v0.1",
  status: "rendered",
  output: "service.rendered.yaml",
  collectionMode: "disabled",
})}\n`);
