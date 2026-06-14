.PHONY: build-PostApisFunction build-PostBgTasksFunction

build-PostApisFunction build-PostBgTasksFunction:
	rsync -av --exclude='.aws-sam' --exclude='node_modules' --exclude='.git' --exclude='*.log' . $(ARTIFACTS_DIR)/
	cd $(ARTIFACTS_DIR) && npm install --production
	cd $(ARTIFACTS_DIR)/bk-utils && npm install --production
