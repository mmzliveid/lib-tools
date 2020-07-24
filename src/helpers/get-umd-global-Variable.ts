const dashCaseToCamelCase = (str: string) => str.replace(/-([a-z])/g, (g) => g[1].toUpperCase());

const predefinedGlobals: { [key: string]: string } = {
    moment: 'moment',
    tslib: 'tslib'
};

export function getUmdGlobalVariable(moduleId: string, globals: { [key: string]: string } = {}): string | undefined {
    let foundName = globals[moduleId];
    if (foundName) {
        return foundName;
    }

    foundName = predefinedGlobals[moduleId];
    if (foundName) {
        return foundName;
    }

    if (/@angular\/.+/.test(moduleId)) {
        const normalizedValue = moduleId.replace(/@angular\//, 'ng.').replace(/\//g, '.');
        return dashCaseToCamelCase(normalizedValue);
    }

    if (/rxjs\/.+/.test(moduleId)) {
        const normalizedValue = moduleId.replace(/\//g, '.');
        return dashCaseToCamelCase(normalizedValue);
    }

    if (/firebase\/.+/.test(moduleId)) {
        const normalizedValue = moduleId.replace(/\//g, '.');
        return dashCaseToCamelCase(normalizedValue);
    }

    return undefined;
}