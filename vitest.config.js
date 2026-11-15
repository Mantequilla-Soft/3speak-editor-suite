// Frontend unit tests (npm test). Backend tests run on their own: cd backend && npm test.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // JSX like the app's build (@vitejs/plugin-react): components can be rendered in tests
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/**/*.test.js'],
    environment: 'node',
  },
})
