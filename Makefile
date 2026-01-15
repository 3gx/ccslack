.PHONY: test test-watch test-coverage dev build start clean

# Run tests
test:
	npm test

# Run tests in watch mode
test-watch:
	npm run test:watch

# Run tests with coverage
test-coverage:
	npm run test:coverage

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
