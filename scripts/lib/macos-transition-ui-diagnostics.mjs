import { spawnSync } from "node:child_process";

const SCHEMA = "tibotattle-macos-transition-ui-diagnostics-v1";
const AX_STATUSES = ["ok", "failure", "illegal_argument", "invalid_element", "cannot_complete",
  "unsupported", "not_implemented", "api_disabled", "no_value", "other"];
const LIMIT = 512;

function assertPID(pid) {
  if (!Number.isSafeInteger(pid) || pid < 2 || pid > 2_147_483_647) {
    throw new TypeError("Mac transition diagnostic PID is invalid");
  }
}

// Executed by the existing /usr/bin/osascript identity, not a new helper binary.
// Apple APIs: AXUIElementGetAttributeValueCount, AXUIElementCopyAttributeValue,
// AXUIElementSetMessagingTimeout, NSRunningApplication, CGWindowListCopyWindowInfo.
// The timeout applies only to this newly-created AX object. No UI attribute,
// permission, preference, application state, activation or action is changed.
function inspectOwnedApplication(pid) {
  ObjC.import("AppKit");
  ObjC.import("ApplicationServices");
  const cap = 512;
  function axStatus(code) {
    const known = {0:"ok", "-25200":"failure", "-25201":"illegal_argument",
      "-25202":"invalid_element", "-25204":"cannot_complete", "-25205":"unsupported",
      "-25208":"not_implemented", "-25211":"api_disabled", "-25212":"no_value"};
    return known[String(code)] || "other";
  }
  const result = {
    schemaVersion:"tibotattle-macos-transition-ui-diagnostics-v1", status:"observed",
    accessibilityTrusted:Boolean($.AXIsProcessTrusted()),
    application:{found:false, hidden:null, active:null, terminated:null, activationPolicy:null},
    ax:{timeoutStatus:null, windows:{status:"api_disabled", count:null}, menuBar:{status:"api_disabled", present:null}},
    coreGraphics:{status:"unavailable", windows:null, onScreenWindows:null, truncated:false},
  };
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!app.isNil()) {
    const policies = {0:"regular", 1:"accessory", 2:"prohibited"};
    result.application = {found:true, hidden:Boolean(app.hidden), active:Boolean(app.active),
      terminated:Boolean(app.terminated), activationPolicy:policies[String(app.activationPolicy)] || "unknown"};
  }
  if (result.accessibilityTrusted) {
    const element = $.AXUIElementCreateApplication(pid);
    result.ax.timeoutStatus = axStatus($.AXUIElementSetMessagingTimeout(element, 0.5));
    // Do not start potentially long default-timeout queries if the bound failed.
    if (result.ax.timeoutStatus === "ok") {
      const count = Ref();
      const code = $.AXUIElementGetAttributeValueCount(element, $("AXWindows"), count);
      result.ax.windows.status = axStatus(code);
      if (code === 0) result.ax.windows.count = Math.min(cap, Math.max(0, Number(count[0])));
      const menu = Ref();
      const menuCode = $.AXUIElementCopyAttributeValue(element, $("AXMenuBar"), menu);
      result.ax.menuBar = {status:axStatus(menuCode), present:menuCode === 0 ? true : null};
    } else {
      result.ax.windows.status = "other";
      result.ax.menuBar.status = "other";
    }
  }
  // Only inspect numeric owner/visibility properties. Never read window names,
  // app names, paths, accessibility titles, text, children or arbitrary values.
  const windows = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(0, 0));
  if (!windows.isNil()) {
    const total = Number(windows.count);
    if (!Number.isSafeInteger(total) || total < 0) return JSON.stringify(result);
    const inspectCount = Math.min(total, 4096);
    let owned = 0, onScreen = 0;
    for (let index = 0; index < inspectCount; index++) {
      const entry = windows.objectAtIndex(index);
      if (Number(ObjC.unwrap(entry.objectForKey(ObjC.castRefToObject($.kCGWindowOwnerPID)))) !== pid) continue;
      owned++;
      if (ObjC.unwrap(entry.objectForKey(ObjC.castRefToObject($.kCGWindowIsOnscreen))) === true) onScreen++;
    }
    result.coreGraphics = {status:"observed", windows:Math.min(cap, owned),
      onScreenWindows:Math.min(cap, onScreen), truncated:total > inspectCount || owned > cap};
  }
  return JSON.stringify(result);
}

