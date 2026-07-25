import {
  buildSyntheticFixture,
  createSyntheticEnvelope,
  formatTokenTotal,
  safeApiError,
  safeFilename
} from "./lib.js";

const API_ROOT = "/api/v1";
const SESSION_KEY = "usage-monitor.synthetic-session.v1";

const elements = {
  panels: [...document.querySelectorAll("[data-panel]")],
  steps: [...document.querySelectorAll("[data-step-target]")],
  notice: document.querySelector("#app-notice"),
  consent: document.querySelector("#consent-checkbox"),
  enroll: document.querySelector("#enroll-button"),
  empty: document.querySelector("#result-empty"),
  result: document.querySelector("#result-content"),
  statusPill: document.querySelector("#status-pill"),
  recoveryCard: document.querySelector("#recovery-card"),
  recoveryForm: document.querySelector("#recovery-access"),
  recoveryInput: document.querySelector("#recovery-input"),
  recoverButton: document.querySelector("#recover-button"),
  deleteForm: document.querySelector("#delete-confirmation"),
  deletePhrase: document.querySelector("#delete-phrase"),
  deleteButton: document.querySelector("#delete-button")
};

let session = readSession();

function readSession() {
  try {
    const value = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    return value?.accessToken ? value : null;
  } catch {
    return null;
  }
}

function saveSession(value) {
  session = value;
  if (value) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
  } else {
    sessionStorage.removeItem(SESSION_KEY);
  }
}

function showPanel(name) {
  elements.panels.forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
  const order = ["review", "enroll", "results"];
  const activeIndex = order.indexOf(name);
  elements.steps.forEach((step) => {
    const index = order.indexOf(step.dataset.stepTarget);
    step.classList.toggle("active", index === activeIndex);
    step.classList.toggle("complete", index < activeIndex);
    if (index === activeIndex) step.setAttribute("aria-current", "step");
    else step.removeAttribute("aria-current");
  });
}

