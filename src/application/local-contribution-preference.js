// Accountless contribution policy is distinct from explicit consent. This
// controller stores the selection and transition receipts only; it never
// creates credentials or sends data. The composition root must establish
// installation provenance and select a policy.
export const CONTRIBUTION_PREFERENCE_SCHEMA_VERSION = "local-contribution-preference-v2";

const LEGACY_SCHEMA_VERSION = "local-contribution-preference-v1";
const MAXIMUM_BYTES = 4_096;
const DAY_MILLISECONDS = 24 * 60 * 60 * 1_000;
const DEFAULT_MINIMUM_AGE_MILLISECONDS = 7 * DAY_MILLISECONDS;
const DEFAULT_NOTICE_OFFSETS_MILLISECONDS = Object.freeze([
  0,
  3 * DAY_MILLISECONDS,
  6 * DAY_MILLISECONDS,
]);
const DEFAULT_POST_FINAL_NOTICE_MILLISECONDS = DAY_MILLISECONDS;
const VERSION = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const INSTALLATION_STATES = new Set([
  "fresh",
  "existing_unselected",
  "existing_opted_out",
  "existing",
  "unknown",
]);
const LEGACY_BASES = new Set([
  "default_on",
  "default_off",
  "user_choice",
  "legacy_preserved",
]);
const BASES = new Set([
  ...LEGACY_BASES,
  "migration_default_on",
]);
const STATES = new Set([
  "pending_notices",
  "enabled",
  "disabled",
  "legacy_preserved",
]);
const LEGACY_KEYS = [
  "basis",
  "destinationOrigin",
  "enabled",
  "policyVersion",
  "schemaVersion",
  "updatedAt",
];
const RECORD_KEYS = [
  "activatesAt",
  "basis",
  "candidateAt",
  "decisionAt",
  "destinationOrigin",
  "enabled",
  "notice1DueAt",
  "notice1PresentedAt",
  "notice2DueAt",
  "notice2PresentedAt",
  "notice3DueAt",
  "notice3PresentedAt",
  "policyVersion",
  "scheduleVersion",
  "schemaVersion",
  "state",
  "updatedAt",
];
const PRESENTED_AT_FIELDS = [
  "notice1PresentedAt",
  "notice2PresentedAt",
  "notice3PresentedAt",
];
const DUE_AT_FIELDS = [
  "notice1DueAt",
  "notice2DueAt",
  "notice3DueAt",
];
const NULLABLE_TIMESTAMP_FIELDS = [
  "activatesAt",
  "candidateAt",
  "notice1DueAt",
  "notice1PresentedAt",
  "notice2DueAt",
  "notice2PresentedAt",
  "notice3DueAt",
  "notice3PresentedAt",
  "decisionAt",
];

function failure(message = "Contribution preference unavailable") {
  const error = new Error(message);
  error.code = "contribution_preference_unavailable";
  return error;
}

function stateFailure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validOrigin(value) {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return url.origin === value && !url.username && !url.password
      && (url.protocol === "https:"
        || (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== ""));
  } catch { return false; }
}

function validTimestamp(value) {
  if (typeof value !== "string" || value.length !== 24) return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds)
    && new Date(milliseconds).toISOString() === value;
}

function timestampMilliseconds(value) {
  return value === null ? null : Date.parse(value);
}

function currentDate(now) {
  let value;
  try {
    value = now();
  } catch {
    throw failure();
  }
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw failure();
  return date;
}

function keysMatch(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === expected.join("\0");
}

function validLegacyRecord(value, referenceMilliseconds) {
  return keysMatch(value, LEGACY_KEYS)
    && value.schemaVersion === LEGACY_SCHEMA_VERSION
    && typeof value.enabled === "boolean" && LEGACY_BASES.has(value.basis)
    && !(value.basis === "default_on" && !value.enabled)
    && !(value.basis === "legacy_preserved" && value.enabled)
    && !(value.basis === "default_off" && value.enabled)
    && typeof value.policyVersion === "string" && VERSION.test(value.policyVersion)
    && validOrigin(value.destinationOrigin)
    && validTimestamp(value.updatedAt)
    && Date.parse(value.updatedAt) <= referenceMilliseconds;
}

