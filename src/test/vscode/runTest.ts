// ServerLens: runs the extension inside a real VS Code downloaded by @vscode/test-electron.
// CI runs it under xvfb on Linux for the minimum supported version (engines.vscode) and stable.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main(): Promise<void> {
    const extensionDevelopmentPath = path.resolve(__dirname, '..', '..', '..');
    const extensionTestsPath = path.resolve(__dirname, 'suite');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'serverlens-vscode-'));
    const workspace = path.join(scratch, 'workspace');
    fs.mkdirSync(workspace);
    const launchArgs = [
        workspace,
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--user-data-dir', path.join(scratch, 'user-data'),
        '--extensions-dir', path.join(scratch, 'extensions')
    ];
    if (process.platform === 'linux') {
        // Ubuntu 24.04 runners restrict unprivileged user namespaces, which Electron's sandbox needs.
        launchArgs.push('--no-sandbox', '--disable-gpu-sandbox');
    }
    try {
        await runTests({
            version: process.env.VSCODE_TEST_VERSION || 'stable',
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs,
            extensionTestsEnv: { SERVERLENS_TEST: '1', SERVERLENS_TEST_TMP: scratch }
        });
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
