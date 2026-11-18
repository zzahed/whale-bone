# Whale Bone v0.0.1

Whale Bone is an open-source (MIT) AI coding assistant for VS Code. It works with **any OpenAI-compatible model API** and lives in the **Whale Bone** icon of the Activity Bar.

It is designed for networks that need a proxy: every request goes through Windows PowerShell, and you can turn the proxy on or off, choose its address, set the User-Agent, and authenticate with your Windows sign-in (computer authentication) or with a user name and password.

> **Preview release.** 0.0.1 is the first public version. Network features require Windows 10/11 with Windows PowerShell 5.1.

## Features

- **Chat with your workspace.** Ask questions, plan changes, or let the agent propose edits. The agent can `list`, `read` and `search` files in the one workspace you select.
- **Reviewed edits only.** Every proposed change opens in a VS Code diff. Nothing is written until you select **Apply and open file**.
- **Inline edit** (`Ctrl+Alt+Shift+I`): rewrite a selection or insert at the cursor, then Accept, Reject or Retry from CodeLens.
- **Optional Tab autocomplete**, off by default.
- **Model comparison**: ask two or three models the same question, read-only.
- **Secret redaction**: credential-like values are masked before any content is sent to the model, and protected files (`.env`, keys, and so on) are never read.
- **Per-workspace consent**: source code is sent only after you authorize the workspace for the configured endpoint.
- **Python (pip) and Node.js (npm) package managers** that use the same proxy settings through a local, loopback-only relay. No administrator rights or global configuration changes are needed.
- **Optional CI checks**: `scripts/ci-check.js` reviews a Git diff against rules in `.whalebone/checks/*.md`.

## Requirements

- VS Code 1.95 or later.
- Windows 10/11 with Windows PowerShell 5.1 for API, pip and npm traffic.
- An HTTPS, OpenAI-compatible API endpoint whose base URL ends in `/v1`, and an API key for it.

## Install

From the Marketplace, search for **Whale Bone**. Or, from a file, run **Extensions: Install from VSIX** and select `whale-bone-0.0.1.vsix`, then reload the window.

## Getting started

1. Select the **Whale Bone** icon in the Activity Bar, then **Choose workspace**.
2. Open **Settings → Connection & proxy**.
3. Enter the **API URL**, for example `https://your-provider.example/v1`, and select **Set API key**. Keys are kept in VS Code SecretStorage, one per endpoint.
4. Configure the proxy (see below), then select **Save settings** and **Test connection**.
5. Choose **Ask**, **Plan** or **Agent (Build)** and type your request. Authorize the workspace when asked.

## Proxy and network settings

| Setting | What it does |
|---|---|
| **Use a proxy** (`whaleBone.proxyEnabled`) | On by default. When off, requests go direct and the Windows system proxy is ignored. |
| **Proxy** (`whaleBone.proxyUrl`) | `host:port`. Leave empty to use the Windows system proxy. |
| **Proxy authentication** (`whaleBone.proxyAuth`) | `computer`: your Windows sign-in (NTLM/Kerberos). `user`: the user name below and a password. `none`: no proxy credentials. |
| **Proxy user name** (`whaleBone.proxyUsername`) | `user` or `DOMAIN\user`, for user authentication. |
| **Proxy password** | Set with **Set proxy password** or **Whale Bone: Set Proxy Password**. Stored in VS Code SecretStorage, never in settings. |
| **User-Agent** (`whaleBone.userAgent`) | Header sent with API and package requests. |
| **Authentication** (`whaleBone.authMode`) | Send the API key as `x-api-key` or as a `Bearer` token. |

These settings apply to the API transport, the pip and npm relays, and generated API connector scripts.

## Commands

All commands start with **Whale Bone:** in the Command Palette, including *Open Chat*, *Inline Edit*, *Set API Key*, *Set Proxy Password*, *Test API Connection*, *Authorize Workspace for AI Requests*, *Manage Python Packages* and *Manage npm Packages*.

## Security model

- Only the selected workspace is readable, and protected or linked files are refused.
- Credential-like values are redacted before they leave your machine. Redaction is best effort and does not replace DLP.
- The model cannot write files or run shell commands. Optional test commands are allowlisted, off by default, and need approval for every run.
- API keys and the proxy password stay in VS Code SecretStorage.

## Limitations

- No streamed tokens: a response appears once the request finishes.
- Windows only for network features, because the transport uses Windows PowerShell.
- Not an operating-system sandbox. Treat workspace content and model output as untrusted.

## More documentation

The extension includes `TROUBLESHOOTING.md`, `PYTHON-PACKAGES.md`, `PYTHON-OFFLINE.md`, `NPM-PACKAGES.md`, `CI-CHECKS.md` and `API-CONNECTORS.md`. **Whale Bone: Troubleshoot and Self-Check** opens the troubleshooting guide.

## Develop and test

Users need nothing beyond VS Code and Windows PowerShell. Contributors need Node.js 20 or later.

```
npm run check
npm test
npm run package
```

## License

MIT. See `LICENSE`. Provided "as is", without warranty of any kind.
