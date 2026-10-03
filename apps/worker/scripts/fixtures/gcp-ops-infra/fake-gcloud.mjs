/**
 * A synthetic, in-memory stand-in for gcloud, for the OPS-2 checks only.
 *
 * It holds a mutable world of Admin API-shaped resources, answers the read
 * shapes readback issues with JSON, and applies the mutating shapes apply
 * issues to that world, so a check can show readback -> plan -> apply -> plan
 * converging. Every call is recorded. It never spawns a process, touches the
 * network or reads a real file: `run ... replace` reads the spec from the
 * in-memory writer the check passes in. Nothing here is product code.
 */

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function flag(argv, name) {
  const entry = argv.find((arg) => arg.startsWith(`${name}=`));
  return entry === undefined ? undefined : entry.slice(name.length + 1);
}

function has(argv, name) {
  return argv.includes(name);
}

function positional(argv) {
  const values = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) break;
    values.push(arg);
  }
  return values;
}

/** A born bucket in Admin API (JSON API) shape, with the proof posture. */
export function bornBucket({ name, location, generation = "1700000000000001", metageneration = "1", extra = {} }) {
  return {
    kind: "storage#bucket",
    name,
    location,
    projectNumber: "100000000001",
    storageClass: "STANDARD",
    generation,
    metageneration,
    iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "enforced" },
    versioning: { enabled: false },
    ...extra,
  };
}

/**
 * BUILD-SOURCE: a project's default Cloud Build bucket as a first `gcloud
 * builds submit` leaves it (US multi-region, Cloud Storage's project
 * convenience bindings on its policy and nothing else), plus any `extraBindings`.
 */
export function withCloudBuildBucket(world, { project, projectNumber = "100000000001", extraBindings = [] }) {
  const name = `${project}_cloudbuild`;
  world.buckets.push({
    kind: "storage#bucket",
    name,
    location: "US",
    projectNumber,
    storageClass: "STANDARD",
    generation: "1700000000000090",
    metageneration: "1",
    iamConfiguration: { uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: "inherited" },
  });
  world.bucketPolicies[name] = { bindings: [
    { role: "roles/storage.legacyBucketOwner", members: [`projectEditor:${project}`, `projectOwner:${project}`] },
    { role: "roles/storage.legacyBucketReader", members: [`projectViewer:${project}`] },
    ...extraBindings,
  ] };
  return world;
}

/** An empty project: only Google's default logging resources exist. */
export function emptyWorld() {
  return {
    serviceAccounts: [],
    serviceAccountPolicies: {},
    roles: [],
    projectPolicy: { bindings: [], etag: "BwSynthetic=" },
    repositories: [],
    repositoryPolicies: {},
    secrets: [],
    secretVersions: {},
    secretPolicies: {},
    sqlInstances: [],
    sqlDatabases: {},
    sqlUsers: {},
    buckets: [],
    bucketPolicies: {},
    sink: { name: "_Default", destination: "logging.googleapis.com/projects/synthetic/locations/global/buckets/_Default" },
    logBucket: { name: "_Default", retentionDays: 30 },
    services: [],
    servicePolicies: {},
    jobs: [],
    jobPolicies: {},
    schedulerJobs: [],
  };
}

/** Owner-supplied secret containers with an ENABLED version 1 each. */
export function withSecretValues(world, { project, region, names }) {
  for (const name of names) {
    world.secrets.push({
      name: `projects/100000000001/secrets/${name}`,
      replication: { userManaged: { replicas: [{ location: region }] } },
    });
    world.secretVersions[name] = [{ name: `projects/100000000001/secrets/${name}/versions/1`, state: "ENABLED" }];
    world.secretPolicies[name] = { bindings: [] };
  }
  void project;
  return world;
}

function addBinding(policy, { role, member, condition }) {
  policy.bindings ??= [];
  const existing = policy.bindings.find((binding) => binding.role === role
    && JSON.stringify(binding.condition ?? null) === JSON.stringify(condition ?? null));
  if (existing !== undefined) {
    if (!existing.members.includes(member)) existing.members.push(member);
    return;
  }
  policy.bindings.push({ role, members: [member], ...(condition === null ? {} : { condition }) });
}

