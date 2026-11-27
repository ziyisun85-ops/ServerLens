import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Expands a leading "~" (followed by "/" or "\\", or alone) to the home directory, the same way
 * for parsing and for `ssh -F`, which does not expand "~" itself.
 * Modified for ServerLens (2026): one resolver for the parser and the ssh arguments.
 */
export function resolveSshConfigPath(configPath: string): string {
    return /^~(?=$|[\\/])/.test(configPath) ? path.join(os.homedir(), configPath.slice(1)) : configPath;
}

/** The setting as one value for every reader: trimmed, and the default when empty or not a string. */
export function normalizeSshConfigPath(value: unknown): string {
    return typeof value === 'string' && value.trim() ? value.trim() : '~/.ssh/config';
}

export function sshConfigArguments(configPath?: unknown): string[] {
    const resolved = resolveSshConfigPath(normalizeSshConfigPath(configPath));
    return path.resolve(resolved) === path.join(os.homedir(), '.ssh', 'config') ? [] : ['-F', resolved];
}

export interface SshHost {
    host: string;
    hostname?: string;
    user?: string;
    identityFile?: string;
}

export class SshConfigParser {
    constructor() {}

    public parse(configPath: unknown): SshHost[] {
        const resolvedPath = this.resolveHome(normalizeSshConfigPath(configPath));
        if (!fs.existsSync(resolvedPath)) {
            return [];
        }

        const content = fs.readFileSync(resolvedPath, 'utf8');
        const lines = content.split('\n');
        const hosts: SshHost[] = [];
        let currentHosts: SshHost[] = [];

        for (let line of lines) {
            line = line.trim();
            if (!line || line.startsWith('#')) {
                continue;
            }

            // Keep quoted paths intact and discard comments outside quotes.
            const parts = line.match(/"[^"\n]*"|'[^'\n]*'|[^\s=#]+|#[^\n]*/g) || [];
            const tokens = parts.filter(part => !part.startsWith('#'))
                .map(part => part.replace(/^(["'])(.*)\1$/, '$2'));
            const key = tokens[0]?.toLowerCase();
            const value = tokens.slice(1).join(' ');

            if (key === 'host') {
                currentHosts = tokens.slice(1)
                    .filter(pattern => !/[*!?]/.test(pattern))
                    .map(host => ({ host }));
                hosts.push(...currentHosts);
            } else if (key === 'match') {
                currentHosts = [];
            } else {
                for (const currentHost of currentHosts) {
                    if (key === 'hostname' && currentHost.hostname === undefined) {
                        currentHost.hostname = value;
                    } else if (key === 'user' && currentHost.user === undefined) {
                        currentHost.user = value;
                    } else if (key === 'identityfile' && currentHost.identityFile === undefined) {
                        currentHost.identityFile = value;
                    }
                }
            }
        }

        return hosts;
    }

    private resolveHome(filepath: string): string {
        return resolveSshConfigPath(filepath);
    }
}
