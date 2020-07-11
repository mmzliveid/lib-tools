import * as path from 'path';

import { pathExists, readFile } from 'fs-extra';
import { ModuleKind, ScriptTarget } from 'typescript';

import {
    ModuleExternalsEntry,
    ScriptBundleEntry,
    ScriptBundleModuleKind,
    ScriptCompilationEntry,
    ScriptTargetString
} from '../models';
import {
    BuildActionInternal,
    ScriptBundleEntryInternal,
    ScriptCompilationEntryInternal,
    ScriptOptionsInternal,
    TsConfigInfo
} from '../models/internals';
import { findUp, isInFolder, isSamePaths, normalizePath } from '../utils';

import { parseTsJsonConfigFileContent } from './parse-ts-json-config-file-content';
import { readTsConfigFile } from './read-ts-config-file';
import { toTsScriptTarget } from './to-ts-script-target';

export async function prepareScripts(buildAction: BuildActionInternal, auto?: boolean): Promise<ScriptOptionsInternal> {
    const workspaceRoot = buildAction._workspaceRoot;
    const projectRoot = buildAction._projectRoot;
    const projectName = buildAction._projectName;

    const scriptCompilations: ScriptCompilationEntryInternal[] = [];
    const scriptBundles: ScriptBundleEntryInternal[] = [];
    let tsConfigPath: string | null = null;
    let tsConfigInfo: TsConfigInfo | null = null;

    if (buildAction.script && buildAction.script.tsConfig) {
        tsConfigPath = path.resolve(projectRoot, buildAction.script.tsConfig);
        if (!tsConfigPath) {
            throw new Error(
                `The tsConfig file ${tsConfigPath} doesn't exist. Please correct value in 'projects[${projectName}].actions.build.script.tsConfig'.`
            );
        }
    } else if (buildAction.script || auto) {
        tsConfigPath = await detectTsConfigPath(workspaceRoot, projectRoot);
    }

    if (tsConfigPath) {
        const tsConfigJson = readTsConfigFile(tsConfigPath);
        const tsCompilerConfig = parseTsJsonConfigFileContent(tsConfigPath);
        tsConfigInfo = {
            tsConfigPath,
            tsConfigJson,
            tsCompilerConfig
        };
    }

    const entryNameRel = await detectEntryName(buildAction, tsConfigInfo);

    if (buildAction.script && buildAction.script.compilations) {
        if (!tsConfigPath || !tsConfigInfo) {
            throw new Error(
                `Typescript configuration file could not be detected automatically. Please set it manually in 'projects[${projectName}].actions.build.script.tsConfig'.`
            );
        }

        if (!entryNameRel) {
            throw new Error(
                `The entry file could not be detected automatically. Please set it manually in 'projects[${projectName}].actions.build.script.entry'.`
            );
        }

        for (const scriptCompilationEntry of buildAction.script.compilations) {
            const scriptCompilationEntryInternal = toScriptCompilationEntryInternal(
                scriptCompilationEntry,
                entryNameRel,
                tsConfigInfo,
                buildAction
            );
            scriptCompilations.push(scriptCompilationEntryInternal);
        }
    } else if (
        entryNameRel &&
        tsConfigPath &&
        tsConfigInfo &&
        tsConfigInfo.tsCompilerConfig.options.target &&
        tsConfigInfo.tsCompilerConfig.options.target >= ScriptTarget.ES2015 &&
        (buildAction.script || auto)
    ) {
        if (tsConfigInfo.tsCompilerConfig.options.target > ScriptTarget.ES2015) {
            const esSuffix =
                tsConfigInfo.tsCompilerConfig.options.target >= ScriptTarget.ESNext
                    ? 'Next'
                    : `${2013 + tsConfigInfo.tsCompilerConfig.options.target}`;

            const esmScriptCompilationEntry = toScriptCompilationEntryInternal(
                {
                    target: `es${esSuffix}` as ScriptTargetString,
                    outDir: `esm${esSuffix}`,
                    declaration: true
                },
                entryNameRel,
                tsConfigInfo,
                buildAction
            );
            scriptCompilations.push(esmScriptCompilationEntry);
        } else {
            const esmScriptCompilationEntry = toScriptCompilationEntryInternal(
                {
                    target: 'es2015',
                    outDir: 'esm2015',
                    declaration: true
                },
                entryNameRel,
                tsConfigInfo,
                buildAction
            );
            scriptCompilations.push(esmScriptCompilationEntry);
        }

        const esm5ScriptCompilationEntry = toScriptCompilationEntryInternal(
            {
                target: 'es5',
                outDir: 'esm5',
                declaration: false
            },
            entryNameRel,
            tsConfigInfo,
            buildAction
        );
        scriptCompilations.push(esm5ScriptCompilationEntry);
    }

    if (buildAction.script && buildAction.script.bundles) {
        for (const bundleEntry of buildAction.script.bundles) {
            const bundleEntryInternal = toBundleEntryInternal(bundleEntry, tsConfigInfo, buildAction);
            scriptBundles.push(bundleEntryInternal);
        }
    }

    let bannerText: string | null = null;
    if (buildAction.script && buildAction.script.banner) {
        bannerText = await prepareBannerText(buildAction.script.banner, buildAction);
    }

    return {
        ...buildAction.script,
        _tsConfigInfo: tsConfigInfo,
        _entryNameRel: entryNameRel,
        _bannerText: bannerText,
        _compilations: scriptCompilations,
        _bundles: scriptBundles
    };
}