function expectedStateForBasis(basis, enabled) {
  if (basis === "legacy_preserved") return "legacy_preserved";
  if (enabled) return "enabled";
  return basis === "default_off" || basis === "user_choice" ? "disabled" : null;
}

function validRecord(value, referenceMilliseconds, schedule) {
  if (!keysMatch(value, RECORD_KEYS)
      || value.schemaVersion !== CONTRIBUTION_PREFERENCE_SCHEMA_VERSION
      || !STATES.has(value.state)
      || !BASES.has(value.basis)
      || typeof value.enabled !== "boolean"
      || typeof value.policyVersion !== "string" || !VERSION.test(value.policyVersion)
      || !validOrigin(value.destinationOrigin)
      || typeof value.scheduleVersion !== "string" || !VERSION.test(value.scheduleVersion)
      || !validTimestamp(value.updatedAt)
      || Date.parse(value.updatedAt) > referenceMilliseconds) {
    return false;
  }
  if (NULLABLE_TIMESTAMP_FIELDS.some((field) => value[field] !== null && !validTimestamp(value[field]))) {
    return false;
  }
  if (PRESENTED_AT_FIELDS.some((field) => value[field] !== null
      && Date.parse(value[field]) > referenceMilliseconds)
      || (value.decisionAt !== null && Date.parse(value.decisionAt) > referenceMilliseconds)) {
    return false;
  }
  const updatedMilliseconds = Date.parse(value.updatedAt);
  if (PRESENTED_AT_FIELDS.some((field) => value[field] !== null
      && Date.parse(value[field]) > updatedMilliseconds)
      || (value.decisionAt !== null && Date.parse(value.decisionAt) > updatedMilliseconds)) {
    return false;
  }
  const expectedState = expectedStateForBasis(value.basis, value.enabled);
  if (value.state !== "pending_notices" && expectedState !== value.state) return false;
  if (value.state === "pending_notices"
      && (value.enabled || value.basis !== "default_off" || value.decisionAt !== null)) {
    return false;
  }
  if (value.basis === "migration_default_on" && (!value.enabled || value.state !== "enabled")) {
    return false;
  }
  if (value.basis === "user_choice"
      && ((value.decisionAt === null) !== (value.state !== "enabled" && value.state !== "disabled"))) {
    return false;
  }
  const scheduleFields = [value.candidateAt, ...DUE_AT_FIELDS.map((field) => value[field])];
  const hasSchedule = scheduleFields.some((field) => field !== null);
  if (hasSchedule && scheduleFields.some((field) => field === null)) return false;
  if (!hasSchedule && (value.activatesAt !== null || PRESENTED_AT_FIELDS.some((field) => value[field] !== null))) {
    return false;
  }
  if (value.state === "pending_notices" && !hasSchedule) return false;
  if (value.basis === "migration_default_on"
      && (!hasSchedule || PRESENTED_AT_FIELDS.some((field) => value[field] === null))) {
    return false;
  }
  if (hasSchedule) {
    const candidateMilliseconds = timestampMilliseconds(value.candidateAt);
    const dueMilliseconds = DUE_AT_FIELDS.map((field) => timestampMilliseconds(value[field]));
    if (candidateMilliseconds < dueMilliseconds[2]) return false;
    if (value.scheduleVersion === schedule.version) {
      const expectedDue = schedule.noticeOffsetsMilliseconds.map(
        (offset) => candidateMilliseconds - schedule.minimumAgeMilliseconds + offset,
      );
      if (dueMilliseconds.some((due, index) => due !== expectedDue[index])) return false;
    } else {
      // A changed schedule cannot reinterpret a pending record. Keep the
      // fixed receipt readable for audit, but scheduleCurrent below prevents
      // reminders or automatic activation under the new configuration.
      if (dueMilliseconds[0] > dueMilliseconds[1] || dueMilliseconds[1] > dueMilliseconds[2]) return false;
    }
    const presentedMilliseconds = PRESENTED_AT_FIELDS.map(
      (field) => timestampMilliseconds(value[field]),
    );
    if (presentedMilliseconds.some((presented, index) => presented !== null
        && presented < dueMilliseconds[index])) return false;
    if ((presentedMilliseconds[1] !== null && presentedMilliseconds[0] === null)
        || (presentedMilliseconds[2] !== null && presentedMilliseconds[1] === null)) {
      return false;
    }
    if (presentedMilliseconds[1] !== null
        && presentedMilliseconds[1] - presentedMilliseconds[0] < schedule.minimumNoticeSpacingMilliseconds) {
      return false;
    }
    if (presentedMilliseconds[2] !== null
        && presentedMilliseconds[2] - presentedMilliseconds[1] < schedule.minimumNoticeSpacingMilliseconds) {
      return false;
    }
    if (value.scheduleVersion === schedule.version) {
      const expectedActivation = presentedMilliseconds[2] === null
        ? null
        : new Date(Math.max(
          candidateMilliseconds,
          presentedMilliseconds[2] + schedule.postFinalNoticeMilliseconds,
        )).toISOString();
      if (value.activatesAt !== expectedActivation) return false;
    } else {
      const minimumActivation = presentedMilliseconds[2] === null
        ? null
        : Math.max(candidateMilliseconds, presentedMilliseconds[2] + DAY_MILLISECONDS);
      if ((minimumActivation === null) !== (value.activatesAt === null)
          || (minimumActivation !== null && Date.parse(value.activatesAt) < minimumActivation)) return false;
    }
  } else if (value.activatesAt !== null) {
    return false;
  }
  if (value.decisionAt !== null
      && value.state !== "enabled" && value.state !== "disabled") return false;
  if (value.basis === "default_on" && value.state !== "enabled") return false;
  if (value.basis === "default_off" && value.state !== "disabled" && value.state !== "pending_notices") {
    return false;
  }
  if (value.basis === "legacy_preserved" && value.state !== "legacy_preserved") return false;
  if (value.basis === "migration_default_on"
      && (value.activatesAt === null
        || Date.parse(value.activatesAt) > referenceMilliseconds
        || Date.parse(value.activatesAt) > updatedMilliseconds)) {
    return false;
  }
  return true;
}

