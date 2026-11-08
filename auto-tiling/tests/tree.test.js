import {test} from 'node:test';
import assert from 'node:assert/strict';

import {Tree, Direction, Orientation, findNeighbor} from '../auto-tiling@nurik.local/tree.js';
import {normalizeAccelerator} from '../auto-tiling@nurik.local/accel.js';

const AREA = {x: 0, y: 32, width: 1920, height: 1168};
const NO_GAPS = {inner: 0, outer: 0};

function build(...ids) {
    const tree = new Tree();
    let previous = null;
    for (const id of ids) {
        tree.insert(id, previous, AREA);
        previous = id;
    }
    return tree;
}

test('one window fills the area', () => {
    const rects = build('A').layout(AREA, NO_GAPS);
    assert.deepEqual(rects.get('A'), AREA);
});

test('dwindle: A | (B / C)', () => {
    const rects = build('A', 'B', 'C').layout(AREA, NO_GAPS);
    assert.deepEqual(rects.get('A'), {x: 0, y: 32, width: 960, height: 1168});
    assert.deepEqual(rects.get('B'), {x: 960, y: 32, width: 960, height: 584});
    assert.deepEqual(rects.get('C'), {x: 960, y: 616, width: 960, height: 584});
});

test('new window splits the target, not the last window', () => {
    const tree = build('A', 'B');
    tree.insert('C', 'A', AREA);
    const rects = tree.layout(AREA, NO_GAPS);
    assert.equal(rects.get('B').height, 1168);
    assert.equal(rects.get('A').height, 584);
    assert.equal(rects.get('C').y, 32 + 584);
});

test('gaps pad the area and separate neighbours', () => {
    const rects = build('A', 'B').layout(AREA, {inner: 8, outer: 8});
    const a = rects.get('A');
    const b = rects.get('B');
    assert.equal(a.x, 8);
    assert.equal(a.y, 40);
    assert.equal(a.height, 1168 - 16);
    assert.equal(b.x - (a.x + a.width), 8);
    assert.equal(b.x + b.width, 1920 - 8);
});

test('removing a window gives its space to the sibling', () => {
    const tree = build('A', 'B', 'C');
    tree.remove('B');
    const rects = tree.layout(AREA, NO_GAPS);
    assert.deepEqual(rects.get('C'), {x: 960, y: 32, width: 960, height: 1168});
    tree.remove('A');
    tree.remove('C');
    assert.ok(tree.isEmpty);
});

test('hidden windows give their space away and keep their slot', () => {
    const tree = build('A', 'B', 'C');
    const hidden = new Set(['B']);
    const rects = tree.layout(AREA, NO_GAPS, id => hidden.has(id));
    assert.equal(rects.has('B'), false);
    assert.equal(rects.get('C').height, 1168);
    hidden.clear();
    assert.equal(tree.layout(AREA, NO_GAPS).get('B').height, 584);
});

test('swap exchanges slots', () => {
    const tree = build('A', 'B');
    tree.swap('A', 'B');
    assert.deepEqual(tree.ids, ['B', 'A']);
});

test('resize moves the facing border, else the opposite one', () => {
    const tree = build('A', 'B');
    tree.resize('A', Direction.RIGHT, 0.1);
    assert.equal(tree.layout(AREA, NO_GAPS).get('A').width, 1152);
    // B has no border on its right: its left border moves right instead.
    tree.resize('B', Direction.RIGHT, 0.1);
    assert.equal(tree.layout(AREA, NO_GAPS).get('B').width, 576);
    // Clamped at 0.9.
    for (let i = 0; i < 20; i++)
        tree.resize('A', Direction.RIGHT, 0.1);
    assert.equal(tree.layout(AREA, NO_GAPS).get('A').width, 1728);
});

test('resize up/down uses vertical splits only', () => {
    const tree = build('A', 'B', 'C');
    tree.resize('B', Direction.DOWN, 0.1);
    const rects = tree.layout(AREA, NO_GAPS);
    assert.equal(rects.get('B').height, Math.round(1168 * 0.6));
    assert.equal(rects.get('A').width, 960);
});

test('toggleSplit flips the parent orientation and equalize resets ratios', () => {
    const tree = build('A', 'B');
    tree.resize('A', Direction.RIGHT, 0.2);
    tree.toggleSplit('A');
    tree.equalize();
    const rects = tree.layout(AREA, NO_GAPS);
    assert.deepEqual(rects.get('A'), {x: 0, y: 32, width: 1920, height: 584});
    assert.equal(rects.get('B').y, 32 + 584);
    assert.equal(tree.root.orientation, Orientation.VERTICAL);
});