function parseCondition(value) {
  if (value === undefined || value === "None") return null;
  const expression = /expression=(.*),title=/u.exec(value)?.[1];
  const title = /,title=([^,]*)$/u.exec(value)?.[1];
  return { expression, title };
}

function parseDict(value) {
  const result = {};
  for (const part of value.split(",")) {
    const separator = part.indexOf("=");
    result[part.slice(0, separator)] = part.slice(separator + 1);
  }
  return result;
}

function applySqlFlags(instance, argv) {
  const settings = instance.settings;
  const backup = settings.backupConfiguration ??= { kind: "sql#backupConfiguration", enabled: false };
  if (flag(argv, "--tier")) settings.tier = flag(argv, "--tier");
  if (flag(argv, "--availability-type")) settings.availabilityType = flag(argv, "--availability-type");
  if (flag(argv, "--storage-size")) settings.dataDiskSizeGb = String(Number.parseInt(flag(argv, "--storage-size"), 10));
  if (has(argv, "--storage-auto-increase")) settings.storageAutoResize = true;
  if (has(argv, "--deletion-protection")) settings.deletionProtectionEnabled = true;
  if (has(argv, "--assign-ip")) settings.ipConfiguration = { ...settings.ipConfiguration, ipv4Enabled: true };
  if (flag(argv, "--connector-enforcement")) settings.connectorEnforcement = flag(argv, "--connector-enforcement");
  if (has(argv, "--no-insights-config-query-insights-enabled")) settings.insightsConfig = { queryInsightsEnabled: false };
  if (flag(argv, "--database-flags")) {
    settings.databaseFlags = Object.entries(parseDict(flag(argv, "--database-flags")))
      .map(([name, value]) => ({ name, value }));
  }
  if (flag(argv, "--backup-start-time")) {
    backup.enabled = true;
    backup.startTime = flag(argv, "--backup-start-time");
  }
  if (flag(argv, "--retained-backups-count")) {
    backup.backupRetentionSettings = { retentionUnit: "COUNT", retainedBackups: Number(flag(argv, "--retained-backups-count")) };
  }
  if (flag(argv, "--retained-transaction-log-days")) {
    backup.transactionLogRetentionDays = Number(flag(argv, "--retained-transaction-log-days"));
  }
  if (has(argv, "--enable-point-in-time-recovery")) backup.pointInTimeRecoveryEnabled = true;
  if (flag(argv, "--backup-location")) backup.location = flag(argv, "--backup-location");
  if (has(argv, "--final-backup")) settings.finalBackupConfig = { enabled: true, retentionDays: 0 };
  if (flag(argv, "--final-backup-retention-days")) {
    settings.finalBackupConfig = { enabled: true, retentionDays: Number(flag(argv, "--final-backup-retention-days")) };
  }
  if (has(argv, "--no-retain-backups-on-delete")) settings.retainBackupsOnDelete = false;
}

/**
 * Returns { runner, calls, world }. `files` maps a written spec path to its
 * text (the in-memory writer the check gives apply). `failWhen(argv)` makes a
 * call exit non-zero with a marker on stderr. `clock()` stamps a trigger's
 * userUpdateTime on create, update and pause, as Cloud Scheduler does.
 * `projectNumber` is the number a bucket created here carries (BUILD-SOURCE).
 */