function toScriptCompilationEntryInternal(
    compilationEntry: ScriptCompilationEntry,
    entryNameRel: string,
    tsConfigInfo: TsConfigInfo,
    buildAction: BuildActionInternal
): ScriptCompilationEntryInternal {
    const tsConfigPath = tsConfigInfo.tsConfigPath;
    const tsCompilerConfig = tsConfigInfo.tsCompilerConfig;
    const compilerOptions = tsCompilerConfig.options;

    // scriptTarget
    let scriptTarget: ScriptTarget = ScriptTarget.ES2015;
    if (compilationEntry.target) {
        scriptTarget = toTsScriptTarget(compilationEntry.target);
    } else if (compilerOptions.target) {
        scriptTarget = compilerOptions.target;
    }

    // declaration
    let declaration = true;
    if (compilationEntry.declaration != null) {
        declaration = compilationEntry.declaration;
    }

    // tsOutDir
    let tsOutDir: string;
    let customTsOutDir: string | null = null;
    if (compilationEntry.outDir) {
        tsOutDir = path.resolve(buildAction._outputPath, compilationEntry.outDir);
        customTsOutDir = tsOutDir;
    } else {
        if (compilerOptions.outDir) {
            tsOutDir = path.isAbsolute(compilerOptions.outDir)
                ? path.resolve(compilerOptions.outDir)
                : path.resolve(path.dirname(tsConfigPath), compilerOptions.outDir);
        } else {
            tsOutDir = buildAction._outputPath;
            customTsOutDir = tsOutDir;
        }
    }

    if (compilerOptions.rootDir && !isSamePaths(compilerOptions.rootDir, path.dirname(tsConfigPath))) {
        const relSubDir = isInFolder(compilerOptions.rootDir, path.dirname(tsConfigPath))
            ? normalizePath(path.relative(compilerOptions.rootDir, path.dirname(tsConfigPath)))
            : normalizePath(path.relative(path.dirname(tsConfigPath), compilerOptions.rootDir));
        tsOutDir = path.resolve(tsOutDir, relSubDir);
    }

    let bundleEntry: ScriptBundleEntryInternal | null = null;
    if (
        compilationEntry.esmBundle ||
        (compilationEntry.esmBundle !== false &&
            scriptTarget >= ScriptTarget.ES5 &&
            compilerOptions.module &&
            compilerOptions.module >= ModuleKind.ES2015)
    ) {
        const entryFilePath = path.resolve(tsOutDir, `${entryNameRel}.js`);
        const esSuffix = ScriptTarget[scriptTarget].replace(/^ES/i, '');
        const fesmFolderName = `fesm${esSuffix}`;
        const outFileName = buildAction._packageNameWithoutScope.replace(/\//gm, '-');
        const bundleOutFilePath = path.resolve(buildAction._outputPath, fesmFolderName, `${outFileName}.js`);

        bundleEntry = {
            libraryTarget: 'esm',
            _entryFilePath: entryFilePath,
            _outputFilePath: bundleOutFilePath
        };
    } else if (compilationEntry.umdBundle || compilationEntry.cjsBundle) {
        const entryFilePath = path.resolve(tsOutDir, `${entryNameRel}.js`);
        const outFileName = buildAction._packageNameWithoutScope.replace(/\//gm, '-');
        const libraryTarget: ScriptBundleModuleKind = compilationEntry.cjsBundle ? 'cjs' : 'umd';
        const bundleOutFilePath = path.resolve(buildAction._outputPath, `bundles/${outFileName}.${libraryTarget}.js`);

        bundleEntry = {
            libraryTarget,
            _entryFilePath: entryFilePath,
            _outputFilePath: bundleOutFilePath
        };
    }

    // Add  entry points to package.json
    if (buildAction.script == null || (buildAction.script && buildAction.script.addToPackageJson !== false)) {
        if (declaration) {
            if (buildAction._nestedPackage) {
                // TODO: To check
                buildAction._packageJsonEntryPoint.typings = normalizePath(
                    path.relative(
                        buildAction._packageJsonOutDir,
                        path.join(buildAction._outputPath, `${entryNameRel}.d.ts`)
                    )
                );
            } else {
                buildAction._packageJsonEntryPoint.typings = `${entryNameRel}.d.ts`;
            }
        }

        const jsEntryFile = normalizePath(
            `${path.relative(buildAction._packageJsonOutDir, path.resolve(tsOutDir, entryNameRel))}.js`
        );

        if (
            compilerOptions.module &&
            compilerOptions.module >= ModuleKind.ES2015 &&
            scriptTarget > ScriptTarget.ES2015
        ) {
            let esYear: string;
            if (scriptTarget === ScriptTarget.ESNext) {
                if (compilerOptions.module === ModuleKind.ES2020 || compilerOptions.module === ModuleKind.ESNext) {
                    esYear = '2020';
                } else {
                    esYear = '2015';
                }
            } else {
                esYear = `${2013 + scriptTarget}`;
            }

            buildAction._packageJsonEntryPoint[`es${esYear}`] = jsEntryFile;
            if (!buildAction._packageJsonEntryPoint.module) {
                buildAction._packageJsonEntryPoint.module = jsEntryFile;
            }

            if (esYear === '2015') {
                // (Angular) It is deprecated as of v9, might be removed in the future.
                buildAction._packageJsonEntryPoint[`esm${esYear}`] = jsEntryFile;
            }
        } else if (
            compilerOptions.module &&
            compilerOptions.module >= ModuleKind.ES2015 &&
            scriptTarget === ScriptTarget.ES2015
        ) {
            buildAction._packageJsonEntryPoint.es2015 = jsEntryFile;
            if (!buildAction._packageJsonEntryPoint.module) {
                buildAction._packageJsonEntryPoint.module = jsEntryFile;
            }

            // (Angular) It is deprecated as of v9, might be removed in the future.
            buildAction._packageJsonEntryPoint.esm2015 = jsEntryFile;
        } else if (
            compilerOptions.module &&
            compilerOptions.module >= ModuleKind.ES2015 &&
            scriptTarget === ScriptTarget.ES5
        ) {
            buildAction._packageJsonEntryPoint.esm5 = jsEntryFile;
            buildAction._packageJsonEntryPoint.module = jsEntryFile;
        } else if (compilerOptions.module === ModuleKind.UMD || compilerOptions.module === ModuleKind.CommonJS) {
            buildAction._packageJsonEntryPoint.main = jsEntryFile;
        }

        if (bundleEntry != null) {
            const jsEntryFileForBundle = normalizePath(
                path.relative(buildAction._packageJsonOutDir, bundleEntry._outputFilePath)
            );

            if (bundleEntry.libraryTarget === 'esm') {
                if (
                    compilerOptions.module &&
                    compilerOptions.module >= ModuleKind.ES2015 &&
                    scriptTarget > ScriptTarget.ES2015
                ) {
                    let esYear: string;
                    if (scriptTarget === ScriptTarget.ESNext) {
                        if (
                            compilerOptions.module === ModuleKind.ES2020 ||
                            compilerOptions.module === ModuleKind.ESNext
                        ) {
                            esYear = '2020';
                        } else {
                            esYear = '2015';
                        }
                    } else {
                        esYear = `${2013 + scriptTarget}`;
                    }

                    buildAction._packageJsonEntryPoint[`fesm${esYear}`] = jsEntryFileForBundle;
                    buildAction._packageJsonEntryPoint[`es${esYear}`] = jsEntryFileForBundle;
                    if (!buildAction._packageJsonEntryPoint.module) {
                        buildAction._packageJsonEntryPoint.module = jsEntryFileForBundle;
                    }
                } else if (
                    compilerOptions.module &&
                    compilerOptions.module >= ModuleKind.ES2015 &&
                    scriptTarget === ScriptTarget.ES2015
                ) {
                    buildAction._packageJsonEntryPoint.fesm2015 = jsEntryFileForBundle;
                    buildAction._packageJsonEntryPoint.es2015 = jsEntryFileForBundle;
                    if (!buildAction._packageJsonEntryPoint.module) {
                        buildAction._packageJsonEntryPoint.module = jsEntryFileForBundle;
                    }
                } else if (
                    compilerOptions.module &&
                    compilerOptions.module >= ModuleKind.ES2015 &&
                    scriptTarget === ScriptTarget.ES5
                ) {
                    buildAction._packageJsonEntryPoint.fesm5 = jsEntryFileForBundle;
                    buildAction._packageJsonEntryPoint.module = jsEntryFileForBundle;
                }
            } else {
                buildAction._packageJsonEntryPoint.main = jsEntryFileForBundle;
            }
        }
    }

    return {
        ...compilationEntry,
        _scriptTarget: scriptTarget,
        _declaration: declaration,
        _tsOutDirRootResolved: tsOutDir,
        _customTsOutDir: customTsOutDir,
        _bundle: bundleEntry
    };
}

async function detectTsConfigPath(workspaceRoot: string, projectRoot: string): Promise<string | null> {
    return findUp(
        ['tsconfig.build.json', 'tsconfig-build.json', 'tsconfig.lib.json', 'tsconfig-lib.json', 'tsconfig.json'],
        projectRoot,
        workspaceRoot
    );
}

async function detectEntryName(
    buildAction: BuildActionInternal,
    tsConfigInfo: TsConfigInfo | null
): Promise<string | null> {
    if (buildAction.script && buildAction.script.entry) {
        return normalizePath(buildAction.script.entry).replace(/\.(ts|js)$/i, '');
    }

    const flatModuleOutFile =
        tsConfigInfo &&
        tsConfigInfo.tsConfigJson.angularCompilerOptions &&
        tsConfigInfo.tsConfigJson.angularCompilerOptions.flatModuleOutFile
            ? tsConfigInfo.tsConfigJson.angularCompilerOptions.flatModuleOutFile
            : null;
    if (flatModuleOutFile) {
        return flatModuleOutFile.replace(/\.js$/i, '');
    }

    if (tsConfigInfo) {
        const tsSrcRootDir = path.dirname(tsConfigInfo.tsConfigPath);

        if (await pathExists(path.resolve(tsSrcRootDir, 'index.ts'))) {
            return 'index';
        }

        const packageName =
            buildAction._packageNameWithoutScope.lastIndexOf('/') > -1
                ? buildAction._packageNameWithoutScope.substr(buildAction._packageNameWithoutScope.lastIndexOf('/') + 1)
                : buildAction._packageNameWithoutScope;
        if (await pathExists(path.resolve(tsSrcRootDir, packageName + '.ts'))) {
            return packageName;
        }

        if (await pathExists(path.resolve(tsSrcRootDir, 'main.ts'))) {
            return 'main';
        }

        if (await pathExists(path.resolve(tsSrcRootDir, 'public_api.ts'))) {
            return 'public_api';
        }

        if (await pathExists(path.resolve(tsSrcRootDir, 'public-api.ts'))) {
            return 'public-api';
        }
    }

    return null;
}

function toBundleEntryInternal(
    bundleEntry: ScriptBundleEntry,
    tsConfigInfo: TsConfigInfo | null,
    buildAction: BuildActionInternal
): ScriptBundleEntryInternal {
    const scriptOptions = buildAction._script || {};

    if (!scriptOptions.entry) {
        throw new Error(
            `The entry file could not be detected automatically. Please set it manually in 'projects[${buildAction._projectName}].actions.build.script.entry'.`
        );
    }

    const projectRoot = buildAction._projectRoot;
    const entryFilePath = path.resolve(projectRoot, scriptOptions.entry);
    const currentBundleEntry = { ...bundleEntry };

    // externals
    if (currentBundleEntry.externals == null && scriptOptions.externals) {
        currentBundleEntry.externals = JSON.parse(JSON.stringify(scriptOptions.externals)) as ModuleExternalsEntry[];
    }

    // dependenciesAsExternals
    if (currentBundleEntry.dependenciesAsExternals == null && scriptOptions.dependenciesAsExternals != null) {
        currentBundleEntry.dependenciesAsExternals = scriptOptions.dependenciesAsExternals;
    }

    // peerDependenciesAsExternals
    if (currentBundleEntry.peerDependenciesAsExternals == null && scriptOptions.peerDependenciesAsExternals != null) {
        currentBundleEntry.peerDependenciesAsExternals = scriptOptions.peerDependenciesAsExternals;
    }

    // includeCommonJs
    if (currentBundleEntry.includeCommonJs == null && scriptOptions.includeCommonJs != null) {
        currentBundleEntry.includeCommonJs = scriptOptions.includeCommonJs;
    }

    // outputFilePath
    let bundleOutFilePath = '';
    if (currentBundleEntry.outputFilePath) {
        bundleOutFilePath = path.resolve(buildAction._outputPath, currentBundleEntry.outputFilePath);
        if (!/\.js$/i.test(bundleOutFilePath)) {
            bundleOutFilePath = path.resolve(bundleOutFilePath, `${path.parse(entryFilePath).name}.js`);
        }
    } else {
        bundleOutFilePath = path.resolve(buildAction._outputPath, `${path.parse(entryFilePath).name}.js`);
    }

    // Add  entry points to package.json
    if (buildAction.script == null || (buildAction.script && buildAction.script.addToPackageJson !== false)) {
        const jsEntryFileForBundle = normalizePath(path.relative(buildAction._packageJsonOutDir, bundleOutFilePath));
        const compilerOptions = tsConfigInfo?.tsCompilerConfig.options;
        const scriptTarget = compilerOptions?.target;
        const moduleKind = compilerOptions?.module;

        if (bundleEntry.libraryTarget === 'esm') {
            if (moduleKind && moduleKind >= ModuleKind.ES2015 && scriptTarget && scriptTarget > ScriptTarget.ES2015) {
                let esYear: string;
                if (scriptTarget === ScriptTarget.ESNext) {
                    if (moduleKind === ModuleKind.ES2020 || moduleKind === ModuleKind.ESNext) {
                        esYear = '2020';
                    } else {
                        esYear = '2015';
                    }
                } else {
                    esYear = `${2013 + scriptTarget}`;
                }

                buildAction._packageJsonEntryPoint[`fesm${esYear}`] = jsEntryFileForBundle;
                buildAction._packageJsonEntryPoint[`es${esYear}`] = jsEntryFileForBundle;
                if (!buildAction._packageJsonEntryPoint.module) {
                    buildAction._packageJsonEntryPoint.module = jsEntryFileForBundle;
                }
            } else if (
                moduleKind &&
                moduleKind >= ModuleKind.ES2015 &&
                scriptTarget &&
                scriptTarget === ScriptTarget.ES2015
            ) {
                buildAction._packageJsonEntryPoint.fesm2015 = jsEntryFileForBundle;
                buildAction._packageJsonEntryPoint.es2015 = jsEntryFileForBundle;
                if (!buildAction._packageJsonEntryPoint.module) {
                    buildAction._packageJsonEntryPoint.module = jsEntryFileForBundle;
                }
            } else if (moduleKind && moduleKind >= ModuleKind.ES2015 && scriptTarget === ScriptTarget.ES5) {
                buildAction._packageJsonEntryPoint.fesm5 = jsEntryFileForBundle;
                buildAction._packageJsonEntryPoint.module = jsEntryFileForBundle;
            } else {
                buildAction._packageJsonEntryPoint.module = jsEntryFileForBundle;
            }
        } else {
            buildAction._packageJsonEntryPoint.main = jsEntryFileForBundle;
        }
    }

    return {
        ...currentBundleEntry,
        _entryFilePath: entryFilePath,
        _outputFilePath: bundleOutFilePath
    };
}

async function prepareBannerText(banner: string, buildAction: BuildActionInternal): Promise<string> {
    let bannerText = banner;

    if (/\.txt$/i.test(bannerText)) {
        const bannerFilePath = await findUp(bannerText, buildAction._projectRoot, buildAction._workspaceRoot);
        if (bannerFilePath) {
            bannerText = await readFile(bannerFilePath, 'utf-8');
        } else {
            throw new Error(
                `The banner text file: ${path.resolve(
                    buildAction._projectRoot,
                    bannerText
                )} doesn't exist. Correct value in 'projects[${buildAction._projectName}].scriptBundle.banner'.`
            );
        }
    }

    if (!bannerText) {
        return bannerText;
    }

    bannerText = addCommentToBanner(bannerText);
    bannerText = bannerText.replace(/[$|[]CURRENT[_-]?YEAR[$|\]]/gim, new Date().getFullYear().toString());
    bannerText = bannerText.replace(/[$|[](PROJECT|PACKAGE)[_-]?NAME[$|\]]/gim, buildAction._packageName);
    bannerText = bannerText.replace(/[$|[](PROJECT|PACKAGE)?[_-]?VERSION[$|\]]/gim, buildAction._packageVersion);
    bannerText = bannerText.replace(/0\.0\.0-PLACEHOLDER/i, buildAction._packageVersion);

    return bannerText;
}

function addCommentToBanner(banner: string): string {
    if (banner.trim().startsWith('/')) {
        return banner;
    }

    const commentLines: string[] = [];
    const bannerLines = banner.split('\n');
    for (let i = 0; i < bannerLines.length; i++) {
        if (bannerLines[i] === '' || bannerLines[i] === '\r') {
            continue;
        }

        const bannerText = bannerLines[i].trim();
        if (i === 0) {
            commentLines.push('/**');
        }
        commentLines.push(` * ${bannerText}`);
    }
    commentLines.push(' */');
    banner = commentLines.join('\n');

    return banner;
}
