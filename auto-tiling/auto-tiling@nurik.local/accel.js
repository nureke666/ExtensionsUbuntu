// Accelerator helpers. Plain JS with no GNOME imports, so it can be
// unit-tested with node.

const MODIFIER_ALIASES = {
    ctrl: 'control',
    primary: 'control',
    mod1: 'alt',
    mod4: 'super',
};

// Turns a GTK accelerator like '<Shift><Super>Left' into a canonical string so
// that differently written accelerators for the same keys compare equal.
export function normalizeAccelerator(accelerator) {
    const modifiers = new Set();
    for (const [, name] of accelerator.matchAll(/<([^>]+)>/g)) {
        const lower = name.toLowerCase();
        modifiers.add(MODIFIER_ALIASES[lower] ?? lower);
    }
    const key = accelerator.replace(/<[^>]+>/g, '').toLowerCase();
    return [...[...modifiers].sort(), key].join('+');
}
