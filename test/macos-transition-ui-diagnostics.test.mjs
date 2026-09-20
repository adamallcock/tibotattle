import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";
import { collectMacOSTransitionUIDiagnostics, macOSTransitionUIDiagnosticScript,
  parseMacOSTransitionUIDiagnostics } from "../scripts/lib/macos-transition-ui-diagnostics.mjs";

function fixture({ trusted = true, windowsCode = 0, menuCode = 0, timeoutCode = 0, rows = [] } = {}) {
  const calls = [];
  const $ = value => value;
  Object.assign($, {
    AXIsProcessTrusted: () => trusted,
    NSRunningApplication: {runningApplicationWithProcessIdentifier: pid => {
      calls.push(["app", pid]);
      return {isNil:() => false, hidden:false, active:true, terminated:false, activationPolicy:0};
    }},
    AXUIElementCreateApplication: pid => { calls.push(["ax", pid]); return pid; },
    AXUIElementSetMessagingTimeout: (element, seconds) => { calls.push(["timeout", element, seconds]); return timeoutCode; },
    AXUIElementGetAttributeValueCount: (element, attribute, out) => {
      calls.push(["count", element, attribute]); out[0] = 3; return windowsCode;
    },
    AXUIElementCopyAttributeValue: (element, attribute, out) => {
      calls.push(["menu", element, attribute]); out[0] = {}; return menuCode;
    },
    kCGWindowOwnerPID:"owner", kCGWindowIsOnscreen:"onScreen",
    CGWindowListCopyWindowInfo: () => ({isNil:() => false, count:rows.length,
      objectAtIndex:index => ({objectForKey:key => {
        assert.ok(["owner", "onScreen"].includes(key), "No window text may be read");
        return rows[index][key];
      }})}),
  });
  const output = vm.runInNewContext(macOSTransitionUIDiagnosticScript(1234), {
    $, ObjC:{import() {}, unwrap:value => value, castRefToObject:value => value}, Ref:() => [],
  });
  return {calls, output, value:parseMacOSTransitionUIDiagnostics(output)};
}

test("read-only JXA inspects exact PID, bounded AX calls and only owned numeric window properties", () => {
  const {value,calls} = fixture({rows:[{owner:1234,onScreen:true},{owner:1234,onScreen:false},{owner:999,onScreen:true}]});
  assert.deepEqual(value.ax.windows, {status:"ok",count:3});
  assert.deepEqual(value.ax.menuBar, {status:"ok",present:true});
  assert.deepEqual(value.coreGraphics, {status:"observed",windows:2,onScreenWindows:1,truncated:false});
  assert.deepEqual(calls, [["app",1234],["ax",1234],["timeout",1234,0.5],["count",1234,"AXWindows"],["menu",1234,"AXMenuBar"]]);
});

test("AX connection failure is distinct from zero visible windows and missing menu", () => {
  const {value} = fixture({windowsCode:-25204,menuCode:-25212});
  assert.deepEqual(value.ax.windows,{status:"cannot_complete",count:null});
  assert.deepEqual(value.ax.menuBar,{status:"no_value",present:null});
  assert.equal(value.coreGraphics.windows,0);
  assert.equal(fixture({windowsCode:-999}).value.ax.windows.status,"other");
});

test("untrusted caller never prompts or queries AX; failed timeout setup skips AX requests", () => {
  const noTrust=fixture({trusted:false});
  assert.deepEqual(noTrust.calls,[["app",1234]]);
  assert.equal(noTrust.value.ax.windows.status,"api_disabled");
  const noBound=fixture({timeoutCode:-25201});
  assert.deepEqual(noBound.calls,[["app",1234],["ax",1234],["timeout",1234,0.5]]);
  assert.equal(noBound.value.ax.timeoutStatus,"illegal_argument");
  assert.equal(noBound.value.ax.windows.count,null);
});

test("CG window inventory is capped and cannot include other process counts or labels", () => {
  const {value} = fixture({rows:Array.from({length:4100},()=>({owner:1234,onScreen:true}))});
  assert.deepEqual(value.coreGraphics,{status:"observed",windows:512,onScreenWindows:512,truncated:true});
  const script=macOSTransitionUIDiagnosticScript(1234);
  assert.doesNotMatch(script,/AXUIElementPerformAction|AXUIElementSetAttributeValue|AXIsProcessTrustedWithOptions|\.activate|\.click|\.frontmost|kCGWindowName|bundleIdentifier|executableURL|AXTitle|AXValue|AXChildren/u);
});