test('findNeighbor prefers overlapping, nearest windows', () => {
    const rects = build('A', 'B', 'C').layout(AREA, {inner: 8, outer: 8});
    const others = id => new Map([...rects].filter(([other]) => other !== id));
    assert.equal(findNeighbor(rects.get('A'), others('A'), Direction.RIGHT), 'B');
    assert.equal(findNeighbor(rects.get('C'), others('C'), Direction.LEFT), 'A');
    assert.equal(findNeighbor(rects.get('C'), others('C'), Direction.UP), 'B');
    assert.equal(findNeighbor(rects.get('B'), others('B'), Direction.DOWN), 'C');
    assert.equal(findNeighbor(rects.get('A'), others('A'), Direction.LEFT), null);
});

test('toData and fromData keep the layout', () => {
    const tree = build('A', 'B', 'C');
    tree.resize('A', Direction.RIGHT, 0.2);
    const data = JSON.parse(JSON.stringify(tree.toData(id => ({app: id}))));
    const copy = Tree.fromData(data, leafData => leafData.app);
    assert.deepEqual(copy.layout(AREA, NO_GAPS), tree.layout(AREA, NO_GAPS));
    assert.equal(copy.root.parent, null);
    assert.equal(copy.root.children[1].parent, copy.root);
});

test('fromData drops leaves and their siblings take the space', () => {
    const data = build('A', 'B', 'C').toData(id => id);
    const copy = Tree.fromData(data, id => id === 'B' ? null : id);
    assert.deepEqual(copy.ids, ['A', 'C']);
    assert.equal(copy.layout(AREA, NO_GAPS).get('C').height, 1168);
    assert.ok(Tree.fromData(data, () => null).isEmpty);
    assert.ok(Tree.fromData(null, id => id).isEmpty);
});

test('fromData rejects malformed data', () => {
    assert.throws(() => Tree.fromData({orientation: 'diagonal', children: []}, id => id));
    assert.throws(() => Tree.fromData({children: [{leaf: 1}]}, id => id));
});

test('replace puts a window into a slot', () => {
    const tree = build('A', 'B', 'C');
    tree.replace('B', 'D');
    assert.deepEqual(tree.ids, ['A', 'D', 'C']);
});

test('a minimum size moves the split and squeezes the neighbour', () => {
    const tree = build('A', 'B', 'C', 'D');
    const mins = new Map([['C', {width: 600, height: 0}]]);
    const plain = tree.layout(AREA, NO_GAPS);
    assert.equal(plain.get('C').width, 480);
    const rects = tree.layout(AREA, NO_GAPS, () => false, id => mins.get(id));
    assert.equal(rects.get('C').width, 600);
    assert.equal(rects.get('D').width, 360);
    assert.equal(rects.get('D').x, rects.get('C').x + 600);
    // The column of C and D keeps its width: only their split moved.
    assert.equal(rects.get('A').width, 960);
});

test('minimums of a subtree add up along the split', () => {
    const tree = build('A', 'B', 'C');
    // B and C are stacked on the right; the wider one sets the column's minimum.
    const mins = new Map([['B', {width: 1200, height: 0}], ['C', {width: 300, height: 0}]]);
    const rects = tree.layout(AREA, NO_GAPS, () => false, id => mins.get(id));
    assert.equal(rects.get('B').width, 1200);
    assert.equal(rects.get('C').width, 1200);
    assert.equal(rects.get('A').width, 720);
});

test('when minimums do not fit, the first window keeps its own', () => {
    const tree = build('A', 'B');
    const mins = new Map([['A', {width: 1500, height: 0}], ['B', {width: 1500, height: 0}]]);
    const rects = tree.layout(AREA, NO_GAPS, () => false, id => mins.get(id));
    assert.equal(rects.get('A').width, 1500);
    assert.equal(rects.get('B').width, 420);
});

test('no window gets less than a tenth of its split', () => {
    const tree = build('A', 'B');
    const mins = new Map([['B', {width: 1900, height: 0}]]);
    const rects = tree.layout(AREA, NO_GAPS, () => false, id => mins.get(id));
    assert.equal(rects.get('A').width, 192);
    assert.equal(rects.get('B').width, 1728);
});

test('resize gives back a function that undoes it', () => {
    const tree = build('A', 'B');
    const undo = tree.resize('A', Direction.RIGHT, 0.2);
    assert.equal(tree.layout(AREA, NO_GAPS).get('A').width, 1344);
    undo();
    assert.equal(tree.layout(AREA, NO_GAPS).get('A').width, 960);
});

test('normalizeAccelerator ignores modifier order and aliases', () => {
    assert.equal(normalizeAccelerator('<Super><Shift>Left'), normalizeAccelerator('<Shift><Super>left'));
    assert.equal(normalizeAccelerator('<Ctrl><Super>Up'), normalizeAccelerator('<Super><Control>Up'));
    assert.notEqual(normalizeAccelerator('<Super>Left'), normalizeAccelerator('<Super><Shift>Left'));
});
