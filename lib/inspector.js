/**
 * The parts of the Appium Inspector this plugin runs on the server: locator generation, source
 * parsing and the client-framework code generators. They are copied into lib/vendor/inspector from
 * https://github.com/appium/appium-inspector (Apache-2.0); see lib/vendor/inspector/README.md.
 */
import {CLIENT_FRAMEWORKS} from './vendor/inspector/constants/session-inspector.js';
import DotNetNUnitFramework from './vendor/inspector/lib/client-frameworks/dotnet-nunit.js';
import JavaJUnit4Framework from './vendor/inspector/lib/client-frameworks/java-junit4.js';
import JavaJUnit5Framework from './vendor/inspector/lib/client-frameworks/java-junit5.js';
import JsOxygenFramework from './vendor/inspector/lib/client-frameworks/js-oxygen.js';
import JsWdIoFramework from './vendor/inspector/lib/client-frameworks/js-wdio.js';
import PythonFramework from './vendor/inspector/lib/client-frameworks/python.js';
import RobotFramework from './vendor/inspector/lib/client-frameworks/robot.js';
import RubyFramework from './vendor/inspector/lib/client-frameworks/ruby.js';

export {getSuggestedLocators} from './vendor/inspector/utils/locator-generation/common.js';
export {xmlToJSON} from './vendor/inspector/utils/source-parsing.js';

export const CLIENT_FRAMEWORK_MAP = {
  [CLIENT_FRAMEWORKS.DOTNET_NUNIT]: DotNetNUnitFramework,
  [CLIENT_FRAMEWORKS.JS_WDIO]: JsWdIoFramework,
  [CLIENT_FRAMEWORKS.JS_OXYGEN]: JsOxygenFramework,
  [CLIENT_FRAMEWORKS.JAVA_JUNIT4]: JavaJUnit4Framework,
  [CLIENT_FRAMEWORKS.JAVA_JUNIT5]: JavaJUnit5Framework,
  [CLIENT_FRAMEWORKS.PYTHON]: PythonFramework,
  [CLIENT_FRAMEWORKS.ROBOT]: RobotFramework,
  [CLIENT_FRAMEWORKS.RUBY]: RubyFramework,
};
