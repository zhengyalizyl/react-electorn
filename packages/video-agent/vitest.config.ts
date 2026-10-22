import path from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        alias: [
            {
                find: /^@\//,
                replacement: `${path.resolve(__dirname, 'src')}/`
            }
        ]
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts']
    }
});
