> Open **Whale Bone → Settings → Python & pip → Manage Python packages (pip)**. The standalone VS Code command **Whale Bone: Manage Python Packages (Proxy-Aware pip)** remains available. The corporate authenticated PyPI transport helper is unchanged.

> The Python Packages workflow checks the selected workspace after dialog interactions. Changing the workspace cancels tracked pip listings and virtual-environment creation. Restart package operations after changing folders. The authenticated relay transport remains unchanged.

# Whale Bone: Python Packages

## Install packages from inside VS Code

Open **Settings → Python & pip → Manage Python packages (pip)** or run **Whale Bone: Manage Python Packages (Proxy-Aware pip)** from the Command Palette. Choose an interpreter. A workspace `.venv` is recommended and can be created from the same menu, without administrator privileges. Available actions:

- Install package, Upgrade package, Installed packages (with Upgrade and Uninstall).
- Install PEP 508 package names, version constraints, extras and environment markers from a workspace `requirements.txt`; workspace-local `-r` includes and SHA-256 `--hash` pins are supported.
- Download binary wheels and dependencies into `<workspace>/.whalebone/wheels`.
- Install the cached wheels offline with no access to an external index.
- Select a Python executable and test **Python localhost relay** (no internet) separately from authenticated PyPI connectivity.

Installing from a global interpreter uses the current user's site-packages (`--user`), not a system-wide install. The selected Python interpreter needs a working `pip`. Some distributions require `python -m ensurepip` in a virtual environment. This feature does not install Python itself.

## How it works

1. Pip runs as `selected-python -m pip --isolated --proxy= ...` with `PIP_CONFIG_FILE` set to the Python-specific null device, a fixed, shell-free argument list, no administrator rights, no custom `pip.conf` modifications, and package specifications validated before execution.
2. A temporary HTTP server binds only `127.0.0.1` on an ephemeral port and implements the PyPI Simple API. Pip performs **its normal dependency resolution** against this local index.
3. The server fetches allowed upstream pages from `https://pypi.org/simple/` and wheels from `https://files.pythonhosted.org/` through `ps/pypi-fetch.ps1`. This separate PowerShell 5.1 helper supplies the existing Whale Bone proxy URL, approved browser User-Agent and Windows-integrated proxy credentials. Python does not need to know the corporate proxy credentials.
4. Wheels retain their original names and hash fragments for pip compatibility. Files are streamed to temporary disk with per-object and session cache limits; no third-party Node packages or system proxy changes are needed.
5. Progress appears in VS Code and full pip output in **Output → Whale Bone: Python Packages**. Cancel aborts downloads and attempts to stop the pip process tree.

The API files `src/transport.js` and `ps/transport.ps1` are **not modified**. The local relay and its helper serve only Python package downloads, not AI requests.

## Constraints and limitations

- Requires **local Windows PowerShell 5.1**, an approved proxy allowing the PyPI hosts, and a working selected Python/pip interpreter. HTTPS certificates are verified using Windows TLS; no insecure verification bypass is used.
- Wheel-only installs (binary distributions). Packages requiring compilation or sdist installation are rejected with pip's normal no-matching-distribution error; this is intentional for no-admin enterprise environments. Windows x64, ARM64 and Python-version wheel availability is determined by pip.
- The requirements importer accepts normal PEP 508 package specifications, extras (including `pkg[a, b]`), version constraints with spaces, environment markers, `--hash=sha256:<64-hex-digits>` and local `-r` includes (maximum five levels). Each referenced file must remain within the trusted workspace; cycles, remote URLs, alternate index directives, editable/VCS dependencies and arbitrary pip options are rejected. Errors identify the source filename and line number.
- Files are limited to 1 MiB each and 2 MiB combined, at most 5,000 validated requirements (including local `-r` includes), 32 include files, and 16 SHA-256 hashes per requirement. Direct single-command package selections remain capped at 120. The importer flattens validated lines into a temporary manifest, invokes pip with `--requirement`, and deletes that manifest on completion. Pip enforces supplied hashes. If any requirement is hashed, pip can require all applicable requirements and dependencies to be pinned and hashed; an incomplete lockfile will fail rather than silently bypass hash checks.
- Only **public PyPI** and its official file host are supported by the built-in relay. A custom private index is not included in this release.
- The relay does not install pip or Python, and the Microsoft Python extension does not contain a Python interpreter.
- Package installations run package code. Use trusted packages. VS Code Workspace Trust must be enabled. The manager is independent of API consent and never transmits API keys or source to PyPI.
- The local integration suite verifies dependency resolution with fixture wheels without Internet. Windows PowerShell 5.1 and corporate-proxy behavior must still be tested on a real Windows host.

## Corporate acceptance test

1. Open a trusted local workspace in VS Code, then **Python Packages → Test authenticated PyPI connectivity**. Investigate 403, 407 or TLS errors in the package-manager Output channel.
2. Create `.venv` or select an existing Python 3.11+ interpreter, then install `requests`, and confirm it appears under Installed packages and imports in that same interpreter.
3. Download `requests` and its wheels for offline use. Disconnect internet access, install them into a fresh virtual environment from the cached wheelhouse, and confirm imports.
4. Verify cancel and retry. Test a binary-only package without compatible wheels and confirm pip reports a clear compatibility error.
5. Confirm the saved the AI endpoint key and model settings remain untouched and that VSIX deployment works without administrative access.

