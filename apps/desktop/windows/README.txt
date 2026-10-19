dubvibe_mini Windows x64

Extract the full ZIP, then run dubvibe_mini.exe. Supports Windows 10 22H2 / Windows 11 x64.
Requires the Microsoft Edge WebView2 Evergreen Runtime; if it is missing, the launcher offers the Microsoft download page.
Node, Python 3.12, uv, FFmpeg, and sentence-split data ship inside the bundle, so first run works on machines
without them and without calling the usual download sites. The first launch still installs the Python runtime
dependencies (torch and friends) and prepares models. Model downloads can be skipped during first run and
installed later in Settings under Local models.

Data, models, and configuration: %LOCALAPPDATA%\dubvibe_mini
Logs: %LOCALAPPDATA%\dubvibe_mini\logs\desktop.log
Custom data directory: DUBVIBE_MINI_DESKTOP_DATA_DIR environment variable.
Translation API keys are stored in Windows Credential Manager.

Upgrade: quit dubvibe_mini, extract the new ZIP to a new folder, and run its dubvibe_mini.exe.
Keep the data folder above; never run old and new versions against the same data folder at once.
This portable bundle is not Authenticode signed.

Alternative install: the -setup.exe from the same release installs to
%LOCALAPPDATA%\Programs\dubvibe_mini, creates Start Menu and Desktop shortcuts,
and registers an entry under Apps & features with a working uninstaller.
Models and data stay in %LOCALAPPDATA%\dubvibe_mini either way.

Source and install instructions: (local only)
