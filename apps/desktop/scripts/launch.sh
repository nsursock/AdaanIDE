#!/usr/bin/env bash
# Launch the Electron app, ensuring ELECTRON_RUN_AS_NODE is unset.
# (Some environments — e.g. VS Code terminals, Devin CLI — set this
# globally, which forces Electron into pure Node.js mode without the
# Electron API. We need it unset for the app to work.)
set -e

cd "$(dirname "$0")/.."

# Unset ELECTRON_RUN_AS_NODE for the electron process only
env -u ELECTRON_RUN_AS_NODE npx electron .
