// Binary space partitioning layout for the windows of one workspace on one
// monitor. Plain JS with no GNOME imports, so it can be unit-tested with node.
// Leaves hold opaque window ids compared with ===.

// HORIZONTAL splits place children side by side (left | right); VERTICAL
// splits stack them (top / bottom).
export const Orientation = Object.freeze({HORIZONTAL: 'horizontal', VERTICAL: 'vertical'});
export const Direction = Object.freeze({LEFT: 'left', RIGHT: 'right', UP: 'up', DOWN: 'down'});

const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

function orientationOf(direction) {
    return direction === Direction.LEFT || direction === Direction.RIGHT
        ? Orientation.HORIZONTAL : Orientation.VERTICAL;
}

function leaf(id) {
    return {id, parent: null};
}

function split(orientation, first, second) {
    const node = {orientation, ratio: 0.5, children: [first, second], parent: null};
    first.parent = node;
    second.parent = node;
    return node;
}

function isLeaf(node) {
    return !node.children;
}

export class Tree {
    constructor() {
        this.root = null;
    }

    get isEmpty() {
        return this.root === null;
    }

    has(id) {
        return this._findLeaf(id) !== null;
    }

    // Window ids in layout order (left to right, top to bottom).
    get ids() {
        const ids = [];
        const walk = node => {
            if (!node)
                return;
            if (isLeaf(node))
                ids.push(node.id);
            else
                node.children.forEach(walk);
        };
        walk(this.root);
        return ids;
    }

    // Splits the slot of `targetId` in two along its longer side and puts `id`
    // in the second half. Without a usable target the last visible window is
    // split. `area` and `isHidden` are what layout() gets, to measure the slot.
    insert(id, targetId, area, isHidden = () => false) {
        if (this.has(id))
            return;

        const newLeaf = leaf(id);
        if (!this.root) {
            this.root = newLeaf;
            return;
        }

        const slots = this.layout(area, {inner: 0, outer: 0}, isHidden);
        let target = slots.has(targetId) ? this._findLeaf(targetId) : null;
        if (!target) {
            const visible = this.ids.filter(other => slots.has(other));
            const fallbackId = visible.length ? visible[visible.length - 1] : this.ids.at(-1);
            target = this._findLeaf(fallbackId);
        }

        const slot = slots.get(target.id) ?? area;
        const orientation = slot.width >= slot.height
            ? Orientation.HORIZONTAL : Orientation.VERTICAL;
        this._replace(target, split(orientation, leaf(target.id), newLeaf));
    }

    remove(id) {
        const node = this._findLeaf(id);
        if (!node)
            return;

        const parent = node.parent;
        if (!parent) {
            this.root = null;
            return;
        }
        const sibling = parent.children[0] === node ? parent.children[1] : parent.children[0];
        this._replace(parent, sibling);
    }

    swap(a, b) {
        const leafA = this._findLeaf(a);
        const leafB = this._findLeaf(b);
        if (!leafA || !leafB)
            return;
        leafA.id = b;
        leafB.id = a;
    }

