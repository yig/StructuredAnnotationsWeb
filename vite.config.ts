import { defineConfig } from 'vitest/config';

export default defineConfig( {
    // Relative asset paths, so the built site works from any directory (e.g. GitHub Pages).
    base: './',
    test: {
        include: [ 'test/**/*.test.ts' ],
        testTimeout: 60000,
    },
} );
