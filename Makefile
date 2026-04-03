.PHONY: install dev build

install:
	npm install

build:
	node esbuild.config.js

dev:
	node server/index.js
