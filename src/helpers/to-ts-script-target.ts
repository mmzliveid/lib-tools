/**
 * @license
 * Copyright DagonMetric. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found under the LICENSE file in the root directory of this source tree.
 */

import { ScriptTarget } from 'typescript';

import { ScriptTargetString } from '../models';

export function toTsScriptTarget(target?: ScriptTargetString): ScriptTarget | undefined {
    switch (target) {
        case 'ES5':
        case 'es5':
            return ScriptTarget.ES5;
        case 'ES2015':
        case 'es2015':
            return ScriptTarget.ES2015;
        case 'ES2016':
        case 'es2016':
            return ScriptTarget.ES2016;
        case 'ES2017':
        case 'es2017':
            return ScriptTarget.ES2017;
        case 'ES2018':
        case 'es2018':
            return ScriptTarget.ES2018;
        case 'ES2019':
        case 'es2019':
            return ScriptTarget.ES2019;
        case 'ES2020':
        case 'es2020':
            return ScriptTarget.ES2020;
        case 'ESNext':
        case 'esnext':
            return ScriptTarget.ESNext;
        case 'Latest':
        case 'latest':
            return ScriptTarget.Latest;
        default:
            return undefined;
    }
}