function showNotice(message, { error = false } = {}) {
  elements.notice.textContent = message;
  elements.notice.classList.toggle("error", error);
  elements.notice.hidden = false;
  elements.notice.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function clearNotice() {
  elements.notice.hidden = true;
  elements.notice.textContent = "";
  elements.notice.classList.remove("error");
}

async function api(path, { method = "GET", body, auth = false } = {}) {
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (auth) {
    if (!session?.accessToken) throw new Error("This browser session is not enrolled.");
    headers.Authorization = `Bearer ${session.accessToken}`;
  }
  const response = await fetch(`${API_ROOT}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok) {
    let detail = "";
    try {
      const payload = await response.json();
      detail = safeApiError(payload, "");
    } catch {
      // Response bodies are intentionally not reflected into the interface.
    }
    throw new Error(detail || `Request failed (${response.status}).`);
  }
  if (response.status === 204) return null;
  return response.json();
}

function renderFixture() {
  const fixture = buildSyntheticFixture();
  document.querySelector("#record-count").textContent = "1";
  document.querySelector("#fixture-json").textContent = JSON.stringify(fixture, null, 2);
  const row = document.createElement("tr");
  const values = [
    "Jul 14–21, 2026",
    fixture.usage.modelId,
    fixture.usage.subscriptionSpeed,
    formatTokenTotal(fixture.usage),
    `${fixture.quota.usedPercentAfter - fixture.quota.usedPercentBefore} pp`
  ];
  row.replaceChildren(...values.map((value) => {
    const cell = document.createElement("td");
    cell.textContent = value;
    return cell;
  }));
  document.querySelector("#record-table-body").replaceChildren(row);
}

function renderSession() {
  const hasSession = Boolean(session?.accessToken);
  elements.empty.hidden = hasSession;
  elements.result.hidden = !hasSession;
  if (!hasSession) {
    elements.statusPill.className = "status-pill";
    elements.statusPill.innerHTML = '<span aria-hidden="true">●</span> Not enrolled';
    return;
  }
  document.querySelector("#participant-id").textContent = session.participantId || "Anonymous";
  document.querySelector("#contribution-id").textContent = session.contributionId || "Pending";
  document.querySelector("#processing-status").textContent = session.status || "accepted";
  document.querySelector("#recovery-code").textContent = session.recoveryCode || "Already acknowledged";
  elements.recoveryCard.hidden = !session.recoveryCode;
  elements.statusPill.className = "status-pill accepted";
  elements.statusPill.innerHTML = `<span aria-hidden="true">●</span> ${escapeText(session.status || "Accepted")}`;
}

function escapeText(value) {
  const span = document.createElement("span");
  span.textContent = String(value);
  return span.innerHTML;
}

function setBusy(button, busy, busyText) {
  if (busy) {
    button.dataset.previousLabel = button.textContent;
    button.textContent = busyText;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.previousLabel || button.textContent;
    button.disabled = false;
  }
}

async function enrollAndContribute() {
  clearNotice();
  setBusy(elements.enroll, true, "Encrypting synthetic fixture…");
  try {
    const enrollment = await api("/enroll", {
      method: "POST",
      body: {
        consentVersion: "synthetic-preview-v0.1",
        syntheticOnly: true
      }
    });
    saveSession({
      participantId: enrollment.participantId,
      accessToken: enrollment.accessToken,
      recoveryCode: enrollment.recoveryCode,
      status: "enrolling"
    });

    const key = await api("/envelope-key");
    if (key.algorithm !== "RSA-OAEP-256") {
      throw new Error("The server offered an unsupported envelope algorithm.");
    }
    const envelope = await createSyntheticEnvelope({
      publicJwk: key.publicJwk,
      keyId: key.keyId
    });
    const receipt = await api("/contributions", {
      method: "POST",
      auth: true,
      body: envelope
    });
    saveSession({
      ...session,
      contributionId: receipt.contributionId,
      status: receipt.status || "accepted"
    });
    renderSession();
    showPanel("results");
    showNotice("Synthetic metadata encrypted in this browser and accepted by the development service.");
  } catch (error) {
    if (session?.status === "enrolling") {
      try {
        await api("/me", { method: "DELETE", auth: true });
      } catch {
        // Best-effort cleanup; the original failure remains the useful error.
      }
      saveSession(null);
    }
    showNotice(error.message, { error: true });
  } finally {
    setBusy(elements.enroll, false);
    elements.enroll.disabled = !elements.consent.checked;
  }
}

async function refreshStatus() {
  const button = document.querySelector("#refresh-status");
  clearNotice();
  setBusy(button, true, "Refreshing…");
  try {
    const result = await api("/me", { auth: true });
    const latestContribution = Array.isArray(result.contributions)
      ? result.contributions.at(-1)
      : result.latestContribution;
    saveSession({
      ...session,
      participantId: result.participantId || session.participantId,
      contributionId: result.contributionId || latestContribution?.contributionId || session.contributionId,
      status: result.status || latestContribution?.status || session.status
    });
    renderSession();
    showNotice("Status refreshed.");
  } catch (error) {
    showNotice(error.message, { error: true });
  } finally {
    setBusy(button, false);
  }
}

async function recoverParticipant(event) {
  event.preventDefault();
  clearNotice();
  const recoveryCode = elements.recoveryInput.value.trim();
  if (!recoveryCode) return;
  setBusy(elements.recoverButton, true, "Recovering…");
  try {
    const recovered = await api("/recover", {
      method: "POST",
      body: { recoveryCode }
    });
    saveSession({
      participantId: recovered.participantId,
      accessToken: recovered.accessToken,
      status: "recovered"
    });
    const result = await api("/me", { auth: true });
    const latestContribution = Array.isArray(result.contributions)
      ? result.contributions.at(-1)
      : result.latestContribution;
    saveSession({
      ...session,
      participantId: result.participantId || session.participantId,
      contributionId: latestContribution?.contributionId,
      status: latestContribution?.status || "recovered"
    });
    elements.recoveryInput.value = "";
    renderSession();
    showPanel("results");
    showNotice("Access recovered. The previous browser access token is now invalid.");
  } catch (error) {
    saveSession(null);
    showNotice(error.message, { error: true });
  } finally {
    setBusy(elements.recoverButton, false);
  }
}

async function exportParticipant() {
  const button = document.querySelector("#export-button");
  clearNotice();
  setBusy(button, true, "Preparing export…");
  try {
    const payload = await api("/me/export", { auth: true });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safeFilename(session.participantId);
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    showNotice("Your synthetic participant export was downloaded.");
  } catch (error) {
    showNotice(error.message, { error: true });
  } finally {
    setBusy(button, false);
  }
}

async function deleteParticipant(event) {
  event.preventDefault();
  if (elements.deletePhrase.value !== "DELETE") return;
  clearNotice();
  setBusy(elements.deleteButton, true, "Deleting…");
  try {
    await api("/me", { method: "DELETE", auth: true });
    saveSession(null);
    elements.deletePhrase.value = "";
    elements.deleteForm.hidden = true;
    elements.consent.checked = false;
    elements.enroll.disabled = true;
    renderSession();
    showPanel("review");
    showNotice("The synthetic participant and contribution were permanently deleted.");
  } catch (error) {
    showNotice(error.message, { error: true });
    setBusy(elements.deleteButton, false);
  }
}

document.querySelector("#continue-to-enroll").addEventListener("click", () => showPanel("enroll"));
document.querySelectorAll("[data-back-to]").forEach((button) => {
  button.addEventListener("click", () => showPanel(button.dataset.backTo));
});
elements.steps.forEach((step) => {
  step.addEventListener("click", () => showPanel(step.dataset.stepTarget));
});
elements.consent.addEventListener("change", () => {
  elements.enroll.disabled = !elements.consent.checked;
});
elements.enroll.addEventListener("click", enrollAndContribute);
elements.recoveryForm.addEventListener("submit", recoverParticipant);
document.querySelector("#refresh-status").addEventListener("click", refreshStatus);
document.querySelector("#export-button").addEventListener("click", exportParticipant);
document.querySelector("#copy-recovery").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(session?.recoveryCode || "");
    showNotice("Recovery code copied. Store it somewhere private.");
  } catch {
    showNotice("Copy was blocked by the browser. Select and copy the displayed code instead.", { error: true });
  }
});
document.querySelector("#show-delete").addEventListener("click", () => {
  elements.deleteForm.hidden = false;
  elements.deletePhrase.focus();
});
document.querySelector("#cancel-delete").addEventListener("click", () => {
  elements.deleteForm.hidden = true;
  elements.deletePhrase.value = "";
  elements.deleteButton.disabled = true;
});
elements.deletePhrase.addEventListener("input", () => {
  elements.deleteButton.disabled = elements.deletePhrase.value !== "DELETE";
});
elements.deleteForm.addEventListener("submit", deleteParticipant);

renderFixture();
renderSession();
if (session) showPanel("results");
