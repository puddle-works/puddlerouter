include puddle.mk

.PHONY: test test-repo
test: ## Run the extension tests, then the hook and workflow tests
	$(DENO) test --allow-read --allow-write extensions/models/
	$(MAKE) test-repo

test-repo: ## Run the hook tests (against a fake swamp) and workflow checks
	$(DENO) test --allow-read --allow-write --allow-run --allow-env hooks/ tests/
