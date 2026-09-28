const KEY = "collab-editor:draft:v1";
const encoder = new TextEncoder();
export function readDraft() {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY));
    if (
      value?.schema !== 1 ||
      typeof value.text !== "string" ||
      encoder.encode(value.text).byteLength > 32768 ||
      typeof value.language !== "string"
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
export function saveDraft({ roomId = null, epoch = null, text, language }) {
  try {
    const value = {
      schema: 1,
      roomId,
      epoch,
      text,
      language,
      updatedAt: Date.now(),
    };
    const serialized = JSON.stringify(value);
    if (encoder.encode(serialized).byteLength > 262144) return false;
    sessionStorage.setItem(KEY, serialized);
    return true;
  } catch {
    return false;
  }
}
export function clearDraft() {
  try {
    sessionStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
export function downloadText(text, language) {
  const extension =
    language === "python" ? "py" : language === "text" ? "txt" : "js";
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/plain;charset=utf-8" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `snippet.${extension}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url));
}
