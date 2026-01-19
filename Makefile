.PHONY: setup test test-watch test-coverage sdk-test all-test dev build start clean

# Install all dependencies
setup:
	npm install

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
