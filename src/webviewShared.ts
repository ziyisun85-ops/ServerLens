// ServerLens: script helpers shared by the dashboard and sidebar webviews.
// node() and patchChildren() are moved unchanged from GPU Fleet Viewer's webviewTemplate.ts
// (keyed DOM patching that keeps focus, scroll positions and transitions across updates).
import { formatBytePair, formatBytes, formatDurationSeconds, percentCeil, usageLevel } from './format';

export function sharedDomHelpers(): string {
    return `
        function node(tag, className, text) {
            const element = document.createElement(tag);
            if (className) element.className = className;
            if (text !== undefined) element.textContent = text;
            return element;
        }
        // Retain mounted nodes so background updates preserve focus, selection,
        // scroll containers, and progress transitions. Only changed values mutate.
        function patchChildren(parent, desired) {
            const previous = Array.from(parent.childNodes);
            const used = new Set();
            const keyed = new Map(previous.filter(child => child.nodeType === 1 && child.dataset.key)
                .map(child => [child.dataset.key, child]));
            let cursor = parent.firstChild;
            for (const next of Array.from(desired.childNodes)) {
                const key = next.nodeType === 1 && next.dataset.key;
                const current = key ? keyed.get(key) : previous.find(child => !used.has(child) &&
                    !(child.nodeType === 1 && child.dataset.key) && child.nodeType === next.nodeType && child.nodeName === next.nodeName);
                let mounted = next;
                if (current && current.nodeName === next.nodeName) {
                    mounted = current;
                    used.add(current);
                    if (next.nodeType !== 1) {
                        if (current.nodeValue !== next.nodeValue) current.nodeValue = next.nodeValue;
                    } else {
                        for (const attribute of Array.from(current.attributes)) {
                            if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
                        }
                        for (const attribute of Array.from(next.attributes)) {
                            if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
                        }
                        current.onclick = next.onclick;
                        current.ontoggle = next.ontoggle;
                        patchChildren(current, next);
                    }
                }
                if (mounted !== cursor) parent.insertBefore(mounted, cursor);
                cursor = mounted.nextSibling;
            }
            for (const child of previous) {
                if (!used.has(child)) child.remove();
            }
        }
    `;
}

/** The format.ts functions, embedded as-is so the webviews and the tests share one implementation. */
export function sharedFormatHelpers(): string {
    return [formatBytes, formatBytePair, percentCeil, usageLevel, formatDurationSeconds].map(fn => fn.toString()).join('\n');
}
