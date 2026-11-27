// ServerLens: minimal logging interface shared by the extension and the tests.
// Copyright 2026 ServerLens contributors. Licensed under the Apache License, Version 2.0.

export interface Logger {
    debug(message: string): void;
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
}

export const nullLogger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined
};

/**
 * Removes anything that must never reach logs or the UI: private key blocks, control
 * characters and overly long text. ssh runs with BatchMode, so no password is ever typed,
 * but stderr is still treated as untrusted remote/local text.
 */
export function sanitizeDiagnostic(text: string, maxLength = 400): string {
    const withoutKeys = text.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, '[private key removed]');
    const printable = withoutKeys
        .replace(/\r/g, '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .join(' | ');
    return printable.length > maxLength ? printable.slice(0, maxLength - 1) + '…' : printable;
}

/**
 * Makes remote text safe for VS Code notifications, which turn `[label](command:...)` into
 * clickable links. A zero-width space after every `]` keeps the text readable but breaks the
 * link syntax, so a mount point or error message from a server cannot become a command link.
 */
export function plainText(text: string): string {
    return String(text).replace(/\]/g, ']\u200b');
}

