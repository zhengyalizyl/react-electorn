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
        include: ['tests/**/*.test.ts'],
        // 真素材的 ffprobe/抽帧要 spawn 进程，默认 5s 在冷启动时不够
        testTimeout: 30_000,
        hookTimeout: 60_000
    }
});
