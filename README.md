<p align="center">
  <img src="media/whale-bone.png" alt="Whale Bone logo" width="120">
</p>

# Whale Bone v0.0.1

<p align="center">
  <b>Your AI coding helper inside VS Code.</b><br>
  Works with <b>any OpenAI-compatible AI service</b>, even behind a company proxy.
</p>

<p align="center">
  <a href="https://github.com/zzahed/whale-bone/releases"><img alt="Release" src="https://img.shields.io/github/v/release/zzahed/whale-bone?include_prereleases&label=release&color=0a7bbb"></a>
  <a href="https://github.com/zzahed/whale-bone/blob/main/LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-green"></a>
  <img alt="VS Code 1.95 or later" src="https://img.shields.io/badge/VS%20Code-1.95%2B-007ACC">
  <img alt="Network features: Windows" src="https://img.shields.io/badge/network-Windows%2010%20%7C%2011-0078D6">
  <img alt="Status: preview" src="https://img.shields.io/badge/status-preview-orange">
</p>

<p align="center">
  <a href="#-install-in-1-minute">Install</a> ·
  <a href="#-first-steps">First steps</a> ·
  <a href="#-proxy-setup-made-simple">Proxy setup</a> ·
  <a href="#-how-it-keeps-you-safe">Safety</a> ·
  <a href="#-questions-and-answers">Q&amp;A</a>
</p>

---

## 🐋 What is Whale Bone?

Whale Bone is a free, open-source extension for **Visual Studio Code**. You ask a question in plain words, and an AI model helps you **understand, fix and write code** in your project.

- You choose the AI service. Whale Bone talks to any service that speaks the OpenAI API.
- **You stay in control.** The AI suggests changes, and **you approve every one** before it touches a file.
- **It works in strict company networks.** It can use your proxy with your Windows sign-in, or with a user name and password.

> 💡 **Version 0.0.1 is a preview.** All network traffic goes through Windows PowerShell 5.1, which Windows already includes. So talking to the AI service and the pip and npm helpers need **Windows 10 or 11**.

---

## ✨ What you can do

| | Feature | In simple words |
|---|---|---|
| 💬 | **Chat** | Ask about your project. Choose **Ask** for answers, **Plan** for a step-by-step plan, or **Agent (Build)** to get code changes. |
| 🔍 | **Review before apply** | Every change opens side by side (a "diff"). Nothing is saved until you click **Apply and open file**. |
| ✏️ | **Inline edit** | Select some code, press <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>I</kbd>, and say what to change. Then choose Accept, Reject or Retry. |
| ⚡ | **Tab autocomplete** | Ghost text while you type. Press <kbd>Tab</kbd> to accept. **Off** until you turn it on. |
| ⚖️ | **Compare models** | Ask two or three AI models the same question and compare the answers. |
| 🧪 | **Explain, review, test** | Explain a selection, review selected code, or generate unit tests. |
| 🐍 | **Python packages** | Install, upgrade and remove pip packages through your proxy. No admin rights needed. |
| 📦 | **npm packages** | Run npm installs through your proxy, with package scripts turned off for safety. |
| 🔒 | **Secret masking** | Passwords, tokens and keys are hidden **before** anything is sent to the AI. |
| ✅ | **CI checks** (optional) | Check pull requests against your own written rules. |

---

## 📥 Install in 1 minute

