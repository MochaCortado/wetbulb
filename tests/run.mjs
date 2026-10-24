// Browser test suites for Heat Plan. Each suite returns [{name, pass, detail}].
import { wbgtSuite } from './wbgt.test.mjs';
import { guidanceSuite } from './guidance.test.mjs';
import { planSuite } from './plan.test.mjs';

export const suites = [wbgtSuite, guidanceSuite, planSuite];
