// ServerLens: decides when to notify about full disks and GPU state changes. The trackers are
// free of the VS Code API so they can be unit-tested; extension.ts shows the notifications.
// GPU transitions are moved here from GPU Fleet Viewer's dashboard (gpuView.ts notifyTransitions).
// Copyright 2026 ServerLens contributors. Licensed under the Apache License, Version 2.0.
import { numberValue, ServerStatus } from './fleetModel';
import { usageLevel } from './format';

export interface KeyValueStore {
    get<T>(key: string, fallback: T): T;
    update(key: string, value: unknown): Thenable<void> | Promise<void>;
}

export interface DiskAlert {
    key: string;
    host: string;
    label: string;
    mountPoint: string;
    usedPercent: number;
    availKiB: number;
    level: 'warning' | 'critical';
}

interface ActiveAlert {
    level: 'warning' | 'critical';
    at: number;
}

const ACTIVE_KEY = 'serverlens.diskAlerts.active';
const MUTED_KEY = 'serverlens.diskAlerts.muted';
const SNOOZED_KEY = 'serverlens.diskAlerts.snoozed';
/** Usage must drop this many points below the threshold before the alert can fire again. */
export const ALERT_HYSTERESIS = 2;

export function diskAlertKey(host: string, mountPoint: string): string {
    return `${host}\u0000${mountPoint}`;
}

/**
 * Tracks which disks are over their threshold. An alert fires once when a disk crosses the
 * threshold (or escalates from warning to critical) and re-arms only after usage falls
 * ALERT_HYSTERESIS points below it, so a disk hovering at 90 % does not notify every minute.
 * State is persisted, so reloading VS Code does not repeat alerts that were already shown.
 */
export class DiskAlertTracker {
    constructor(private readonly store: KeyValueStore, private readonly now: () => number = Date.now) {}

    isMuted(host: string, mountPoint: string): boolean {
        return Boolean(this.store.get<Record<string, boolean>>(MUTED_KEY, {})[diskAlertKey(host, mountPoint)]);
    }

    /** Returns the alerts that should be shown for this host's latest disk report. */
    async evaluate(server: ServerStatus, mode: 'off' | 'warning' | 'critical', warning: number, critical: number): Promise<DiskAlert[]> {
        if (mode === 'off' || !server.disks || server.error) {
            return [];
        }
        const active = { ...this.store.get<Record<string, ActiveAlert>>(ACTIVE_KEY, {}) };
        const muted = this.store.get<Record<string, boolean>>(MUTED_KEY, {});
        const snoozed = this.store.get<Record<string, number>>(SNOOZED_KEY, {});
        const now = this.now();
        const alerts: DiskAlert[] = [];
        let changed = false;
        const seen = new Set<string>();
        for (const disk of server.disks.disks) {
            const key = diskAlertKey(server.host, disk.mountPoint);
            seen.add(key);
            const level = usageLevel(disk.usedPercent, warning, critical);
            const notifyLevel = mode === 'warning' ? level : level === 'critical' ? 'critical' : 'ok';
            const previous = active[key];
            if (notifyLevel === 'ok') {
                const threshold = previous?.level === 'critical' && mode === 'critical' ? critical : warning;
                if (previous && disk.usedPercent < threshold - ALERT_HYSTERESIS) {
                    delete active[key];
                    changed = true;
                }
                continue;
            }
            const escalated = previous?.level === 'warning' && notifyLevel === 'critical';
            if (previous && !escalated) {
                continue;
            }
            active[key] = { level: notifyLevel, at: now };
            changed = true;
            if (muted[key] || (snoozed[key] && snoozed[key] > now)) {
                continue;
            }
            alerts.push({
                key,
                host: server.host,
                label: server.metadata?.alias || server.host,
                mountPoint: disk.mountPoint,
                usedPercent: disk.usedPercent,
                availKiB: disk.availKiB,
                level: notifyLevel
            });
        }
        // Forget filesystems that disappeared from this host (unmounted or hidden).
        const prefix = `${server.host}\u0000`;
        for (const key of Object.keys(active)) {
            if (key.startsWith(prefix) && !seen.has(key)) {
                delete active[key];
                changed = true;
            }
        }
        if (changed) {
            await this.store.update(ACTIVE_KEY, active);
        }
        return alerts;
    }