function normalizeSchedule(schedule = {}) {
  if (schedule === null || typeof schedule !== "object" || Array.isArray(schedule)) {
    throw new TypeError("Invalid contribution notice schedule");
  }
  const version = schedule.version ?? "accountless-default-on-v1";
  const minimumAgeMilliseconds = schedule.minimumAgeMilliseconds
    ?? DEFAULT_MINIMUM_AGE_MILLISECONDS;
  const noticeOffsetsMilliseconds = schedule.noticeOffsetsMilliseconds
    ?? DEFAULT_NOTICE_OFFSETS_MILLISECONDS;
  const minimumNoticeSpacingMilliseconds = schedule.minimumNoticeSpacingMilliseconds
    ?? DAY_MILLISECONDS;
  const postFinalNoticeMilliseconds = schedule.postFinalNoticeMilliseconds
    ?? DEFAULT_POST_FINAL_NOTICE_MILLISECONDS;
  if (typeof version !== "string" || !VERSION.test(version)
      || !Number.isSafeInteger(minimumAgeMilliseconds)
      || minimumAgeMilliseconds < DEFAULT_MINIMUM_AGE_MILLISECONDS
      || !Array.isArray(noticeOffsetsMilliseconds)
      || noticeOffsetsMilliseconds.length !== 3
      || noticeOffsetsMilliseconds.some((offset) => !Number.isSafeInteger(offset) || offset < 0)
      || noticeOffsetsMilliseconds[0] !== 0
      || noticeOffsetsMilliseconds[1] < 3 * DAY_MILLISECONDS
      || noticeOffsetsMilliseconds[2] < 6 * DAY_MILLISECONDS
      || noticeOffsetsMilliseconds[1] < noticeOffsetsMilliseconds[0]
      || noticeOffsetsMilliseconds[2] < noticeOffsetsMilliseconds[1]
      || noticeOffsetsMilliseconds[2] > minimumAgeMilliseconds
      || !Number.isSafeInteger(minimumNoticeSpacingMilliseconds)
      || minimumNoticeSpacingMilliseconds < DAY_MILLISECONDS
      || !Number.isSafeInteger(postFinalNoticeMilliseconds)
      || postFinalNoticeMilliseconds < DAY_MILLISECONDS) {
    throw new TypeError("Invalid contribution notice schedule");
  }
  return Object.freeze({
    version,
    minimumAgeMilliseconds,
    noticeOffsetsMilliseconds: Object.freeze([...noticeOffsetsMilliseconds]),
    minimumNoticeSpacingMilliseconds,
    postFinalNoticeMilliseconds,
  });
}

