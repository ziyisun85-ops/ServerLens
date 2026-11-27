// ServerLens: number formatting shared by the extension, the tests and the webviews.
// The functions are self-contained so that webview scripts can embed them with toString().
// Copyright 2026 ServerLens contributors. Licensed under the Apache License, Version 2.0.

export type ByteUnits = 'iec' | 'si';

/** Formats a byte count with three significant digits: 7.44 TiB, 560 GiB, 24 GiB. */
export function formatBytes(bytes: number, units: ByteUnits = 'iec'): string {
    const base = units === 'si' ? 1000 : 1024;
    const names = units === 'si' ? ['B', 'kB', 'MB', 'GB', 'TB', 'PB', 'EB'] : ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB'];
    if (!Number.isFinite(bytes)) {
        return '—';
    }
    const sign = bytes < 0 ? '-' : '';
    let value = Math.abs(bytes);
    let index = 0;
    while (value >= 1000 && index < names.length - 1) {
        value /= base;
        index += 1;
    }
    const digits = index === 0 ? String(Math.round(value)) : String(Number(value.toPrecision(3)));
    return sign + digits + ' ' + names[index];
}

/** Formats "used / total" and writes the unit once when both share it: "7.44 / 8 TiB". */
export function formatBytePair(used: number, total: number, units: ByteUnits = 'iec'): string {
    const left = formatBytes(used, units);
    const right = formatBytes(total, units);
    const leftUnit = left.split(' ')[1];
    const rightUnit = right.split(' ')[1];
    return leftUnit === rightUnit ? left.split(' ')[0] + ' / ' + right : left + ' / ' + right;
}

/** df-style percentage: rounded up, so 89.1 % shows as 90 % exactly like `df -h`. */
export function percentCeil(value: number): number {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }
    return Math.min(100, Math.ceil(value - 1e-9));
}

export type UsageLevel = 'ok' | 'warning' | 'critical';

/** Below warning is ok (green), warning up to critical is yellow, critical and above is red. */
export function usageLevel(percent: number, warning: number, critical: number): UsageLevel {
    if (percent >= critical) {
        return 'critical';
    }
    if (percent >= warning) {
        return 'warning';
    }
    return 'ok';
}

export function formatDurationSeconds(seconds: number): string {
    const value = Math.max(0, Math.round(seconds));
    const days = Math.floor(value / 86400);
    const hours = Math.floor(value % 86400 / 3600);
    const minutes = Math.floor(value % 3600 / 60);
    if (days) {
        return days + 'd ' + hours + 'h';
    }
    if (hours) {
        return hours + 'h ' + minutes + 'm';
    }
    if (minutes) {
        return minutes + 'm';
    }
    return value + 's';
}