export function macOSTransitionUIDiagnosticScript(pid) {
  assertPID(pid);
  return `(${inspectOwnedApplication.toString()})(${pid})`;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\n") === [...keys].sort().join("\n");
}
function count(value) { return Number.isSafeInteger(value) && value >= 0 && value <= LIMIT; }

// Reject unknown fields/text rather than forwarding even a bounded subprocess
// response into a durable release receipt.
export function parseMacOSTransitionUIDiagnostics(output) {
  if (typeof output !== "string" || Buffer.byteLength(output) > 4096) throw new TypeError("Invalid Mac UI diagnostic");
  let value;
  try { value = JSON.parse(output); } catch { throw new TypeError("Invalid Mac UI diagnostic"); }
  const invalid = () => { throw new TypeError("Invalid Mac UI diagnostic"); };
  if (!exactKeys(value, ["schemaVersion", "status", "accessibilityTrusted", "application", "ax", "coreGraphics"])
      || value.schemaVersion !== SCHEMA || value.status !== "observed"
      || typeof value.accessibilityTrusted !== "boolean") invalid();
  const app = value.application, ax = value.ax, cg = value.coreGraphics;
  if (!exactKeys(app, ["found", "hidden", "active", "terminated", "activationPolicy"])
      || typeof app.found !== "boolean") invalid();
  if (app.found ? (![app.hidden, app.active, app.terminated].every(v => typeof v === "boolean")
      || !["regular", "accessory", "prohibited", "unknown"].includes(app.activationPolicy))
    : [app.hidden, app.active, app.terminated, app.activationPolicy].some(v => v !== null)) invalid();
  if (!exactKeys(ax, ["timeoutStatus", "windows", "menuBar"])
      || !(ax.timeoutStatus === null || AX_STATUSES.includes(ax.timeoutStatus))
      || !exactKeys(ax.windows, ["status", "count"]) || !AX_STATUSES.includes(ax.windows.status)
      || !exactKeys(ax.menuBar, ["status", "present"]) || !AX_STATUSES.includes(ax.menuBar.status)
      || (ax.windows.status === "ok" ? !count(ax.windows.count) : ax.windows.count !== null)
      || (ax.menuBar.status === "ok" ? ax.menuBar.present !== true : ax.menuBar.present !== null)) invalid();
  if ((!value.accessibilityTrusted && (ax.timeoutStatus !== null || ax.windows.status !== "api_disabled" || ax.menuBar.status !== "api_disabled"))
      || (value.accessibilityTrusted && ax.timeoutStatus === null)) invalid();
  if (!exactKeys(cg, ["status", "windows", "onScreenWindows", "truncated"])
      || typeof cg.truncated !== "boolean" || !["observed", "unavailable"].includes(cg.status)
      || (cg.status === "observed" ? (!count(cg.windows) || !count(cg.onScreenWindows) || cg.onScreenWindows > cg.windows)
        : (cg.windows !== null || cg.onScreenWindows !== null || cg.truncated))) invalid();
  return value;
}

/** Caller must revalidate its previously captured executable/PID/start-time
 * fingerprint; never use a process name or a stale PID as ownership evidence. */
export function collectMacOSTransitionUIDiagnostics({ pid, verifyOwnedProcess } = {}, {
  run = spawnSync, platform = process.platform,
} = {}) {
  assertPID(pid);
  if (typeof verifyOwnedProcess !== "function") throw new TypeError("Mac UI diagnostic ownership check is required");
  const unavailable = reason => ({ schemaVersion:SCHEMA, status:"unavailable", reason });
  if (platform !== "darwin") return unavailable("unsupported_host");
  const owned = () => { try { return verifyOwnedProcess(pid) === true; } catch { return false; } };
  if (!owned()) return unavailable("ownership_unverified");
  let response;
  try {
    response = run("/usr/bin/osascript", ["-l", "JavaScript", "-e", macOSTransitionUIDiagnosticScript(pid)], {
      encoding:"utf8", timeout:5000, killSignal:"SIGKILL", maxBuffer:4096, windowsHide:true,
    });
  } catch { return unavailable("probe_failed"); }
  if (!owned()) return unavailable("ownership_changed");
  if (response?.error || response?.status !== 0 || response?.signal) return unavailable("probe_failed");
  try { return parseMacOSTransitionUIDiagnostics(response.stdout); }
  catch { return unavailable("invalid_response"); }
}
