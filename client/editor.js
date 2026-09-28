import { basicSetup } from "codemirror";
import { EditorState, Compartment, Transaction } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { indentLess, indentMore } from "@codemirror/commands";
import {
  collab,
  getSyncedVersion,
  receiveUpdates,
  sendableUpdates,
} from "@codemirror/collab";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";

const languageCompartment = new Compartment();
const wrapCompartment = new Compartment();
const editableCompartment = new Compartment();

export function createCollaborativeEditor({
  parent,
  doc,
  version,
  clientID,
  onLocalChange,
  onTextChange,
  onLimit,
}) {
  let applyingRemote = false;
  let editableGeneration = 0;
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        basicSetup,
        EditorView.cspNonce.of(
          document.querySelector('meta[name="csp-nonce"]')?.content || "",
        ),
        collab({ startVersion: version, clientID }),
        EditorState.transactionFilter.of((transaction) => {
          if (
            !transaction.docChanged ||
            transaction.annotation(Transaction.remote)
          )
            return transaction;
          const bytes = new TextEncoder().encode(
            transaction.newDoc.toString(),
          ).byteLength;
          if (
            bytes > 32768 ||
            transaction.newDoc.length > 32768 ||
            sendableUpdates(transaction.startState).length >= 128
          ) {
            onLimit?.();
            return [];
          }
          return transaction;
        }),
        languageCompartment.of(javascript()),
        wrapCompartment.of([]),
        editableCompartment.of(EditorView.editable.of(true)),
        placeholder("Start typing a short snippet…"),
        keymap.of([
          { key: "Mod-[", run: indentLess },
          { key: "Mod-]", run: indentMore },
        ]),
        EditorView.contentAttributes.of({
          "aria-label": "Shared code editor",
          "aria-describedby": "editorHelp",
        }),
        EditorView.updateListener.of((update) => {
          const pendingChanged =
            sendableUpdates(update.startState).length !==
            sendableUpdates(update.state).length;
          if (update.docChanged || pendingChanged) {
            onTextChange?.(update.state.doc.toString());
            if (
              !applyingRemote &&
              update.transactions.some((transaction) => transaction.docChanged)
            )
              onLocalChange?.();
          }
        }),
      ],
    }),
  });
  let composing = false;
  let compositionWaiters = [];
  view.contentDOM.addEventListener("compositionstart", () => {
    composing = true;
  });
  view.contentDOM.addEventListener("compositionend", () => {
    composing = false;
    for (const resolve of compositionWaiters.splice(0)) resolve();
  });
  return {
    view,
    text: () => view.state.doc.toString(),
    version: () => getSyncedVersion(view.state),
    pending: () => sendableUpdates(view.state),
    receive(updates) {
      applyingRemote = true;
      view.dispatch(receiveUpdates(view.state, updates));
      applyingRemote = false;
    },
    setEditable(editable) {
      editableGeneration += 1;
      view.dispatch({
        effects: editableCompartment.reconfigure(
          EditorView.editable.of(editable),
        ),
      });
    },
    async freeze() {
      const generation = ++editableGeneration;
      if (composing)
        await new Promise((resolve) => compositionWaiters.push(resolve));
      if (generation !== editableGeneration) return;
      view.dispatch({
        effects: editableCompartment.reconfigure(EditorView.editable.of(false)),
      });
    },
    isComposing: () => composing,
    focus() {
      view.focus();
    },
    setLanguage(language) {
      view.dispatch({
        effects: languageCompartment.reconfigure(
          language === "python"
            ? python()
            : language === "text"
              ? []
              : javascript(),
        ),
      });
    },
    setWrap(enabled) {
      view.dispatch({
        effects: wrapCompartment.reconfigure(
          enabled ? EditorView.lineWrapping : [],
        ),
      });
    },
    insert(text) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    },
    destroy() {
      editableGeneration += 1;
      composing = false;
      for (const resolve of compositionWaiters.splice(0)) resolve();
      view.destroy();
    },
  };
}
