export function renderPresence(list, selfID) {
  const root = document.querySelector("#presenceList");
  root.replaceChildren();
  for (const person of list) {
    const item = document.createElement("li");
    item.dataset.color = person.colorIndex;
    const marker = document.createElement("span");
    marker.className = "presence-marker";
    marker.setAttribute("aria-hidden", "true");
    const label = document.createElement("span");
    label.textContent = `${person.name} · ${person.clientID.slice(0, 6)}${person.clientID === selfID ? " (you)" : ""}`;
    item.append(marker, label);
    root.append(item);
  }
}
export function setStatus(phase, detail = "") {
  const badge = document.querySelector("#statusBadge");
  badge.textContent = phase;
  badge.dataset.phase = phase.toLowerCase().replaceAll(" ", "-");
  document.querySelector("#liveStatus").textContent = detail
    ? `${phase}. ${detail}`
    : phase;
}
export async function copyWithFallback(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const dialog = document.querySelector("#copyDialog");
    dialog.querySelector("textarea").value = text;
    dialog.showModal();
    dialog.querySelector("textarea").select();
    return false;
  }
}
