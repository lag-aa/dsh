/**
 * Node stand-in for the platform React the client bundle normally requires.
 *
 * The checks only need to build and walk an element tree, plus enough of the hook
 * surface for the body and the settings section to run once. `useSyncExternalStore`
 * reads the store directly, which is exactly what a first render does.
 */

export const Fragment = Symbol.for('dsh.react.fragment');

/**
 * Hook bookkeeping.
 *
 * React throws #300 ("rendered fewer hooks than expected") when a component
 * calls a different number of hooks between renders — the classic symptom of a
 * hook placed after an early `return`. The stub cannot enforce that by itself,
 * but it can record which hooks each function component called during one
 * render, so a check can compare two renders of the same component and see the
 * divergence a browser would crash on.
 *
 * `__frames` maps a component function to the hook-name lists of its renders;
 * `__hookStack` is the frame of the component currently executing.
 */
const frames = new Map();
export const hookFrames = frames;
const hookStack = [];

/** Record one hook call against the component that is executing. */
function record(name) {
  const frame = hookStack[hookStack.length - 1];
  if (frame !== undefined) frame.push(name);
}

/** The React surface these sources use. */
export const React = {
  Fragment,
  createElement(type, props, ...children) {
    const rest = children.flat();
    return {
      type,
      props: { ...props, children: rest.length === 1 ? rest[0] : rest },
      key: props?.key ?? null,
    };
  },
  createContext(initial) {
    return { _current: initial, Provider: Symbol.for('dsh.react.provider') };
  },
  useContext(context) {
    return context._current;
  },
  useMemo(factory) {
    record('useMemo');
    return factory();
  },
  useCallback(callback) {
    record('useCallback');
    return callback;
  },
  // Effects are part of the contract for anything that reports state outward (a
  // viewer telling the tab header what it can do), so a check can ask for one
  // synchronous pass. Off by default: most checks describe a first paint, where
  // an effect that fetches would only add noise.
  useEffect(callback) {
    record('useEffect');
    if (React.__runEffects === true) callback();
  },
  useRef(initial) {
    record('useRef');
    return { current: typeof initial === 'function' ? initial() : initial };
  },
  useState(initial) {
    record('useState');
    // A component with more than one state cell needs each cell pinned
    // separately; the queue is consumed in the order the hooks run.
    if (Array.isArray(React.__stateQueue) && React.__stateQueue.length > 0) {
      return [React.__stateQueue.shift(), () => {}];
    }
    if (React.__stateOverride !== undefined) {
      const override = React.__stateOverride;
      React.__stateOverride = undefined;
      return [override, () => {}];
    }
    return [typeof initial === 'function' ? initial() : initial, () => {}];
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    record('useSyncExternalStore');
    // The checks render one branch at a time, so the store's value is pinned per
    // case instead of being driven through a subscription React never sets up.
    if (React.__storeOverride !== undefined) {
      const override = React.__storeOverride;
      React.__storeOverride = undefined;
      return override;
    }
    return getSnapshot();
  },
};

/**
 * Expand a tree the way React would, calling every function component once.
 *
 * The checks build trees with `createElement`, which only describes elements;
 * without this the body would look like three opaque components. Function
 * components are called, arrays flattened, and string host types kept as leaves.
 *
 * Each function component's hook calls are recorded against the component, so a
 * check can render it twice under different props and compare the sequences the
 * way React compares them between renders.
 *
 * @param tree - a tree as `createElement` left it.
 * @returns the tree with function components expanded.
 */
export function render(tree) {
  const walk = (node) => {
    if (node === null || node === undefined || typeof node === 'boolean') return node;
    if (typeof node === 'string' || typeof node === 'number') return node;
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node.type === 'function') {
      const frame = [];
      hookStack.push(frame);
      let produced;
      try {
        produced = node.type(node.props);
      } finally {
        hookStack.pop();
      }
      const runs = frames.get(node.type) ?? [];
      runs.push(frame);
      frames.set(node.type, runs);
      return walk(produced);
    }
    const props = { ...node.props, children: walk(node.props?.children) };
    return { ...node, props };
  };
  return walk(tree);
}

/** Collect every element of one type from a rendered tree. */
export function findByType(tree, type) {
  return findBy(tree, (node) => node.type === type);
}

/** Collect every element matching a predicate, in tree order. */
export function findBy(tree, predicate) {
  const found = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (predicate(node) === true) found.push(node);
    walk(node.props?.children);
  };
  walk(tree);
  return found;
}

/** Every string in a rendered tree, in order. */
export function textOf(tree) {
  const parts = [];
  const walk = (node) => {
    if (node === null || node === undefined || node === false) return;
    if (typeof node === 'string' || typeof node === 'number') {
      parts.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    walk(node.props?.children);
  };
  walk(tree);
  return parts.join('');
}