    async mute(keys: string[]): Promise<void> {
        const muted = { ...this.store.get<Record<string, boolean>>(MUTED_KEY, {}) };
        keys.forEach(key => { muted[key] = true; });
        await this.store.update(MUTED_KEY, muted);
    }

    async snooze(keys: string[], durationMs: number): Promise<void> {
        const snoozed = { ...this.store.get<Record<string, number>>(SNOOZED_KEY, {}) };
        const until = this.now() + durationMs;
        keys.forEach(key => { snoozed[key] = until; });
        for (const [key, value] of Object.entries(snoozed)) {
            if (value <= this.now()) {
                delete snoozed[key];
            }
        }
        await this.store.update(SNOOZED_KEY, snoozed);
    }

    /** Clears mutes, snoozes and remembered alerts; current full disks will notify again. */
    async reset(): Promise<number> {
        const count = Object.keys(this.store.get<Record<string, boolean>>(MUTED_KEY, {})).length;
        await this.store.update(MUTED_KEY, {});
        await this.store.update(SNOOZED_KEY, {});
        await this.store.update(ACTIVE_KEY, {});
        return count;
    }
}

export interface GpuNotificationSettings {
    enabled: boolean;
    events: Set<string>;
    cooldownMs: number;
    memoryWarningThreshold: number;
    temperatureWarningThreshold: number;
    powerWarningThreshold: number;
}

/** Server online/offline, GPU released and GPU threshold transitions (from GPU Fleet Viewer). */
export class GpuTransitionTracker {
    private readonly previousServerOnline = new Map<string, boolean>();
    private readonly previousAvailability = new Map<string, boolean>();
    private readonly activeWarnings = new Set<string>();
    private lastNotificationAt = Number.NEGATIVE_INFINITY;

    constructor(private readonly now: () => number = Date.now) {}

    /** Records the new state of one server and returns messages worth notifying. */
    evaluate(server: ServerStatus, settings: GpuNotificationSettings): string[] {
        const messages: string[] = [];
        const online = !server.error;
        const name = server.metadata?.alias || server.host;
        const previousOnline = this.previousServerOnline.get(server.host);
        if (previousOnline !== undefined && previousOnline !== online && settings.events.has('serverState')) {
            messages.push(`${name} is ${online ? 'online' : 'offline'}`);
        }
        this.previousServerOnline.set(server.host, online);
        if (!online) {
            return this.throttle(messages, settings);
        }
        for (const gpu of server.gpus) {
            const key = `${server.host}:${gpu.uuid}`;
            const previousAvailable = this.previousAvailability.get(key);
            if (previousAvailable === false && gpu.availability.available && settings.events.has('gpuAvailable')) {
                messages.push(`${name} GPU ${gpu.index} is now available`);
            }
            this.previousAvailability.set(key, gpu.availability.available);
            const memory = numberValue(gpu.memory.used) / Math.max(1, numberValue(gpu.memory.total)) * 100;
            const temperature = numberValue(gpu.temperature.gpu);
            const power = numberValue(gpu.power.draw) / Math.max(1, numberValue(gpu.power.limit)) * 100;
            const warning = memory >= settings.memoryWarningThreshold ||
                temperature >= settings.temperatureWarningThreshold ||
                power >= settings.powerWarningThreshold;
            if (warning && !this.activeWarnings.has(key) && settings.events.has('threshold')) {
                messages.push(`${name} GPU ${gpu.index} crossed a warning threshold`);
            }
            if (warning) {
                this.activeWarnings.add(key);
            } else {
                this.activeWarnings.delete(key);
            }
        }
        return this.throttle(messages, settings);
    }

    private throttle(messages: string[], settings: GpuNotificationSettings): string[] {
        if (!settings.enabled || !messages.length || this.now() - this.lastNotificationAt < settings.cooldownMs) {
            return [];
        }
        this.lastNotificationAt = this.now();
        return messages;
    }
}
