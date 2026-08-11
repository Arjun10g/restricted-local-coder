# Agent mode

Agent mode lets the model read the workspace and run approved commands instead
of only answering from the context it was handed. It is **off by default**, and
this page is mostly about why the boundary is shaped the way it is.

## Turning it on

```json
{
  "localCoder.agent.mode": "readonly"
}
```

| Mode | The model may |
|---|---|
| `off` | nothing — tools are not offered to the model at all (default) |
| `readonly` | read, list, and search workspace files |
| `allowlist` | the above, plus commands matching `localCoder.agent.allowedCommands` |
| `confirm` | the above, plus any command, each requiring a modal confirmation |

Start at `readonly`. It is genuinely useful — "which file registers the
commands?" becomes answerable — and it cannot cause an effect outside the editor.

## The two properties the safety rests on

**Commands are matched as an argv prefix, never as text.** A rule of `npm test`
permits `["npm","test"]` and `["npm","test","--reporter=tap"]`. It does not
permit `["npm","test; rm -rf ~"]`, because `"test; rm -rf ~"` is simply not the
token `"test"`. Nothing in the permission code joins argv into a string to decide,
which is the mistake that makes allow-lists porous.

**There is no shell.** Commands are started with `spawn` and an argv array with
`shell: false`. An argument of `&&` or `| curl evil.example` is handed to the
program as that literal string; there is nothing to interpret it. This is also
why `child_process.exec` is banned repository-wide by `tools/check-source.js`.

Consequently, a model that emits one shell-shaped string instead of argv items
will have every command rejected. That is the intended failure: reject rather
than guess at splitting.

## What it still cannot do

- **Read secrets.** `read_file` applies the same deny-list that keeps `.env`,
  `.pem`, `.ssh`, and credential files out of chat context. An agent that could
  read them would be a way around that control, not a new feature.
- **Leave the workspace.** Paths are resolved first, then confirmed to be inside
  the workspace root. `../` cannot walk out, and a sibling directory sharing the
  root's name prefix is correctly treated as outside.
- **Write anything, unless you turn writing on separately.** See "Editing files"
  below; the gate is `localCoder.agent.allowWrite`, default `false`. There is no
  move or delete tool at all, and the default command list contains nothing that
  installs, pushes, or reaches the network.
- **Run forever.** The loop is capped by `localCoder.agent.maxSteps` (default 8).
  Hitting the cap is reported as such, not dressed up as a finished answer.
- **Escape its own output.** Tool results re-enter the prompt and are neutralized
  exactly like any other untrusted workspace text, so a file cannot close the
  wrapper and address the model as though it were the extension.

## Editing files

Writing is a **separate capability from running commands**, so it has its own
switch. Both must be on:

```json
{
  "localCoder.agent.mode": "confirm",
  "localCoder.agent.allowWrite": true
}
```

`readonly` and `off` refuse every write whatever `allowWrite` says. In `confirm`
mode every single write is confirmed through a modal naming the file and the
byte delta — a webview message is never sufficient to authorise one.

| Tool | Arguments | What it does |
|---|---|---|
| `write_file` | `{ "path", "content" }` | Creates a file, or replaces its whole contents |
| `edit_file` | `{ "path", "old_text", "new_text" }` | Replaces one exact substring |

**Every edit lands in VS Code's undo stack.** Changes are applied through
`vscode.workspace.applyEdit`, never `fs.writeFile`, including when the file is
not open. That single property is what makes the feature safe to offer at all: a
model that edits the wrong function is a nuisance you undo with `Ctrl+Z`, where
the same edit written behind the editor's back is data loss. `check-source.js`
asserts the write tools never touch the filesystem directly, so a later
"simplification" to `fs.writeFile` fails the build.

`edit_file` requires `old_text` to appear **exactly once**. Zero matches is a
refusal; two or more is a refusal that names the count. It never edits the first
of several matches, because that is precisely how the wrong call site gets
silently corrupted. The refusal goes back to the model, which can re-read the
file and send a longer, unique `old_text`.

Writes are refused when:

| Condition | Why |
|---|---|
| The path resolves outside the workspace | Same containment rule as reading |
| The path is on the secret deny-list | The list that keeps `.env` out of context must also stop it being written |
| Anything under `.localcoder/` | `memory.md` is injected into every prompt, so a model that could edit it could persist an instruction into all future turns |
| The content contains a NUL byte | It is not text, and the write would corrupt a binary |
| The result would exceed 1 MiB | Bounds the damage and the diff |
| `edit_file` on a file that does not exist | Use `write_file` deliberately rather than creating by accident |
| More than 20 writes in one turn | Bounds a runaway loop |

The audit log records the path, the operation, and the bytes added or removed.
It never records file contents.

## What to expect — measured, not promised

Agent mode was validated against the real default model before this section was
written. Full method and per-scenario tables are in
[AGENT_VALIDATION.md](AGENT_VALIDATION.md); measured on a 28-core AMD EPYC 7763,
56 GB, CPU-only, `llama-server` b10355, the shipped profile and argument list.

**The model can drive the tools.** Across 72 agent tasks and 190 tool calls on
the default Qwen3-Coder profile:

