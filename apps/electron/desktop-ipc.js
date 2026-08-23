import {
  DESKTOP_ACTIONS,
  DESKTOP_IPC_CHANNEL,
  validateDesktopRequest,
} from "./desktop-contract.js";

const HANDLER_NAMES = new Set(DESKTOP_ACTIONS);

function ipcError(code) {
  const error = new Error("Desktop IPC request rejected");
  error.name = "DesktopIpcError";
  error.code = code;
  return error;
}

function assertIpcMain(ipcMain) {
  if (ipcMain === null || typeof ipcMain !== "object") {
    throw new TypeError("ipcMain is required");
  }
  if (typeof ipcMain.handle !== "function") {
    throw new TypeError("ipcMain.handle is required");
  }
  return ipcMain;
}

function assertHandlerMap(handlers) {
  if (handlers === null || typeof handlers !== "object" || Array.isArray(handlers)) {
    throw new TypeError("handlers must be an object");
  }
  const unknown = Reflect.ownKeys(handlers).filter((key) => !HANDLER_NAMES.has(key));
  if (unknown.length > 0) throw new TypeError("handlers contains an unknown action");
  for (const action of DESKTOP_ACTIONS) {
    if (handlers[action] !== undefined && typeof handlers[action] !== "function") {
      throw new TypeError(`handler for ${action} must be a function`);
    }
  }
  return handlers;
}

function makeAuthorization(check, label) {
  if (typeof check === "function") {
    return (subject, event) => {
      try {
        return check(subject, event) === true;
      } catch {
        return false;
      }
    };
  }
  if (check !== null && check !== undefined) {
    return (subject) => subject === check;
  }
  throw new TypeError(`${label} authorization is required`);
}

function authorized(check, subject, event) {
  try {
    return check(subject, event) === true;
  } catch {
    return false;
  }
}

/**
 * Create the one fixed-channel request handler.  The sender and frame checks
 * are injected by the main process so this module cannot accidentally trust a
 * different BrowserWindow or a navigation-created frame.
 */
export function createDesktopIpcHandler({
  handlers = {},
  trustedSender,
  trustedFrame,
} = {}) {
  const boundedHandlers = assertHandlerMap(handlers);
  const senderCheck = makeAuthorization(trustedSender, "sender");
  const frameCheck = makeAuthorization(trustedFrame, "frame");

  return async function handleDesktopIpc(event, rawRequest) {
    if (!authorized(senderCheck, event?.sender, event)
        || !authorized(frameCheck, event?.senderFrame, event)) {
      throw ipcError("desktop_ipc_untrusted_context");
    }

    let request;
    try {
      request = validateDesktopRequest(rawRequest);
    } catch {
      throw ipcError("desktop_ipc_invalid_request");
    }

    const handler = boundedHandlers[request.action];
    if (typeof handler !== "function") {
      throw ipcError("desktop_ipc_action_unavailable");
    }
    try {
      return await handler(request.args, Object.freeze({
        event,
        sender: event.sender,
        senderFrame: event.senderFrame,
      }));
    } catch (error) {
      if (error?.name === "DesktopIpcError") throw error;
      throw ipcError("desktop_ipc_handler_failed");
    }
  };
}

/**
 * Install the handler through Electron's ipcMain.  No generic invoke/send
 * function is returned to callers or exposed to the renderer.
 */
export function installDesktopIpc({
  ipcMain,
  handlers = {},
  trustedSender,
  trustedFrame,
} = {}) {
  const main = assertIpcMain(ipcMain);
  const handle = createDesktopIpcHandler({ handlers, trustedSender, trustedFrame });
  main.handle(DESKTOP_IPC_CHANNEL, handle);
  let installed = true;
  return Object.freeze({
    channel: DESKTOP_IPC_CHANNEL,
    handler: handle,
    dispose() {
      if (!installed) return;
      installed = false;
      main.removeHandler?.(DESKTOP_IPC_CHANNEL);
    },
  });
}

export { DESKTOP_IPC_CHANNEL };
