# Agent write tools — specification

Agent mode currently reads (`read_file`, `list_files`, `search_files`) and runs
approved commands (`run_command`). It cannot modify anything. This specifies the
write capability, and the constraints it must satisfy.

Implement **after** the inference and reasoning work is verified and pushed, so
there is one writer in the repository at a time.

---

## 1. The property that matters most

**Every edit must land in VS Code's undo stack.**

Apply changes through `vscode.workspace.applyEdit` with a `WorkspaceEdit`, not
through `fs.writeFile`. A model that edits the wrong function is not a
catastrophe if `Ctrl+Z` puts it back; the same edit written straight to disk,
behind the editor's back, is data loss. This single decision matters more than
every other control here, so do not "optimise" it into a direct write because
the file happens to be closed.

Where a file is not open, `applyEdit` still works and still participates in
undo. Use it uniformly.

---

## 2. Tools

### `write_file`
Create a file, or replace its entire contents.

```json
{ "path": "src/util.js", "content": "…" }
```

### `edit_file`
Replace one exact substring.

```json
{ "path": "src/util.js", "old_text": "…", "new_text": "…" }
```

`old_text` **must appear exactly once**. Zero matches is a refusal. Two or more
matches is a refusal naming the count — never edit the first occurrence and hope.
Ambiguity is the failure mode that silently corrupts the wrong call site, so it
must be reported back to the model, which can then re-read and send a longer,
unique `old_text`.

Do not add a regex or line-number variant. Both are far easier to get subtly
wrong, and a unique-substring contract is checkable.

---

## 3. Permission

Writing is a separate capability from running commands, so it gets its own gate.

- New setting `localCoder.agent.allowWrite`, boolean, **default `false`**.
- Writing additionally requires `agent.mode` to be `allowlist` or `confirm`.
  `readonly` and `off` refuse regardless of `allowWrite`.
- In `confirm` mode, **every** write is confirmed through a modal naming the file
  and the byte delta. A webview message must never be sufficient to authorise a
  write.
- `tools/check-source.js` asserts the setting exists and defaults to `false`.

## 4. Refusals

Refuse, with a reason the model can act on:

| Condition | Why |
|---|---|
| Path resolves outside the workspace | Same containment rule as reading: resolve first, then require the workspace root plus a separator |
| `isSensitivePath(path)` | The deny-list that keeps `.env` out of context must also stop it being written |
| Anywhere under `.localcoder/` | `memory.md` is injected into every prompt. A model that can edit its own standing instructions is a prompt-injection amplifier: untrusted file content could persist an instruction into all future turns |
| Content contains a NUL byte | Not text; the write would corrupt a binary |
| Resulting file over 1 MiB | Bounds the damage and the diff |
| `edit_file` where the file does not exist | Use `write_file` deliberately rather than creating by accident |
| More than 20 writes in one agent turn | Bounds a runaway loop |

Refusals return the same `{ ok: false, content: "Refused: …" }` shape the other
tools use, so the model can adapt rather than crash the turn.

## 5. Audit

Record path, operation, and bytes added/removed. **Never record file contents** —
the audit log is written to the output channel, and a write tool that logged
content would put source into a place the read tools deliberately keep it out of.

## 6. Tests

Cover at least:

- traversal (`../`) and absolute paths refused
- `.env` and other sensitive paths refused for both tools
- `.localcoder/memory.md` refused
- `edit_file` with zero matches refused; with two matches refused, naming the count
- `edit_file` with exactly one match applies, and the surrounding text is untouched
- the edit is applied through `applyEdit` — assert against a stubbed
  `vscode.workspace.applyEdit`, so a future change to a raw `fs.writeFile` fails
- the write cap per turn is enforced
- the audit entry contains the path but not the content
- with `allowWrite` false, both tools refuse in every mode

## 7. Documentation

- `docs/AGENT_MODE.md`: the two tools, the `allowWrite` gate, the undo property,
  and the refusal table.
- `docs/THREAT_MODEL.md`: rows for "model edits the wrong file" (mitigated by
  undo, confirmation, and containment) and "model edits its own project memory"
  (refused outright).
- `docs/START_HERE.md`: one line in the agent section, no more.

---

## 8. Validation with the real model

Implementing this is not the same as it working. On the rented instance, with
the real model running, check whether the model can actually drive it:

1. Give it a small real task in a scratch workspace — "add a docstring to the
   function in x.js" — and see whether it emits a well-formed `edit_file` call
   with a **unique** `old_text`.
2. Then a task needing two steps: read a file, then edit it.
3. Then "run the tests and fix the failure", which exercises `run_command` and
   `edit_file` together.
4. Record: how many attempts produced valid tool calls, how many produced an
   ambiguous `old_text`, and the wall-clock time per task.

A model that cannot reliably produce a unique `old_text` will find `edit_file`
frustrating, and that is worth knowing before the feature is recommended rather
than after. Report the numbers; do not soften them.

The `tool-call-argv-shape` benchmark task already measures whether the model can
emit argv correctly. Add an equivalent task for `edit_file` argument shape so
this is measurable without a full agent run.
