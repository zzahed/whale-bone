# Installing the Python extension

Whale Bone does not ship the Microsoft Python extension. **Settings → Python & pip → Install Python extension** asks VS Code to install `ms-python.python` from the Extensions Marketplace. It does not install a Python interpreter.

The Python extension declares companion extensions in its `extensionPack` metadata, for example:

- `ms-python.vscode-pylance`, language analysis and completions
- `ms-python.debugpy`, Python debugging
- `ms-python.vscode-python-envs`, interpreter and environment features

## Offline or proxy-restricted machines

If the Marketplace is not reachable, obtain the Python extension and the companions you need from an approved distribution source, in versions compatible with your VS Code, and install each one with **Extensions: Install from VSIX**. Install a Python interpreter separately, then select it with VS Code's **Python: Select Interpreter** command.

Whale Bone itself remains usable without these extensions for editing non-Python files and asking questions. Running Python tests requires a real Python interpreter. Whale Bone never downloads or runs these extensions without your action.

The **Python Packages** manager installs pip wheels through the configured proxy and supports offline wheel caching. See `PYTHON-PACKAGES.md`. It does not provide a Python interpreter or VS Code companion extensions.
