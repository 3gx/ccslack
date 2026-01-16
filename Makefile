.PHONY: test test-watch test-coverage sdk-test all-test dev build start clean

# Run unit/mock tests (excludes live SDK tests)
test:
	npm test

# Run all tests (unit + live SDK)
all-test:
	npm run test:all

# Run tests in watch mode
test-watch:
	npm run test:watch

# Run tests with coverage
test-coverage:
	npm run test:coverage

# Run SDK live tests in parallel (default 8 workers, configure with JOBS=n)
JOBS ?= 8
sdk-test:
	npx vitest run src/__tests__/sdk-live/ --reporter=verbose --maxWorkers=$(JOBS)

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