function emptySchedule() {
  return {
    candidateAt: null,
    notice1DueAt: null,
    notice1PresentedAt: null,
    notice2DueAt: null,
    notice2PresentedAt: null,
    notice3DueAt: null,
    notice3PresentedAt: null,
    activatesAt: null,
  };
}

function makeRecord({
  state,
  basis,
  enabled,
  policyVersion,
  destinationOrigin,
  scheduleVersion,
  updatedAt,
  decisionAt = null,
  schedule = emptySchedule(),
}) {
  return {
    activatesAt: schedule.activatesAt,
    basis,
    candidateAt: schedule.candidateAt,
    decisionAt,
    destinationOrigin,
    enabled,
    notice1DueAt: schedule.notice1DueAt,
    notice1PresentedAt: schedule.notice1PresentedAt,
    notice2DueAt: schedule.notice2DueAt,
    notice2PresentedAt: schedule.notice2PresentedAt,
    notice3DueAt: schedule.notice3DueAt,
    notice3PresentedAt: schedule.notice3PresentedAt,
    policyVersion,
    scheduleVersion,
    schemaVersion: CONTRIBUTION_PREFERENCE_SCHEMA_VERSION,
    state,
    updatedAt,
  };
}

function pendingSchedule(startMilliseconds, schedule) {
  const candidateMilliseconds = startMilliseconds + schedule.minimumAgeMilliseconds;
  const dueMilliseconds = schedule.noticeOffsetsMilliseconds.map(
    (offset) => startMilliseconds + offset,
  );
  return {
    candidateAt: new Date(candidateMilliseconds).toISOString(),
    notice1DueAt: new Date(dueMilliseconds[0]).toISOString(),
    notice1PresentedAt: null,
    notice2DueAt: new Date(dueMilliseconds[1]).toISOString(),
    notice2PresentedAt: null,
    notice3DueAt: new Date(dueMilliseconds[2]).toISOString(),
    notice3PresentedAt: null,
    activatesAt: null,
  };
}

function migrateLegacyRecord(value, date, schedule) {
  const state = expectedStateForBasis(value.basis, value.enabled);
  return makeRecord({
    state: state ?? "legacy_preserved",
    basis: value.basis,
    enabled: value.enabled,
    policyVersion: value.policyVersion,
    destinationOrigin: value.destinationOrigin,
    scheduleVersion: schedule.version,
    updatedAt: date.toISOString(),
    decisionAt: value.basis === "user_choice" ? value.updatedAt : null,
  });
}

function noticeCount(record) {
  let count = 0;
  for (const field of PRESENTED_AT_FIELDS) {
    if (record[field] !== null) count += 1;
  }
  return count;
}

