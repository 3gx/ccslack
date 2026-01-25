.PHONY: setup setup-tools verify-tools test test-watch test-coverage sdk-test all-test dev build start clean

# Install all dependencies
setup:
	npm install

# Install native tools/dependencies for Puppeteer and Sharp
setup-tools:
	@echo "Detecting OS and installing native dependencies..."
	@if [ "$$(uname)" = "Darwin" ]; then \
		echo "macOS detected - Puppeteer will auto-download Chromium"; \
		echo "No additional setup required."; \
	elif [ -f /etc/os-release ]; then \
		. /etc/os-release; \
		if [ "$$ID" = "ubuntu" ] || [ "$$ID" = "debian" ]; then \
			echo "$$ID $$VERSION_ID detected"; \
			if [ "$$(echo $$VERSION_ID | cut -d. -f1)" -ge 24 ] 2>/dev/null; then \
				echo "Installing dependencies for Ubuntu 24.04+..."; \
				sudo apt-get update && sudo apt-get install -y \
					libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 \
					libnss3 libnspr4 libcups2 libxss1 libxrandr2 libasound2t64 libatk1.0-0 \
					libatk-bridge2.0-0 libgtk-3-0 libgbm1 libpango-1.0-0 libpangocairo-1.0-0 \
					libcairo2 libfontconfig1 libdbus-1-3 libexpat1 libglib2.0-0; \
			else \
				echo "Installing dependencies for Ubuntu 22.04 and earlier..."; \
				sudo apt-get update && sudo apt-get install -y \
					libx11-xcb1 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 \
					libnss3 libnspr4 libcups2 libxss1 libxrandr2 libasound2 libatk1.0-0 \
					libatk-bridge2.0-0 libgtk-3-0 libgbm1 libpango-1.0-0 libpangocairo-1.0-0 \
					libcairo2 libfontconfig1 libdbus-1-3 libexpat1 libglib2.0-0; \
			fi; \
		else \
			echo "Unsupported Linux distribution: $$ID"; \
			echo "Please install Chromium dependencies manually."; \
			exit 1; \
		fi; \
	else \
		echo "Unknown OS. Please install dependencies manually."; \
		exit 1; \
	fi
	@echo "Done! Run 'make verify-tools' to verify installation."

# Verify native tools are installed
verify-tools:
	@echo "Verifying native dependencies..."
	@echo ""
	@echo "1. Checking Node.js..."
	@node --version || (echo "ERROR: Node.js not found" && exit 1)
	@echo "   OK"
	@echo ""
	@echo "2. Checking npm..."
	@npm --version || (echo "ERROR: npm not found" && exit 1)
	@echo "   OK"
	@echo ""
	@echo "3. Checking Puppeteer Chromium..."
	@CHROME_PATH=$$(find ~/.cache/puppeteer -name "chrome" -type f 2>/dev/null | head -1); \
	if [ -z "$$CHROME_PATH" ]; then \
		echo "   Chromium not yet downloaded (will download on first npm install)"; \
	else \
		echo "   Found: $$CHROME_PATH"; \
		if [ "$$(uname)" = "Linux" ]; then \
			MISSING=$$(ldd "$$CHROME_PATH" 2>/dev/null | grep "not found" || true); \
			if [ -n "$$MISSING" ]; then \
				echo "   ERROR: Missing libraries:"; \
				echo "$$MISSING"; \
				echo "   Run 'make setup-tools' to install missing dependencies."; \
				exit 1; \
			else \
				echo "   OK - All Chromium dependencies satisfied"; \
			fi; \
		else \
			echo "   OK"; \
		fi; \
	fi
	@echo ""
	@echo "4. Checking Sharp..."
	@node -e "require('sharp')" 2>/dev/null && echo "   OK" || echo "   Not installed (run 'npm install' first)"
	@echo ""
	@echo "All checks passed!"

# Run unit/mock tests (excludes live SDK tests)
# Configure parallel workers with JOBS=n (default 4)
JOBS ?= 4
test:
	npx vitest run --exclude='src/__tests__/sdk-live/**' --maxWorkers=$(JOBS)

# Run all tests (unit + live SDK)
all-test:
	npm run test:all

# Run tests in watch mode
test-watch:
	npm run test:watch

# Run tests with coverage
test-coverage:
	npm run test:coverage

# Run SDK live tests in parallel (default 1 workers, configure with SDKJOBS=n)
# Uses --silent to suppress console.log, 90s timeout
SDKJOBS ?= 4
sdk-test:
	npx vitest run src/__tests__/sdk-live/ --silent --testTimeout=90000 --maxWorkers=$(SDKJOBS)

# Development server
dev:
	npm run dev

# Build TypeScript
build:
	npm run build

# Start production server
start:
	npm run start

# Clean build artifacts
clean:
	rm -rf dist coverage
