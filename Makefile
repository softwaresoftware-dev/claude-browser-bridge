.PHONY: install dev build test test-manifest test-ext test-all

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
