import appiumConfig, {defineConfig, ignorePatterns} from '@appium/oxc-config/oxlint';

export default defineConfig({
  extends: [appiumConfig],
  ignorePatterns: [...ignorePatterns, 'lib/vendor/**'],
  overrides: [
    {
      files: ['test/**/*.js'],
      plugins: ['vitest'],
      env: {vitest: true},
    },
    {
      files: ['ui/**/*.js'],
      env: {browser: true},
    },
  ],
});