## PyPI relay diagnostics

If an install fails with `from versions: none`, **do not assume the package does not exist**. This message also appears when pip's local package index is unavailable. In Whale Bone, open **Settings → Python & pip → Manage Python packages (pip) → Test package index via proxy**, enter the package name (`pandas`, for example), and inspect **Output → Whale Bone: Python Packages**.

Whale Bone now reports failures from the upstream package index and wheel host, including HTTP 403/407, TLS, proxy sign-in HTML, and a bounded PyPI metadata size problem. Its Simple API metadata cap is 25 MB. The diagnostic checks that the index is accessible and contains package links, **not** that a specific version or Windows wheel is compatible. pip remains responsible for binary wheel matching and dependency resolution.

When diagnosing pandas on Python 3.13, verify interpreter architecture and version: `python -c "import sys,platform;print(sys.version);print(platform.architecture(),platform.machine())"`. Check official release files on https://pypi.org/project/pandas/3.1.1/ . If necessary, open the Python Packages output and share the **first `PyPI relay failure` line** with the maintainer; do not share any credentials. You may separately test approved proxy access to `https://pypi.org/simple/pandas/` and wheel downloads from `https://files.pythonhosted.org/` using Windows-integrated authentication and the same approved User-Agent.

The relay uses no permanent pip configuration changes, disables pip's unmanaged cache and retry delay, and uses the temporary, bounded local wheel cache for the operation. Its support for a specific corporate proxy still requires real Windows PowerShell 5.1 acceptance testing.

## Failure classification and security

- The local relay records how many index and artifact requests arrived. If pip fails before requesting the loopback index, the error points to pip startup or localhost access rather than guessing that PyPI has no matching wheels.
- Genuine 404 responses for missing project names are returned as 404 by the local relay. The extension reports **Package not found on public PyPI** instead of suggesting invalid proxy credentials. HTTP 403/407, TLS, proxy login HTML, and download errors still report explicit upstream failures.
- The real Windows/enterprise HTTP proxy must be tested on the target machine. A successful metadata test does not prove download-host accessibility. Use **Download wheels for offline use** for the second-stage check, then install into a `.venv`.
- The API transport files (`src/transport.js`, `ps/transport.ps1`) are unchanged. The corporate proxy URL and strict upstream allowlist have not been relaxed, and TLS verification remains enabled.

### Supported requirements examples

```text
requests >= 2.31
python-dateutil==4.0.0 ; python_version >= "3.9"
my-package[a, b] >= 1.2
-r base.txt
my-wheel==1.2.0 --hash=sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
```

The final hash is an illustrative placeholder, not a real approved checksum. Replace it with the authentic file SHA-256 when using hash enforcement. `-c`, `-e`, `--extra-index-url`, `git+...`, `https://...` and install-time execution options remain unsupported for safety.

## Windows localhost / NO_PROXY fix

The Python subprocess environment now forces `NO_PROXY` and `no_proxy` to `127.0.0.1,localhost,::1`, after clearing inherited external proxy and pip configuration variables. The exception applies only to the short-lived local pip relay, not to outgoing PowerShell PyPI downloads. On Windows, Python may consult registry proxy settings, so deleting `HTTP_PROXY` by itself was insufficient.

Before pip starts, the selected Python executable runs a short local `/simple/` request and verifies that the local relay responds correctly. If the test fails, Whale Bone now reports a Python-to-localhost failure before pip can give a misleading `from versions: none` error. To diagnose independently, use **Whale Bone → Python Packages → Test Python localhost relay**. A successful test proves local Python connectivity only. Follow with **Test package index via proxy** to test upstream metadata and **Download wheels for offline use** to test upstream artifacts.

If preflight succeeds but pip still sends zero relay requests, inspect endpoint-protection policy and selected pip startup. Whale Bone disables global/site pip.ini settings for managed pip subprocesses. The extension does not modify Windows system proxy settings, trust stores or firewall rules and does not disable TLS checks.

## Pip configuration isolation and credential redaction

- Pip `--isolated` alone does not suppress all global and interpreter-level pip configuration. Only Whale Bone managed subprocesses run with `PIP_CONFIG_FILE=os.devnull`, `--proxy=`, and an explicit localhost-only `--index-url`. Existing corporate Windows/proxy configuration is not modified; the PowerShell upstream fetch helper performs proxy authentication according to the Whale Bone proxy settings.
- This prevents `proxy`, `no-index`, `extra-index-url` and `find-links` from silently overriding the local relay. The test suite uses intentionally hostile pip configuration files in a Python 3.13 virtual environment and verifies no secondary index access. A system interpreter is tested with download-only operations, without installing into global site-packages.
- Context redaction covers inline JS object credentials, `db_pass`, leading diff `+`/`-` markers, and `web.config` `<add key="Password" value="..."/>` attributes, while preserving type declarations, references and configuration field names. It is best-effort, not a guarantee for arbitrary custom secret formats. Workspace permission, file exclusions and user review remain necessary.
- To verify: `cd extension`, `npm run check`, then set `PYTHON_FOR_TESTS` to an approved Python 3.13 interpreter and run `npm test` (no network access or permanent installs are required for tests).
- If the interpreter-level loopback check succeeds but pip still sends zero requests, the inherited pip configuration and forced proxy are now explicitly disabled; investigate endpoint security, the interpreter/pip installation and any startup customizations.

