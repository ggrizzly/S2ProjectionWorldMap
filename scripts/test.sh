#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
for file in app.js projection-engine.js texture-worker.js view-state.js playwright.config.js; do
  node --check "$file"
done
npm run test:unit
npm run test:e2e
