import js from '@eslint/js';
import globals from 'globals';
import importSort from 'eslint-plugin-simple-import-sort';
import prettier from 'eslint-plugin-prettier';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const ignoredPaths = [
    '**/*/coverage/**/*',
    '**/*/build/**/*',
    '**/*/es/**/*',
    '**/*/dist/**/*',
    '**/*/out/**/*',
    'apps/server/app/generated/**/*',
    '**/.vite/**/*',
    'apps/desktop/forge.config.ts',
    'apps/desktop/vite.*.config.ts',
    'apps/desktop/vitest.config.ts',
    'packages/*/vitest.config.ts'
];

const sortRules = {
    'simple-import-sort/imports': [
        'error',
        {
            groups: [
                ['^\\w'],
                ['^@\\w'],
                ['^@/'],
                ['^\\u0000'],
                ['^\\.\\.(?!/?$)', '^\\.\\./?$'],
                ['^\\./(?=.*/)(?!/?$)', '^\\.(?!/?$)', '^\\./?$']
            ]
        }
    ],
    'simple-import-sort/exports': 'error'
};

const typedTsFiles = tseslint.config({
    files: ['**/*.{ts,tsx}'],
    ignores: ignoredPaths,
    rules: {
        '@typescript-eslint/array-type': 'error',
        '@typescript-eslint/no-for-in-array': 'error',
        '@typescript-eslint/no-explicit-any': 'off',
        'no-undef': 'warn',
        'no-console': 'error',
        ...sortRules,
        'prettier/prettier': 'error'
    },
    languageOptions: {
        parser: tseslint.parser,
        globals: {
            ...globals.browser,
            ...globals.node,
            MAIN_WINDOW_VITE_DEV_SERVER_URL: 'readonly',
            MAIN_WINDOW_VITE_NAME: 'readonly',
            magicutAPI: 'readonly',
            // preload 里用到 Electron.IpcRendererEvent 这个全局命名空间
            Electron: 'readonly'
        },
        parserOptions: {
            project: ['**/*/tsconfig.json'],
            tsconfigRootDir: import.meta.dirname
        }
    },
    plugins: { 'simple-import-sort': importSort, prettier }
});

const reactFiles = tseslint.config({
    files: ['**/*.tsx'],
    ignores: ignoredPaths,
    rules: {
        ...react.configs.flat.recommended.rules,
        ...react.configs.flat['jsx-runtime'].rules,
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'warn',
        ...sortRules,
        'prettier/prettier': 'error',
        'react/prop-types': 'off'
    },
    settings: {
        react: {
            version: 'detect'
        }
    },
    languageOptions: {
        parser: tseslint.parser,
        parserOptions: {
            ecmaFeatures: {
                jsx: true
            },
            project: ['**/*/tsconfig.json'],
            tsconfigRootDir: import.meta.dirname
        },
        globals: {
            ...globals.browser,
            ...globals.node
        }
    },
    plugins: {
        react,
        'react-hooks': reactHooks,
        'simple-import-sort': importSort,
        prettier
    }
});

const configFiles = tseslint.config({
    files: [
        'apps/desktop/*config.ts',
        'apps/desktop/vitest.config.ts',
        'packages/*/vitest.config.ts'
    ],
    languageOptions: {
        parser: tseslint.parser,
        globals: {
            ...globals.node
        }
    },
    rules: {
        'no-console': 'error',
        'prettier/prettier': 'error'
    },
    plugins: { prettier }
});

export default tseslint.config(
    // **全局忽略**：flat config 里，带 `files` 的配置对象上的 `ignores`
    // 只对那个对象生效。构建产物必须在这里挡掉，否则 eslint 会去解析
    // 打包后的 main.js（几万行，还带着上游包里的 eslint-disable 指令）。
    { ignores: ignoredPaths },
    {
        extends: [js.configs.recommended, ...tseslint.configs.recommended],
        ignores: ignoredPaths,
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node
            }
        }
    },
    typedTsFiles,
    reactFiles,
    configFiles
);