**Acceptance requirement:** Confirm `Cython==3.3.1` and a common wheel package install successfully on the actual corporate Windows machine. Synthetic relay tests do not validate the proxy's upstream TLS, authentication or artifact access.

## Integration and requirements safety

Cancellation refuses to spawn a Python process if the operation was already aborted. The requirements importer applies the same protected-file and symlink policy as ordinary workspace reads, so a local `-r` include cannot follow a symbolic link into `.env` or other excluded material.

The verification suite covers `pip --isolated --proxy=` with deliberately conflicting `proxy`, `extra-index-url`, `no-index`, and `find-links` values, including synthetic PyPI wheels on Python 3.13. Real Windows NTLM, SSL inspection, PowerShell 5.1, and package installation on your target computer remain mandatory acceptance checks.


### Workspace execution isolation

Managed pip, interpreter probing and venv creation now start from a private temporary working directory rather than repository root. This prevents a malicious `pip` or `venv` package in an open workspace being imported by `python -m ...`. Inherited `PYTHONPATH`, `PYTHONHOME`, startup and related Python environment hooks are cleared only for managed subprocesses. The approved interpreter and `.venv` installation destination are unchanged.


## Timeout handling for large or delayed wheel downloads

The authenticated local relay downloads a whole wheel through Windows-integrated PowerShell before returning wheel bytes to pip. The previous pip socket timeout of 150 seconds could expire while an enterprise proxy was still downloading or scanning a wheel. The managed pip timeout is now 600 seconds and the entire upstream retrieval, including bounded transient retries, must finish in 8 minutes. No PowerShell transport files or TLS verification settings have changed.

Monitor the `Whale Bone: Python Packages` Output channel while installing or downloading wheels. Lines prefixed `[PyPI relay]` show the wheel filename, attempt, elapsed time, transient failures, and completion. If it reports `Upstream download deadline exceeded`, the failure is between the extension's Windows-integrated upstream downloader and approved PyPI, not a missing Python package. Check enterprise proxy latency, authentication, content inspection and connectivity to `files.pythonhosted.org`. The separate `Test package index via proxy` only tests the metadata and does not validate wheel downloads.

Cancel a stalled operation through VS Code's progress notification. If corporate policy permits, use `Download wheels for offline use` and retry, or transfer a verified official wheel and dependencies into the workspace wheel cache for offline installation. Do not disable TLS certificate verification or bypass the approved proxy.

## Large requirements files

Select **Settings > Python & pip > Manage Python packages > Install requirements.txt**. Imports of 300+ entries are supported using a temporary validated manifest and `-r`; no 300-entry command-line argument list is created. You may include workspace-local `-r` files, PEP 508 markers, exact versions, and SHA-256 hashes. The importer rejects external paths, symlinks/hard links to protected data, executable pip options, and unapproved package URLs. A large installation has a bounded longer deadline of up to 120 minutes and supports cancellation.

If pip rejects a release, read **Output > Whale Bone: Python Packages** for the exact `ERROR: No matching distribution found for ...` line. The UI identifies the failing requirement rather than claiming every package in a large manifest lacks a wheel. pip still uses `--only-binary=:all:` for security. A package without a compatible wheel for the selected Python version and architecture cannot be installed via the managed relay. Changing this requires a separate security-reviewed source-build workflow; do not silently allow sdist build scripts.

Successful validation of PyPI package index links does not prove the pinned version or compatible wheel is available. Corporate NTLM proxy and on-device Windows testing remain required.


## Large requirements validation correction

The file importer accepts up to 1 MiB per requirements source file and up to 2 MiB combined across no more than 32 included files, subject to the 5,000 validated-requirement limit. Requirements files use a dedicated read mode; regular AI file reads and edits remain limited to 150 KB. Protected filenames, workspace containment, symbolic links and multi-linked hard files are still rejected. Files larger than 1 MiB and aggregate includes larger than 2 MiB are rejected.

If any requirement contains an SHA-256 `--hash`, all applicable requirements must also have exact version pins and hashes. The importer rejects wildcard or range version pins for hashed entries. Whale Bone reports missing direct hashes before the install starts and reminds the user that pip may also require explicit hashes for transitive dependencies. Wheel-only installation remains enabled.

Regression coverage includes importing 5,000 distinct package names, boundary sizes at 150 KB, 151 KB, 500 KB and 1 MiB, path/link protections, and an actual Python 3.13 pip installation of 305 distinct SHA-256-pinned wheels through a synthetic localhost PyPI index. Corporate PyPI/proxy behavior and your private requirements file remain unverified.
