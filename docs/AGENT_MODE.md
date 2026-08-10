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
- **Write anything.** There is no write, move, or delete tool. The default
  command list contains nothing that installs, pushes, or reaches the network.
- **Run forever.** The loop is capped by `localCoder.agent.maxSteps` (default 8).
  Hitting the cap is reported as such, not dressed up as a finished answer.
- **Escape its own output.** Tool results re-enter the prompt and are neutralized
  exactly like any other untrusted workspace text, so a file cannot close the
  wrapper and address the model as though it were the extension.

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