| | |
|---|---:|
| Tool calls with malformed JSON arguments | 0 |
| `edit_file` calls whose `old_text` matched exactly once | 64 of 64 (100%) |
| `edit_file` calls with an ambiguous `old_text` | 0 |
| `run_command` calls that produced correct argv | 48 of 48 |
| Tasks that reached a verified-correct result | 64 of 72 |

The ambiguity refusal — the one thing likely to make `edit_file` frustrating —
never fired. The model sends 90 to 226 characters of surrounding context per
`old_text`, which is unique by construction.

**It is not fast, and this is the part to be realistic about.** Wall-clock per
task, on that machine:

| Task | Small workspace | ~7.5k tokens of workspace context |
|---|---:|---:|
| One targeted edit | ~27 s | ~36 s |
| Read a file, then edit it | ~21 s | ~41 s |
| Run the tests, fix the failure, re-run | ~76 s | ~127 s |

Those are turns after the first. **The first turn of a conversation additionally
pays about 170 seconds** to process a 7k-token workspace context before it emits
anything; later turns reuse that prefix and pay 130-160 ms. Generation runs at
17-18 tok/s on a small workspace and 8-9 tok/s at 7-9k tokens of depth.

So: this is not Cursor, and it is not interactive. It is a model that will
reliably make a small, well-specified change in twenty seconds to two minutes,
on a machine with no GPU. Ask for a scoped edit and go and read something else;
do not expect to iterate with it conversationally.

**One behaviour worth knowing.** If workspace retrieval puts the *wrong* files in
context, the model treats that context as the whole truth and answers "that file
does not exist" rather than calling `read_file` to check. Measured: 8 of 8
attempts failed that way when asked about "the function in `src/util.js`" with an
unrelated project in context, and 8 of 8 succeeded in the same condition when the
prompt named a file *and* a concrete change. Phrase agent tasks concretely.

## Seeing what it did

`Ctrl+Shift+P` → **Local Coder: Show Agent Audit Log**

Every tool call is recorded with its outcome — `allowed`, `denied`, `declined`,
or `invalid` — and the reason. Arguments are summarised; file **contents** are
never written to the log. The same lines appear live in the Local Coder output
channel.

## Before enabling command execution

Check the model can produce argv at all:

```powershell
.\scripts\Invoke-ModelBenchmark.ps1 `
  -RuntimePath <llama-server> -ModelPath <approved-gguf>
```

The `tool-call-argv-shape` task passes only for `{"command": ["npm", "test"]}`
and fails for a single shell string or an `sh -c` wrapper. A model that fails it
will find `allowlist` mode frustrating, because its commands will be rejected —
correctly.

The companion `edit-file-argument-shape` task does the same for writing: it
passes only for a `{"path", "old_text", "new_text"}` object whose `old_text`
carries enough surrounding context to be unique, and fails a one-word or
duplicated-line `old_text`. A model that fails it will hit the ambiguity refusal
constantly. Both are cheap screens for a model this repository has not measured;
the default profile passes both and is measured in
[AGENT_VALIDATION.md](AGENT_VALIDATION.md).

## Customising the command list

```json
{
  "localCoder.agent.mode": "allowlist",
  "localCoder.agent.allowedCommands": ["npm test", "npm run lint", "git status"]
}
```

This **replaces** the built-in defaults rather than extending them. Keep entries
as specific as the task allows: a rule of `git` would permit `git push`, since
prefix matching allows trailing arguments.

---

## Web access — off by default, and a deliberate reversal

Everything else in this extension runs locally and sends nothing. Web access is
the one capability that breaks that, so it is gated separately from every other
agent permission and starts disabled with an empty host list.

```json
{
  "localCoder.web.enabled": true,
  "localCoder.web.allowedHosts": ["docs.python.org", "developer.mozilla.org"],
  "localCoder.web.searchUrl": "https://your-internal-search/?q={query}"
}
```

### The risk, stated plainly

**The query is the exfiltration channel.** A model that can search can encode
workspace content into `?q=`, and no amount of filtering the *results* addresses
that. Everything below is aimed at the outbound side:

| Control | What it does |
|---|---|
| Off by default, separate setting | Reading your files does not imply permission to transmit |
| Empty allow-list by default | No wildcard and no "any host" value, so a half-finished setup reaches nothing |
| Audit **before** the request | Every query and URL is logged before it is sent, so a crash mid-flight still leaves the record |
| 300 characters, single line | A whole file cannot be smuggled into one query |
| Allow-list re-checked per redirect | An approved host cannot bounce the request somewhere else |
| HTTPS only, no credentials in URLs | |
| `confirm` mode prompts per request | The dialog names what is being sent and where |

These reduce and record the risk. **They do not eliminate it.** If the workstation
is meant to be sealed, leave this off — and prefer an internal documentation host
over a public search engine if you turn it on.

Read what was sent with **Local Coder: Show Agent Audit Log**; web calls are
recorded under a distinct `transmitted` outcome.

### What it cannot do

Fetched pages are neutralised and framed as `<web_result>` exactly like workspace
files, so a page cannot close its wrapper or issue instructions; scripts and
styles are stripped before the text is used. There is no wildcard host. There is
no HTTP.