1. Download **`whale-bone-0.0.1.vsix`** from the [Releases page](https://github.com/zzahed/whale-bone/releases).
2. In VS Code, open the Command Palette (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>) and run **Extensions: Install from VSIX…**
3. Pick the file you downloaded, then reload VS Code.

You will see the 🐋 **Whale Bone** icon in the Activity Bar on the left.

> Whale Bone is not on the Visual Studio Marketplace yet.

**You need:**

- ✔️ VS Code 1.95 or newer
- ✔️ An AI service with an OpenAI-compatible API. Its address ends with `/v1`, for example `https://your-provider.example/v1`.
- ✔️ An API key for that service
- ✔️ Windows 10 or 11 to send requests to the AI service

---

## 🚀 First steps

**1. Open Whale Bone.** Click the 🐋 icon, then **Choose workspace** and pick your project folder.

**2. Connect your AI service.** Go to **Settings → Connection & proxy**:

   - Type your **API URL**, for example `https://your-provider.example/v1`.
   - Click **Set API key** and paste your key. It is saved safely in VS Code, not in your settings file.
   - Pick the **Authentication** your service uses: `x-api-key` or `Bearer token`.

**3. Set up the proxy,** if your network uses one. See [Proxy setup made simple](#-proxy-setup-made-simple).

**4. Save and test.** Click **Save settings**, then **Test connection**. You should see "API connected".

**5. Ask something.** Go to the **Chat** tab, pick **Ask**, and try:

> *"Explain what this project does and where to start."*

The first time, Whale Bone asks you to **authorize the workspace**, so you decide which project may be sent to the AI.

---

## 🌐 Proxy setup made simple

Find your situation in the table below and use those settings.

| Your network | Use a proxy | Proxy address | Proxy authentication |
|---|---|---|---|
| 🏠 No proxy (home, most cloud setups) | ☐ Off | — | — |
| 🏢 Company proxy that Windows already knows | ☑ On | *leave empty* | **Computer (Windows sign-in)** |
| 🏢 Company proxy with a known address | ☑ On | `proxy.company.com:8080` | **Computer (Windows sign-in)** |
| 🔑 Proxy that needs a separate user name | ☑ On | `proxy.company.com:8080` | **User name and password** |
| 🌍 Open proxy (no sign-in) | ☑ On | `proxy.example.com:3128` | **None** |

**What each option means:**

- **Use a proxy**: when this is off, Whale Bone connects directly and also ignores the Windows proxy.
- **Proxy address**: write `host:port`. Leave it empty to use the proxy that Windows already uses.
- **Computer (Windows sign-in)**: uses your current Windows account automatically (NTLM or Kerberos). You don't type a password.
- **User name and password**: type the **Proxy user name** (`name` or `DOMAIN\name`), then click **Set proxy password**. The password is kept in VS Code's secure storage, never in your settings.
- **None**: sends no proxy credentials.

The same proxy settings are used everywhere: AI requests, Python packages, npm packages and generated connector scripts.

> 🛠️ **Still blocked?** Some companies also check the browser name a program reports (the "User-Agent"). You can change it under **Settings → Connection & proxy → User-Agent**.

---

## 🛡️ How it keeps you safe

| Promise | What it means for you |
|---|---|
| **You approve every change** | The AI can only *suggest* changes. You review each one before it is saved. |
| **One project at a time** | The AI can only read the workspace you chose. Linked files and files outside it are blocked. |
| **Secrets are masked** | Values that look like passwords, tokens or keys become `[REDACTED]` before sending. Files like `.env` are never read. |
| **Your permission first** | Code is sent only after you authorize the workspace for that AI address. |
| **No hidden commands** | The AI cannot run shell commands. Test runs are off by default, and each run needs your OK. |
| **Keys stay private** | API keys and the proxy password live in VS Code's secure storage. |

> ⚠️ Secret masking is a strong safety net, but it can't catch everything. Don't send code you are not allowed to share.

---

## ⚙️ Settings at a glance

Open them in the Whale Bone **Settings** tab, or in VS Code settings by searching for `whaleBone`.

| Setting | Default | What it does |
|---|---|---|
| `whaleBone.baseUrl` | *(empty)* | Your AI service address, ending with `/v1` |
| `whaleBone.authMode` | `x-api-key` | How the API key is sent: `x-api-key` or `bearer` |
| `whaleBone.model` | `openai/gpt-oss-120b` | The model name to use |
| `whaleBone.proxyEnabled` | `true` | Turn the proxy on or off |
| `whaleBone.proxyUrl` | *(empty)* | Proxy `host:port`; empty means the Windows proxy |
| `whaleBone.proxyAuth` | `computer` | `computer`, `user` or `none` |
| `whaleBone.proxyUsername` | *(empty)* | Proxy user name for `user` sign-in |
| `whaleBone.userAgent` | Chrome-style | Browser name sent with requests |
| `whaleBone.timeoutSeconds` | `180` | How long to wait for an answer (10–900) |
| `whaleBone.autocomplete.enabled` | `false` | Tab autocomplete on or off |
| `whaleBone.agent.tools` | `read-only` | `approved-tests` lets the agent ask to run tests |
| `whaleBone.reviewOutbound` | `false` | Show exactly what will be sent before every request |

---

## ⌨️ Useful commands

Open the Command Palette (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>) and type **Whale Bone**:

| Command | Use it to… |
|---|---|
| **Open Chat** | Open the Whale Bone side panel |
| **Inline Edit (Review Before Apply)** | Change selected code right in the editor |
| **Explain Selected Code Only** | Get a plain-words explanation of a selection |
| **Review Selected Code** | Get a quick code review |
| **Generate Unit Tests (Review Before Apply)** | Create tests for your code |
| **Set API Key** / **Set Proxy Password** | Save your secrets safely |
| **Test API Connection** | Check that everything is connected |
| **Manage Python Packages** / **Manage Node.js and npm Packages** | Install packages through your proxy |
| **Troubleshoot and Self-Check** | Find and fix common problems |

---

## ❓ Questions and answers

<details>
<summary><b>"Set the API URL" message?</b></summary>

Enter your AI service address in **Settings → Connection & proxy → API URL**. It must start with `https://` and end with `/v1`.
</details>

<details>
<summary><b>HTTP 401 or 403 from the AI service?</b></summary>

Check the API key (**Set API key**) and the **Authentication** type. Some services want `Bearer token`, others want `x-api-key`.
</details>

<details>
<summary><b>HTTP 407 (proxy authentication required)?</b></summary>

Your proxy wants a sign-in. Try **Computer (Windows sign-in)** first. If that fails, choose **User name and password**, enter your user name, and click **Set proxy password**.
</details>

<details>
<summary><b>Connection times out?</b></summary>

Check the proxy address. Try turning **Use a proxy** off and on again, or leave the address empty to use the Windows proxy. You can also raise **Request timeout** in **Model & generation**.
</details>

<details>
<summary><b>Does it work on macOS or Linux?</b></summary>

The extension loads, but requests to the AI service and the package helpers use Windows PowerShell, so those need Windows for now.
</details>

<details>
<summary><b>Is my code sent anywhere?</b></summary>

Only to the AI address **you** set, and only after you authorize the workspace. Secrets are masked first. Turn on **Review full outbound AI context** to see every request before it goes out.
</details>

More help is in **Whale Bone: Troubleshoot and Self-Check** and in `TROUBLESHOOTING.md`.

---

## 📚 More guides

| Guide | Topic |
|---|---|
| `TROUBLESHOOTING.md` | Fixing common problems |
| `PYTHON-PACKAGES.md` | The pip package manager |
| `PYTHON-OFFLINE.md` | Installing the Python extension |
| `NPM-PACKAGES.md` | The npm package manager |
| `CI-CHECKS.md` | AI checks for pull requests |
| `API-CONNECTORS.md` | Generating scripts for other APIs |

---

## 🧰 For contributors

You only need **Node.js 20 or newer**.

```bash
npm run check     # check that every file parses
npm test          # run the test suite
npm run package   # build the .vsix file
```

**To make a release:** update `version` in `package.json`, add a note to `CHANGELOG.md`, then push a tag such as `v0.0.2`. GitHub Actions builds the `.vsix` and attaches it to a new release.

Issues and pull requests are welcome on [GitHub](https://github.com/zzahed/whale-bone/issues).

---

## ⚠️ Good to know

- Answers appear when they are complete. They are not streamed word by word.
- The AI service, the proxy and the pip/npm helpers need Windows for now.
- Whale Bone is not a sandbox. Treat your project files and AI answers with normal care.

---

## 📄 License

**MIT**: free to use, change and share. See [`LICENSE`](LICENSE).

<p align="center"><sub>Made with 🐋 for developers who work behind proxies.</sub></p>