    // Moves the border of `id` that faces `direction` by `step` (a fraction of
    // the split). When the window has no border on that side, its opposite
    // border moves the same way instead, so the key still does something.
    resize(id, direction, step) {
        const node = this._findLeaf(id);
        if (!node)
            return;

        const orientation = orientationOf(direction);
        const growsForward = direction === Direction.RIGHT || direction === Direction.DOWN;
        // The window's facing border is the boundary of an ancestor where the
        // window is in the first child (for right/down) or the second (for left/up).
        const facingIndex = growsForward ? 0 : 1;

        let fallback = null;
        for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
            if (parent.orientation !== orientation)
                continue;
            if (parent.children[facingIndex] === child) {
                this._shift(parent, growsForward ? step : -step);
                return;
            }
            fallback ??= parent;
        }
        if (fallback)
            this._shift(fallback, growsForward ? step : -step);
    }

    toggleSplit(id) {
        const parent = this._findLeaf(id)?.parent;
        if (!parent)
            return;
        parent.orientation = parent.orientation === Orientation.HORIZONTAL
            ? Orientation.VERTICAL : Orientation.HORIZONTAL;
    }

    equalize() {
        const walk = node => {
            if (!node || isLeaf(node))
                return;
            node.ratio = 0.5;
            node.children.forEach(walk);
        };
        walk(this.root);
    }

    // Returns Map(id -> {x, y, width, height}) with integer geometry. Hidden
    // windows give their space to the rest; gaps.outer pads the area and
    // gaps.inner separates neighbours.
    layout(area, gaps, isHidden = () => false) {
        const rects = new Map();
        const visible = new Map();
        const countVisible = node => {
            if (!node)
                return false;
            const result = isLeaf(node)
                ? !isHidden(node.id)
                : node.children.map(countVisible).some(Boolean);
            visible.set(node, result);
            return result;
        };
        if (!countVisible(this.root))
            return rects;

        const place = (node, rect) => {
            if (isLeaf(node)) {
                rects.set(node.id, rect);
                return;
            }
            const [first, second] = node.children;
            if (!visible.get(first)) {
                place(second, rect);
                return;
            }
            if (!visible.get(second)) {
                place(first, rect);
                return;
            }

            const horizontal = node.orientation === Orientation.HORIZONTAL;
            const total = horizontal ? rect.width : rect.height;
            const available = Math.max(0, total - gaps.inner);
            const firstSize = Math.round(available * node.ratio);
            const secondSize = available - firstSize;
            if (horizontal) {
                place(first, {...rect, width: firstSize});
                place(second, {...rect, x: rect.x + firstSize + gaps.inner, width: secondSize});
            } else {
                place(first, {...rect, height: firstSize});
                place(second, {...rect, y: rect.y + firstSize + gaps.inner, height: secondSize});
            }
        };

        place(this.root, {
            x: area.x + gaps.outer,
            y: area.y + gaps.outer,
            width: Math.max(0, area.width - 2 * gaps.outer),
            height: Math.max(0, area.height - 2 * gaps.outer),
        });
        return rects;
    }

    _shift(splitNode, delta) {
        splitNode.ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, splitNode.ratio + delta));
    }

    _replace(oldNode, newNode) {
        const parent = oldNode.parent;
        newNode.parent = parent;
        if (!parent)
            this.root = newNode;
        else
            parent.children[parent.children.indexOf(oldNode)] = newNode;
    }

    _findLeaf(id) {
        const walk = node => {
            if (!node)
                return null;
            if (isLeaf(node))
                return node.id === id ? node : null;
            return walk(node.children[0]) ?? walk(node.children[1]);
        };
        return walk(this.root);
    }
}

// Picks the rect from `candidates` (Map id -> rect) that lies in `direction`
// from `from`: overlapping ones first, then the nearest edge, then the closest
// center across the axis. Returns the id or null.
export function findNeighbor(from, candidates, direction) {
    const horizontal = orientationOf(direction) === Orientation.HORIZONTAL;
    const edgeGap = rect => {
        switch (direction) {
        case Direction.LEFT: return from.x - (rect.x + rect.width);
        case Direction.RIGHT: return rect.x - (from.x + from.width);
        case Direction.UP: return from.y - (rect.y + rect.height);
        default: return rect.y - (from.y + from.height);
        }
    };
    const overlap = rect => horizontal
        ? Math.min(from.y + from.height, rect.y + rect.height) - Math.max(from.y, rect.y)
        : Math.min(from.x + from.width, rect.x + rect.width) - Math.max(from.x, rect.x);
    const crossDistance = rect => horizontal
        ? Math.abs((from.y + from.height / 2) - (rect.y + rect.height / 2))
        : Math.abs((from.x + from.width / 2) - (rect.x + rect.width / 2));

    // A few pixels of overlap still count as "beside" (clients may not honor
    // the exact size, e.g. because of a minimum width).
    const TOLERANCE = 4;
    let best = null;
    for (const [id, rect] of candidates) {
        const gap = edgeGap(rect);
        if (gap < -TOLERANCE)
            continue;
        const score = [overlap(rect) > 0 ? 0 : 1, Math.max(0, gap), crossDistance(rect)];
        if (!best || score[0] < best.score[0] ||
            (score[0] === best.score[0] && (score[1] < best.score[1] ||
                (score[1] === best.score[1] && score[2] < best.score[2]))))
            best = {id, score};
    }
    return best?.id ?? null;
}
