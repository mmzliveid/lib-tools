import { ProjectBuildConfigInternal } from '../../../models/internals';
import { LogLevelString, Logger } from '../../../utils';

export interface ProjectBuildInfoWebpackPluginOptions {
    projectBuildConfig: ProjectBuildConfigInternal;
    logLevel?: LogLevelString;
}

export class ProjectBuildInfoWebpackPlugin {
    private readonly logger: Logger;

    get name(): string {
        return 'project-build-info-webpack-plugin';
    }

    constructor(private readonly options: ProjectBuildInfoWebpackPluginOptions) {
        this.logger = new Logger({
            logLevel: this.options.logLevel || 'info'
        });
    }

    apply(): void {
        const msg = `Building ${this.options.projectBuildConfig._projectName}`;
        this.logger.info(msg);
    }
}
