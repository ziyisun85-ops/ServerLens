// ServerLens: reads the serverlens.* configuration in one place.
// Copyright 2026 ServerLens contributors. Licensed under the Apache License, Version 2.0.
import * as vscode from 'vscode';
import { DEFAULT_HIDDEN_FS_TYPES, DEFAULT_HIDDEN_MOUNT_PATTERNS, DiskFilters, entriesForHost } from './diskMetrics';
import { ByteUnits } from './format';
import { MonitorConfig } from './monitorService';

export const SECTION = 'serverlens';

export type UiLanguage = 'en' | 'zh-CN';

export interface ViewSettings {
    compactLayout: boolean;
    showUtilization: boolean;
    showTemperature: boolean;
    showPower: boolean;
    showFanSpeed: boolean;
    showProcesses: boolean;
    showHostHealth: boolean;
    availabilityRequireNoProcesses: boolean;
    availabilityMaxMemoryMiB: number;
    availabilityMaxUtilization: number;
    memoryWarningThreshold: number;
    temperatureWarningThreshold: number;
    powerWarningThreshold: number;
    diskWarningThreshold: number;
    diskCriticalThreshold: number;
    byteUnits: ByteUnits;
}

export interface DiskAlertSettings {
    level: 'off' | 'warning' | 'critical';
    warning: number;
    critical: number;
}

export interface StorageSettings {
    paths: string[];
    depth: number;
    timeoutSeconds: number;
}

export function configuration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration(SECTION);
}

/** Reads a list setting; hand-edited values that are not arrays of strings count as empty. */
export function stringList(config: vscode.WorkspaceConfiguration, key: string): string[] {
    const value = config.get<unknown>(key);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function clamp(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}

export function uiLanguage(): UiLanguage {
    const configured = configuration().get<string>('language', 'auto');
    if (configured === 'zh-CN' || configured === 'en') {
        return configured;
    }
    return vscode.env.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

export function diskThresholds(config = configuration()): { warning: number; critical: number } {
    const warning = clamp(config.get<number>('diskWarningThreshold'), 1, 100, 70);
    const critical = clamp(config.get<number>('diskCriticalThreshold'), 1, 100, 90);
    return { warning: Math.min(warning, critical), critical: Math.max(warning, critical) };
}

export function readViewSettings(config = configuration()): ViewSettings {
    const disk = diskThresholds(config);
    return {
        compactLayout: config.get<boolean>('compactLayout', true),
        showUtilization: config.get<boolean>('showUtilization', true),
        showTemperature: config.get<boolean>('showTemperature', true),
        showPower: config.get<boolean>('showPower', true),
        showFanSpeed: config.get<boolean>('showFanSpeed', true),
        showProcesses: config.get<boolean>('showProcesses', true),
        showHostHealth: config.get<boolean>('showHostHealth', true),
        availabilityRequireNoProcesses: config.get<boolean>('availabilityRequireNoProcesses', true),
        availabilityMaxMemoryMiB: config.get<number>('availabilityMaxMemoryMiB', 512),
        availabilityMaxUtilization: config.get<number>('availabilityMaxUtilization', 10),
        memoryWarningThreshold: config.get<number>('memoryWarningThreshold', 85),
        temperatureWarningThreshold: config.get<number>('temperatureWarningThreshold', 80),
        powerWarningThreshold: config.get<number>('powerWarningThreshold', 90),
        diskWarningThreshold: disk.warning,
        diskCriticalThreshold: disk.critical,
        byteUnits: config.get<string>('byteUnits', 'iec') === 'si' ? 'si' : 'iec'
    };
}

export function diskFilters(host: string, config = configuration()): DiskFilters {
    const showAll = config.get<boolean>('showAllFilesystems', false);
    return {
        hiddenFsTypes: [...(showAll ? [] : DEFAULT_HIDDEN_FS_TYPES), ...entriesForHost(stringList(config, 'hiddenFilesystemTypes'), host)],
        hiddenMountPatterns: [...(showAll ? [] : DEFAULT_HIDDEN_MOUNT_PATTERNS), ...entriesForHost(stringList(config, 'hiddenMounts'), host)],
        pinnedPaths: entriesForHost(stringList(config, 'pinnedMounts'), host).filter(path => path.startsWith('/') || path.startsWith('~'))
    };
}

export function readMonitorConfig(hosts: string[], config = configuration()): MonitorConfig {
    const showProcesses = config.get<boolean>('showProcesses', true);
    return {
        hosts,
        autoRefresh: config.get<boolean>('autoRefresh', true),
        pauseWhenHidden: config.get<boolean>('pauseWhenHidden', true),
        intervals: {
            gpu: clamp(config.get<number>('refreshInterval'), 2, 300, 5),
            cpu: clamp(config.get<number>('cpuRefreshInterval'), 2, 300, 5),
            memory: clamp(config.get<number>('memoryRefreshInterval'), 2, 300, 5),
            disk: clamp(config.get<number>('diskRefreshInterval'), 10, 3600, 60)
        },
        slurmIntervalSeconds: clamp(config.get<number>('slurmRefreshInterval'), 5, 300, 30),
        sshTimeoutSeconds: clamp(config.get<number>('sshTimeout'), 2, 60, 8),
        maxConcurrentHosts: clamp(config.get<number>('maxConcurrentHosts'), 1, 32, 8),
        gpuProcesses: showProcesses || config.get<boolean>('availabilityRequireNoProcesses', true),
        processOwners: showProcesses || Boolean(config.get<string>('researchUser', '')),
        slurm: showProcesses && config.get<boolean>('enableSlurmIntegration', true),
        quota: config.get<boolean>('showQuota', true),
        diskFilters: host => diskFilters(host, config)
    };
}

export function diskAlertSettings(config = configuration()): DiskAlertSettings {
    const level = config.get<string>('diskAlerts', 'critical');
    const thresholds = diskThresholds(config);
    return { level: level === 'off' || level === 'warning' ? level : 'critical', ...thresholds };
}

export function storageSettings(config = configuration()): StorageSettings {
    return {
        paths: stringList(config, 'storagePaths').filter(item => item.trim()),
        depth: clamp(config.get<number>('storageScanDepth'), 1, 4, 2),
        timeoutSeconds: clamp(config.get<number>('storageScanTimeout'), 10, 600, 60)
    };
}
