import js from '@eslint/js'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default defineConfig([
	{ ignores: ['dist/', 'coverage/'] },
	js.configs.recommended,
	tseslint.configs.recommended,
	{
		languageOptions: { globals: globals.node },
		rules: {
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-empty-object-type': 'off',
			// The non-null assertion operator is useful in some cases, e.g., when working with Maps.
			'@typescript-eslint/no-non-null-assertion': 'off',
			// The void type is useful for a variable that will be assigned the result of a function that returns void.
			'@typescript-eslint/no-invalid-void-type': 'off',
			// This one's just annoying
			'@typescript-eslint/ban-ts-comment': 'off',
		},
	},
])