test("rejects invalid PIDs and arbitrary response data instead of retaining content", () => {
  for(const pid of [undefined,0,1,-1,1.5,"1234",[1234],2147483648,NaN]) assert.throws(()=>macOSTransitionUIDiagnosticScript(pid));
  const base=fixture().value;
  for(const change of [v=>{v.title="PRIVATE";},v=>{v.application.path="PRIVATE";},v=>{v.ax.windows.status="PRIVATE";},v=>{v.ax.windows.count=-1;},v=>{v.coreGraphics.onScreenWindows=1;},v=>{v.ax.menuBar.present="yes";}]) {
    const next=structuredClone(base);change(next);assert.throws(()=>parseMacOSTransitionUIDiagnostics(JSON.stringify(next)),/Invalid Mac UI diagnostic/);
  }
  for(const output of [null,"PRIVATE","x".repeat(5000),"[]"]) assert.throws(()=>parseMacOSTransitionUIDiagnostics(output));
});

test("collector fences ownership before and after fixed osascript invocation", () => {
  const output=fixture().output; let checks=0;
  const value=collectMacOSTransitionUIDiagnostics({pid:1234,verifyOwnedProcess:pid=>{assert.equal(pid,1234);checks++;return true;}}, {
    platform:"darwin",run:(file,args,options)=>{
      assert.equal(file,"/usr/bin/osascript");assert.deepEqual(args.slice(0,3),["-l","JavaScript","-e"]);
      assert.equal(args[3],macOSTransitionUIDiagnosticScript(1234));
      assert.deepEqual(options,{encoding:"utf8",timeout:5000,killSignal:"SIGKILL",maxBuffer:4096,windowsHide:true});
      return {status:0,stdout:output,stderr:"PRIVATE"};
    },
  });
  assert.equal(checks,2);assert.equal(value.status,"observed");
  let call=0;
  const changed=collectMacOSTransitionUIDiagnostics({pid:1234,verifyOwnedProcess:()=>++call===1}, {platform:"darwin",run:()=>({status:0,stdout:output})});
  assert.equal(changed.reason,"ownership_changed");
});

test("collector failures retain only fixed reasons, never stderr or exception text", () => {
  const args={pid:1234,verifyOwnedProcess:()=>true};
  for(const run of [()=>{throw Error("PRIVATE");},()=>({status:1,stderr:"PRIVATE"}),()=>({status:0,error:Error("PRIVATE")}),()=>({status:0,stdout:"PRIVATE"})]) {
    const result=collectMacOSTransitionUIDiagnostics(args,{platform:"darwin",run});
    assert.equal(result.status,"unavailable");assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
  }
  const never=()=>{assert.fail("Must not execute");};
  assert.equal(collectMacOSTransitionUIDiagnostics(args,{platform:"linux",run:never}).reason,"unsupported_host");
  assert.equal(collectMacOSTransitionUIDiagnostics({...args,verifyOwnedProcess:()=>false},{platform:"darwin",run:never}).reason,"ownership_unverified");
  assert.throws(()=>collectMacOSTransitionUIDiagnostics({pid:1234},{platform:"darwin",run:never}),/ownership/);
});

test("real JXA CF bridge reads only synthetic window dictionaries with exact PID filtering", {
  skip:process.platform !== "darwin",
}, () => {
  // No real window inventory or AX query: exercise the real CF/NSNumber bridge
  // with synthetic data, retaining exact production owner-key handling.
  const script=macOSTransitionUIDiagnosticScript(process.pid)
    .replace("Boolean($.AXIsProcessTrusted())","false")
    .replace("$.CGWindowListCopyWindowInfo(0, 0)",
      `ObjC.castObjectToRef($([{kCGWindowOwnerPID:${process.pid},kCGWindowIsOnscreen:true},{kCGWindowOwnerPID:1,kCGWindowIsOnscreen:true}]))`);
  const result=spawnSync("/usr/bin/osascript",["-l","JavaScript","-e",script],{
    encoding:"utf8",timeout:5000,killSignal:"SIGKILL",maxBuffer:4096,
  });
  assert.equal(result.status,0,"Synthetic native bridge must execute");
  assert.deepEqual(parseMacOSTransitionUIDiagnostics(result.stdout).coreGraphics,
    {status:"observed",windows:1,onScreenWindows:1,truncated:false});
});