export function createFakeGcloud(world, { files = new Map(), failWhen = () => false, project, region,
  projectNumber = "100000000001", clock = () => "2026-10-02T00:00:00Z" } = {}) {
  const calls = [];
  const json = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: "" });
  const done = () => ({ status: 0, stdout: "", stderr: "Updated." });
  const runner = (argv) => {
    calls.push([...argv]);
    if (failWhen(argv)) return { status: 1, stdout: "", stderr: "ERROR: MARKER-5e1f synthetic gcloud failure" };
    const words = positional(argv);
    const path = words.slice(0, 3).join(" ");
    const name = (index) => words[index];
    switch (true) {
      case path === "iam service-accounts list": return json(world.serviceAccounts);
      case path === "iam service-accounts create":
        world.serviceAccounts.push({ email: `${name(3)}@${project}.iam.gserviceaccount.com`, disabled: false });
        return done();
      case path === "iam service-accounts get-iam-policy":
        if (!world.serviceAccounts.some((account) => account.email === name(3))) {
          return { status: 1, stdout: "", stderr: "synthetic: no such account" };
        }
        return json(world.serviceAccountPolicies[name(3)] ?? { etag: "ACAB" });
      case path === "iam service-accounts add-iam-policy-binding":
        world.serviceAccountPolicies[name(3)] ??= {};
        addBinding(world.serviceAccountPolicies[name(3)], { role: flag(argv, "--role"), member: flag(argv, "--member"),
          condition: null });
        return done();
      case path === "iam roles list": return json(world.roles.map((role) => ({ name: role.name, deleted: role.deleted })));
      case path === "iam roles describe": return json(world.roles.find((role) => role.name.endsWith(`/${name(3)}`)));
      case path === "iam roles create":
        world.roles.push({ name: `projects/${project}/roles/${name(3)}`, stage: "GA",
          includedPermissions: flag(argv, "--permissions").split(","), title: flag(argv, "--title") });
        return done();
      case path === "iam roles update": {
        const role = world.roles.find((entry) => entry.name.endsWith(`/${name(3)}`));
        if (flag(argv, "--add-permissions")) role.includedPermissions.push(...flag(argv, "--add-permissions").split(","));
        if (flag(argv, "--stage")) role.stage = flag(argv, "--stage");
        return done();
      }
      case words.slice(0, 2).join(" ") === "projects get-iam-policy": return json(world.projectPolicy);
      case words.slice(0, 2).join(" ") === "projects add-iam-policy-binding":
        addBinding(world.projectPolicy, { role: flag(argv, "--role"), member: flag(argv, "--member"),
          condition: parseCondition(flag(argv, "--condition")) });
        return done();
      case path === "artifacts repositories list": return json(world.repositories);
      case path === "artifacts repositories get-iam-policy": return json(world.repositoryPolicies[name(3)] ?? {});
      case path === "artifacts repositories create":
        world.repositories.push({ name: `projects/${project}/locations/${region}/repositories/${name(3)}`,
          format: "DOCKER", dockerConfig: { immutableTags: has(argv, "--immutable-tags") } });
        world.repositoryPolicies[name(3)] = {};
        return done();
      case path === "artifacts repositories update":
        world.repositories.find((repository) => repository.name.endsWith(`/${name(3)}`)).dockerConfig.immutableTags = true;
        return done();
      case path === "artifacts repositories add-iam-policy-binding":
        world.repositoryPolicies[name(3)] ??= {};
        addBinding(world.repositoryPolicies[name(3)], { role: flag(argv, "--role"), member: flag(argv, "--member"), condition: null });
        return done();
      case path === "secrets list": return json(world.secrets);
      case path === "secrets versions list": return json(world.secretVersions[words[3]] ?? []);
      case path.startsWith("secrets get-iam-policy"): return json(world.secretPolicies[name(2)] ?? {});
      case path.startsWith("secrets create"):
        world.secrets.push({ name: `projects/100000000001/secrets/${name(2)}`,
          replication: { userManaged: { replicas: flag(argv, "--locations").split(",").map((location) => ({ location })) } } });
        world.secretPolicies[name(2)] = {};
        return done();
      case path.startsWith("secrets add-iam-policy-binding"):
        world.secretPolicies[name(2)] ??= {};
        addBinding(world.secretPolicies[name(2)], { role: flag(argv, "--role"), member: flag(argv, "--member"), condition: null });
        return done();
      case path === "sql instances list": return json(world.sqlInstances);
      case path === "sql databases list": return json(world.sqlDatabases[flag(argv, "--instance")] ?? []);
      case path === "sql users list": return json(world.sqlUsers[flag(argv, "--instance")] ?? []);
      case path === "sql instances create": {
        const instance = {
          kind: "sql#instance",
          name: name(3),
          region: flag(argv, "--region"),
          databaseVersion: flag(argv, "--database-version"),
          instanceType: "CLOUD_SQL_INSTANCE",
          settings: {
            edition: flag(argv, "--edition"),
            dataDiskType: flag(argv, "--storage-type") === "SSD" ? "PD_SSD" : "PD_HDD",
            ipConfiguration: { ipv4Enabled: false, authorizedNetworks: [] },
            connectorEnforcement: "NOT_REQUIRED",
          },
        };
        applySqlFlags(instance, argv);
        world.sqlInstances.push(instance);
        world.sqlDatabases[name(3)] = [{ name: "postgres" }];
        world.sqlUsers[name(3)] = [{ name: "postgres", type: "BUILT_IN" }];
        return done();
      }
      case path === "sql instances patch":
        applySqlFlags(world.sqlInstances.find((instance) => instance.name === name(3)), argv);
        return done();
      case path === "sql databases create":
        world.sqlDatabases[flag(argv, "--instance")].push({ name: name(3) });
        return done();
      case path === "sql users create":
        world.sqlUsers[flag(argv, "--instance")].push({ name: name(3).replace(/\.gserviceaccount\.com$/u, ""),
          type: "CLOUD_IAM_SERVICE_ACCOUNT" });
        return done();
      case path === "storage buckets list": return json(world.buckets);
      case path === "storage buckets get-iam-policy": return json(world.bucketPolicies[name(3).slice(5)] ?? { bindings: [] });
      case path === "storage buckets create": {
        // The JSON API bucket `gcloud storage buckets create` makes from these
        // flags, with Cloud Storage's project convenience bindings on its policy.
        const bucketName = name(3).slice("gs://".length);
        if (world.buckets.some((bucket) => bucket.name === bucketName)) {
          return { status: 1, stdout: "", stderr: "synthetic: HTTPError 409: bucket exists" };
        }
        world.buckets.push({
          kind: "storage#bucket",
          name: bucketName,
          location: (flag(argv, "--location") ?? "us").toUpperCase(),
          projectNumber,
          storageClass: "STANDARD",
          generation: "1700000000000100",
          metageneration: "1",
          iamConfiguration: {
            uniformBucketLevelAccess: { enabled: has(argv, "--uniform-bucket-level-access") },
            publicAccessPrevention: has(argv, "--public-access-prevention") ? "enforced" : "inherited",
          },
        });
        world.bucketPolicies[bucketName] = { bindings: [
          { role: "roles/storage.legacyBucketOwner", members: [`projectEditor:${project}`, `projectOwner:${project}`] },
          { role: "roles/storage.legacyBucketReader", members: [`projectViewer:${project}`] },
        ] };
        return done();
      }
      case path === "storage buckets add-iam-policy-binding": {
        const bucketName = name(3).slice("gs://".length);
        world.bucketPolicies[bucketName] ??= { bindings: [] };
        addBinding(world.bucketPolicies[bucketName], { role: flag(argv, "--role"), member: flag(argv, "--member"),
          condition: null });
        return done();
      }
      case path === "logging sinks describe": return json(world.sink);
      case path === "logging sinks update": {
        if (flag(argv, "--add-exclusion")) {
          world.sink.exclusions = [...(world.sink.exclusions ?? []), parseDict(flag(argv, "--add-exclusion"))];
        }
        if (flag(argv, "--update-exclusion")) {
          const update = parseDict(flag(argv, "--update-exclusion"));
          world.sink.exclusions = world.sink.exclusions.map((entry) => (entry.name === update.name
            ? { name: update.name, filter: update.filter, disabled: update.disabled === "true" } : entry));
        }
        return done();
      }
      case path === "logging buckets describe": return json(world.logBucket);
      case path === "logging buckets update":
        world.logBucket.retentionDays = Number(flag(argv, "--retention-days"));
        return done();
      case path === "run services list": return json(world.services);
      case path === "run services get-iam-policy": return json(world.servicePolicies[name(3)] ?? {});
      case path === "run services replace": {
        const spec = JSON.parse(files.get(name(3)));
        world.services = world.services.filter((service) => service.metadata.name !== spec.metadata.name);
        world.services.push({ ...spec, status: { url: "https://synthetic.invalid" } });
        world.servicePolicies[spec.metadata.name] ??= {};
        return done();
      }
      case path === "run services add-iam-policy-binding":
        world.servicePolicies[name(3)] ??= {};
        addBinding(world.servicePolicies[name(3)], { role: flag(argv, "--role"), member: flag(argv, "--member"), condition: null });
        return done();
      case path === "run jobs list": return json(world.jobs);
      case path === "run jobs get-iam-policy": return json(world.jobPolicies[name(3)] ?? {});
      case path === "run jobs replace": {
        const spec = JSON.parse(files.get(name(3)));
        world.jobs = world.jobs.filter((job) => job.metadata.name !== spec.metadata.name);
        world.jobs.push(spec);
        world.jobPolicies[spec.metadata.name] ??= {};
        return done();
      }
      case path === "run jobs add-iam-policy-binding":
        world.jobPolicies[name(3)] ??= {};
        addBinding(world.jobPolicies[name(3)], { role: flag(argv, "--role"), member: flag(argv, "--member"), condition: null });
        return done();
      case path === "scheduler jobs list": return json(world.schedulerJobs);
      case words.slice(0, 4).join(" ") === "scheduler jobs create http":
      case words.slice(0, 4).join(" ") === "scheduler jobs update http": {
        const jobName = `projects/${project}/locations/${region}/jobs/${words[4]}`;
        const previous = world.schedulerJobs.find((job) => job.name === jobName);
        world.schedulerJobs = world.schedulerJobs.filter((job) => job.name !== jobName);
        world.schedulerJobs.push({
          name: jobName,
          schedule: flag(argv, "--schedule"),
          timeZone: flag(argv, "--time-zone"),
          httpTarget: {
            uri: flag(argv, "--uri"),
            httpMethod: flag(argv, "--http-method"),
            oauthToken: { serviceAccountEmail: flag(argv, "--oauth-service-account-email"),
              scope: flag(argv, "--oauth-token-scope") },
          },
          retryConfig: {},
          state: previous?.state ?? "ENABLED",
          userUpdateTime: clock(),
          ...(previous?.lastAttemptTime === undefined ? {} : { lastAttemptTime: previous.lastAttemptTime }),
        });
        return done();
      }
      case path === "scheduler jobs pause": {
        // Cloud Scheduler pauses only an ENABLED job (FAILED_PRECONDITION otherwise).
        const job = world.schedulerJobs.find((entry) => entry.name.endsWith(`/${name(3)}`));
        if (job?.state !== "ENABLED") return { status: 1, stdout: "", stderr: "synthetic: not enabled" };
        job.state = "PAUSED";
        job.userUpdateTime = clock();
        return done();
      }
      case path === "scheduler jobs resume": {
        // Cloud Scheduler resumes only a PAUSED job (FAILED_PRECONDITION otherwise).
        const job = world.schedulerJobs.find((entry) => entry.name.endsWith(`/${name(3)}`));
        if (job?.state !== "PAUSED") return { status: 1, stdout: "", stderr: "synthetic: not paused" };
        job.state = "ENABLED";
        job.userUpdateTime = clock();
        return done();
      }
      default:
        return { status: 2, stdout: "", stderr: "synthetic: unexpected command" };
    }
  };
  return { runner, calls, world };
}

/** An in-memory spec writer for apply: paths are synthetic, contents kept in `files`. */
export function memoryWriter(files = new Map()) {
  let closed = 0;
  return {
    files,
    get closed() { return closed; },
    create() {
      return {
        write(name, content) {
          const path = `/synthetic-spec/${name}`;
          files.set(path, content);
          return path;
        },
        close() { closed += 1; },
      };
    },
  };
}

export { clone };
