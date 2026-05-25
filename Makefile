.PHONY: install dev build test test-manifest test-ext test-all verify-versions publish

install:
	npm install

build:
	node esbuild.config.js

dev:
	node server/index.js

test: test-manifest

test-manifest:
	python3 -m pytest tests/test_manifest.py -v

test-ext:
	node tests/extension/test-runner.js
	node tests/extension/test-runner-r2.js
	node tests/extension/test-observe-a11y.js

test-all: test-manifest test-ext

# Single source of truth: plugin.json. Refuses if package.json drifts.
verify-versions:
	@PKG=$$(node -p "require('./package.json').version"); \
	PLG=$$(node -p "require('./.claude-plugin/plugin.json').version"); \
	if [ "$$PKG" != "$$PLG" ]; then \
	  echo "VERSION MISMATCH: package.json=$$PKG plugin.json=$$PLG"; \
	  exit 1; \
	fi; \
	echo "versions consistent: $$PLG"

# End-to-end publish gate. Refuses on dirty tree, mismatched versions, failing
# tests, or unpushed commits. Tags + pushes. Reminds the operator about the
# steps that can't be automated from inside this repo.
publish: verify-versions build test-all
	@VERSION=$$(node -p "require('./.claude-plugin/plugin.json').version"); \
	if [ -n "$$(git status --porcelain)" ]; then \
	  echo "tree is dirty — commit before publishing"; git status --short; exit 1; \
	fi; \
	if [ -n "$$(git log @{u}.. 2>/dev/null)" ]; then \
	  echo "you have unpushed commits — push first"; exit 1; \
	fi; \
	if git rev-parse "v$$VERSION" >/dev/null 2>&1; then \
	  echo "tag v$$VERSION already exists — bump the version first"; exit 1; \
	fi; \
	echo "tagging v$$VERSION"; \
	git tag "v$$VERSION"; \
	git push origin "v$$VERSION"; \
	echo ""; \
	echo "=========================================="; \
	echo "Published v$$VERSION to origin."; \
	echo ""; \
	echo "Still TODO (manual, cross-repo):"; \
	echo "  1. Update marketplace.json in softwaresoftware-marketplace to v$$VERSION, commit + push"; \
	echo "  2. Update static sites if features/description changed:"; \
	echo "     - staticsites/claude-browser-bridge.softwaresoftware.dev/"; \
	echo "     - staticsites/mcps.softwaresoftware.dev/"; \
	echo "     Deploy via /liteframe:deploy"; \
	echo "  3. Smoke-test the install flow on a clean profile."; \
	echo "=========================================="
