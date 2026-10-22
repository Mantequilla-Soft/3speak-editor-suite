// Frontend unit tests (npm test). Backend tests run on their own: cd backend && npm test.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
  },
})
