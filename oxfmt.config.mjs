import appiumConfig, {defineConfig, ignorePatterns} from '@appium/oxc-config/oxfmt';

// lib/vendor is copied from the Appium Inspector as it is: keep its formatting
export default defineConfig({
  ...appiumConfig,
  ignorePatterns: [...ignorePatterns, 'lib/vendor/**', '**/*.log'],
});
