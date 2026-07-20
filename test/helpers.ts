import { ConfigStore, RunnerConfig, ScriptEntry, ScriptInfo } from '../src/model';

/** Build a ScriptInfo for tests; only the fields used by order.ts matter. */
export function makeScript(pkgRelDir: string, name: string, extra: Partial<ScriptInfo> = {}): ScriptInfo {
    return {
        id: `${pkgRelDir}#${name}`,
        name,
        command: `echo ${name}`,
        pkgRelDir,
        pkgDir: `/abs/${pkgRelDir}`,
        packageName: pkgRelDir || 'root',
        workspaceFolder: undefined as never,
        ...extra,
    };
}

/** In-memory ConfigStore replacement: load/save against a plain object. */
export class FakeStore {
    config: RunnerConfig;
    saves = 0;

    constructor(initial: RunnerConfig = { scripts: {} }) {
        this.config = clone(initial);
    }

    async load(): Promise<RunnerConfig> {
        return clone(this.config);
    }

    async save(config: RunnerConfig): Promise<void> {
        this.saves++;
        this.config = clone(config);
    }

    entry(id: string): ScriptEntry | undefined {
        return this.config.scripts[id];
    }
}

/** Cast the fake to the real type for functions that only call load/save. */
export const asStore = (s: FakeStore): ConfigStore => s as unknown as ConfigStore;

function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
}