export function createLocalContributionPreference({
  settingsFile,
  policyVersion,
  destinationOrigin,
  installationState = "unknown",
  defaultEnabled = false,
  now = () => new Date(),
  noticeSchedule,
}, { storage } = {}) {
  if (typeof settingsFile !== "string" || settingsFile.length === 0
      || typeof policyVersion !== "string" || !VERSION.test(policyVersion)
      || !validOrigin(destinationOrigin)
      || !INSTALLATION_STATES.has(installationState)
      || typeof defaultEnabled !== "boolean" || typeof now !== "function"
      || typeof storage?.readSettingsText !== "function"
      || typeof storage?.writeSettingsText !== "function") {
    throw new TypeError("Invalid contribution preference configuration");
  }
  const configuredSchedule = normalizeSchedule(noticeSchedule);
  let record = null;
  let initialized = false;
  let available = true;
  let operations = Promise.resolve();
  const serialize = (operation) => {
    const pending = operations.then(operation, operation);
    operations = pending.catch(() => {});
    return pending;
  };
  const poison = () => {
    available = false;
    throw failure();
  };
  const trustedDate = () => {
    const date = currentDate(now);
    if (record !== null && date.getTime() < Date.parse(record.updatedAt)) poison();
    return date;
  };
  const project = () => {
    let date = null;
    try { date = currentDate(now); } catch { available = false; }
    if (date !== null && record !== null && date.getTime() < Date.parse(record.updatedAt)) {
      available = false;
    }
    const current = available && record !== null
      && record.policyVersion === policyVersion
      && record.destinationOrigin === destinationOrigin;
    const scheduleCurrent = current && record?.scheduleVersion === configuredSchedule.version;
    const count = record === null ? 0 : noticeCount(record);
    const pending = current && scheduleCurrent && record?.state === "pending_notices";
    const nextNoticeIndex = pending && count < 3 ? count + 1 : null;
    const nextNoticeAt = nextNoticeIndex === null
      ? null
      : record[DUE_AT_FIELDS[nextNoticeIndex - 1]];
    const spacingReady = nextNoticeIndex === null || count === 0
      || date === null || Date.parse(record[PRESENTED_AT_FIELDS[count - 1]])
        + configuredSchedule.minimumNoticeSpacingMilliseconds <= date.getTime();
    const noticeDue = pending && nextNoticeIndex !== null && date !== null
      && Date.parse(nextNoticeAt) <= date.getTime() && spacingReady;
    return Object.freeze({
      schemaVersion: CONTRIBUTION_PREFERENCE_SCHEMA_VERSION,
      available,
      current,
      scheduleCurrent,
      enabled: current && record?.enabled === true,
      basis: record?.basis ?? null,
      policyVersion: record?.policyVersion ?? null,
      destinationOrigin: record?.destinationOrigin ?? null,
      updatedAt: record?.updatedAt ?? null,
      state: record?.state ?? null,
      noticeCount: count,
      nextNoticeIndex,
      noticeDue,
      nextNoticeAt,
      activatesAt: pending && count === 3 ? record.activatesAt : null,
      earliestActivationAt: pending
        ? (count === 3 ? record.activatesAt : record.candidateAt)
        : null,
    });
  };
  const persist = async (next) => {
    try {
      const text = `${JSON.stringify(next)}\n`;
      if (text.length > MAXIMUM_BYTES) throw failure();
      await storage.writeSettingsText({ settingsFile, text, maximumBytes: MAXIMUM_BYTES });
      record = next;
    } catch {
      available = false;
      throw failure();
    }
  };
  const makeFreshRecord = (date, initialSelection) => {
    if (initialSelection !== null) {
      return makeRecord({
        state: initialSelection ? "enabled" : "disabled",
        basis: "user_choice",
        enabled: initialSelection,
        policyVersion,
        destinationOrigin,
        scheduleVersion: configuredSchedule.version,
        updatedAt: date.toISOString(),
        decisionAt: date.toISOString(),
      });
    }
    if (installationState === "fresh") {
      // Fresh Electron installations pass defaultEnabled=true from the
      // composition root. Other callers may deliberately retain the old
      // default-off behavior without entering the existing-install notices.
      return makeRecord({
        state: defaultEnabled ? "enabled" : "disabled",
        basis: defaultEnabled ? "default_on" : "default_off",
        enabled: defaultEnabled,
        policyVersion,
        destinationOrigin,
        scheduleVersion: configuredSchedule.version,
        updatedAt: date.toISOString(),
      });
    }
    if (installationState === "existing_unselected") {
      return makeRecord({
        state: "pending_notices",
        basis: "default_off",
        enabled: false,
        policyVersion,
        destinationOrigin,
        scheduleVersion: configuredSchedule.version,
        updatedAt: date.toISOString(),
        schedule: pendingSchedule(date.getTime(), configuredSchedule),
      });
    }
    return makeRecord({
      state: "legacy_preserved",
      basis: "legacy_preserved",
      enabled: false,
      policyVersion,
      destinationOrigin,
      scheduleVersion: configuredSchedule.version,
      updatedAt: date.toISOString(),
    });
  };
  const initialize = (initialSelection = null) => serialize(async () => {
    if (initialized) return project();
    initialized = true;
    try {
      if (initialSelection !== null && typeof initialSelection !== "boolean") throw failure();
      const date = currentDate(now);
      const text = await storage.readSettingsText({ settingsFile, maximumBytes: MAXIMUM_BYTES });
      if (text === null) {
        await persist(makeFreshRecord(date, initialSelection));
      } else {
        if (typeof text !== "string" || text.length > MAXIMUM_BYTES) throw failure();
        const parsed = JSON.parse(text);
        if (validRecord(parsed, date.getTime(), configuredSchedule)) {
          record = parsed;
        } else if (validLegacyRecord(parsed, date.getTime())) {
          await persist(migrateLegacyRecord(parsed, date, configuredSchedule));
        } else {
          throw failure();
        }
      }
    } catch { available = false; }
    return project();
  });
  const chooseEnabled = async (enabled) => {
    await initialize(enabled);
    return serialize(async () => {
      if (!available || record === null) throw failure();
      const current = record.policyVersion === policyVersion
        && record.destinationOrigin === destinationOrigin;
      if (current && record.basis === "user_choice" && record.enabled === enabled) return project();
      const date = trustedDate();
      const next = makeRecord({
        state: enabled ? "enabled" : "disabled",
        basis: "user_choice",
        enabled,
        policyVersion,
        destinationOrigin,
        scheduleVersion: record.scheduleVersion,
        updatedAt: date.toISOString(),
        decisionAt: date.toISOString(),
        schedule: {
          candidateAt: record.candidateAt,
          notice1DueAt: record.notice1DueAt,
          notice1PresentedAt: record.notice1PresentedAt,
          notice2DueAt: record.notice2DueAt,
          notice2PresentedAt: record.notice2PresentedAt,
          notice3DueAt: record.notice3DueAt,
          notice3PresentedAt: record.notice3PresentedAt,
          activatesAt: record.activatesAt,
        },
      });
      await persist(next);
      return project();
    });
  };
  const markNoticePresented = async (index) => {
    if (!Number.isInteger(index) || index < 1 || index > 3) {
      throw new TypeError("notice index must be 1, 2, or 3");
    }
    await initialize();
    return serialize(async () => {
      if (!available || record === null) throw failure();
      if (record.state !== "pending_notices") return project();
      const current = record.policyVersion === policyVersion
        && record.destinationOrigin === destinationOrigin
        && record.scheduleVersion === configuredSchedule.version;
      if (!current) return project();
      const count = noticeCount(record);
      if (index <= count) return project();
      if (index !== count + 1) {
        throw stateFailure("contribution_preference_notice_out_of_order", "Notice must be presented in order");
      }
      const date = trustedDate();
      const dueAt = Date.parse(record[DUE_AT_FIELDS[index - 1]]);
      if (date.getTime() < dueAt) {
        throw stateFailure("contribution_preference_notice_not_due", "Notice is not due yet");
      }
      if (count > 0
          && date.getTime() < Date.parse(record[PRESENTED_AT_FIELDS[count - 1]])
            + configuredSchedule.minimumNoticeSpacingMilliseconds) {
        throw stateFailure("contribution_preference_notice_not_due", "Notice spacing has not elapsed");
      }
      const presentedAt = date.toISOString();
      const next = { ...record,
        [`${PRESENTED_AT_FIELDS[index - 1]}`]: presentedAt,
        updatedAt: presentedAt,
      };
      if (index === 3) {
        next.activatesAt = new Date(Math.max(
          Date.parse(record.candidateAt),
          date.getTime() + configuredSchedule.postFinalNoticeMilliseconds,
        )).toISOString();
      }
      await persist(next);
      return project();
    });
  };
  const evaluateAutomatic = async () => {
    await initialize();
    return serialize(async () => {
      if (!available || record === null) throw failure();
      if (record.state !== "pending_notices"
          || record.policyVersion !== policyVersion
          || record.destinationOrigin !== destinationOrigin
          || record.scheduleVersion !== configuredSchedule.version
          || noticeCount(record) !== 3) return project();
      const date = trustedDate();
      if (record.activatesAt === null || date.getTime() < Date.parse(record.activatesAt)) return project();
      const next = { ...record,
        basis: "migration_default_on",
        enabled: true,
        state: "enabled",
        updatedAt: date.toISOString(),
      };
      await persist(next);
      return project();
    });
  };
  return Object.freeze({
    initialize: () => initialize(),
    inspect: async () => { await initialize(); return serialize(async () => project()); },
    // Only a user action may call this method. The durable choice is written
    // before the composition root reports success or starts sharing.
    setEnabled: async (enabled) => {
      if (typeof enabled !== "boolean") throw new TypeError("enabled must be a boolean");
      return chooseEnabled(enabled);
    },
    markNoticePresented,
    evaluateAutomatic,
  });
}
