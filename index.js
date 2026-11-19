const React = require('react');
const { createAction } = require('redux-act');
const { actions, log, selectors } = require('vortex-api');

// How the per-game menu works in Vortex 2.11 (renderer/src/views/components/Spine/SpineContext.tsx):
// the menu lists the "per-game" main pages sorted by `priority`, keeps those whose `visible()`
// returns true, and opens the first of them when a game is picked. Browse registers with
// priority 0 and Collections with 10, which is why they sit above Mods (1) and why Browse opens.
//
// Vortex builds the page objects from the registerMainPage calls the first time the main UI is
// drawn, and caches them. That happens after every extension's once() has run. Before that,
// only the loading screen is drawn, and it is handed the ExtensionManager as a prop. So in
// once() this extension finds the ExtensionManager through the loading screen and wraps its
// apply(), giving each per-game page a priority that follows the user's order and a visible()
// that also checks the user's hidden list. Nothing in Vortex's files is changed.
//
// Tools and Game settings are built into the renderer (contexts/builtInPages.ts) rather than
// registered, so they keep their priorities (50 and 80), can't be hidden, and Tools always comes
// before Game settings. Every other tab can go anywhere around them.

const STATE_PATH = ['settings', 'gameMenuTabs'];

const BUILT_IN_PAGES = [
  { id: 'tools_page', title: 'Tools', priority: 50 },
  { id: 'game_settings', title: 'Game settings', priority: 80 },
];
const BUILT_IN_IDS = new Set(BUILT_IN_PAGES.map(page => page.id));

const DEFAULTS = {
  // Page ids, top to bottom. Empty means "not customized yet": Vortex's order with Mods first.
  order: [],
  hidden: ['Browse', 'Collections'],
  alwaysFirst: true,
};

const setConfig = createAction('GAME_MENU_TABS_SET_CONFIG', config => config);

const reducer = {
  reducers: {
    [setConfig]: (state, payload) => ({ ...state, ...payload }),
  },
  defaults: DEFAULTS,
};

// --- page catalog -------------------------------------------------------------------------

// id -> { id, title, priority, visible, builtIn }, filled from the registerMainPage calls.
const catalog = new Map();
let hookStatus = 'Not started.';
let hooked = false;

function readConfig(state) {
  const config = state?.settings?.gameMenuTabs ?? {};
  return {
    order: Array.isArray(config.order) ? config.order : DEFAULTS.order,
    hidden: Array.isArray(config.hidden) ? config.hidden : DEFAULTS.hidden,
    alwaysFirst: config.alwaysFirst !== undefined ? !!config.alwaysFirst : DEFAULTS.alwaysFirst,
  };
}

// Vortex's own order: priority, then title.
function vortexOrder() {
  return [...catalog.values()]
    .sort((a, b) => (a.priority - b.priority) || a.title.localeCompare(b.title, undefined, { numeric: true }))
    .map(page => page.id);
}

// The order to use: the saved one, with pages it doesn't know (new in Vortex or from a newly
// added extension) appended at the bottom, so a new tab never takes the top spot.
function effectiveOrder(savedOrder) {
  let order;
  if (savedOrder.length === 0) {
    order = vortexOrder();
    if (order.includes('Mods')) {
      order = ['Mods', ...order.filter(id => id !== 'Mods')];
    }
  } else {
    order = savedOrder.filter(id => catalog.has(id));
    for (const id of vortexOrder()) {
      if (!order.includes(id)) {
        order.push(id);
      }
    }
  }
  // Tools must stay above Game settings; their priorities are fixed.
  const tools = order.indexOf('tools_page');
  const settings = order.indexOf('game_settings');
  if (tools !== -1 && settings !== -1 && settings < tools) {
    order[tools] = 'game_settings';
    order[settings] = 'tools_page';
  }
  return order;
}

// Priorities that reproduce `order` around the fixed built-in pages:
// above Tools: 0 to <49, between Tools and Game settings: 50 to 80 exclusive, below: 81 and up.
function priorities(order) {
  const segments = [[], [], []];
  let segment = 0;
  for (const id of order) {
    if (id === 'tools_page') {
      segment = 1;
    } else if (id === 'game_settings') {
      segment = 2;
    } else {
      segments[segment].push(id);
    }
  }
  const result = {};
  segments[0].forEach((id, i) => { result[id] = (i * 49) / segments[0].length; });
  segments[1].forEach((id, i) => { result[id] = 50 + ((i + 1) * 30) / (segments[1].length + 1); });
  segments[2].forEach((id, i) => { result[id] = 81 + i; });
  return result;
}

function isPageAvailable(page) {
  if (page.builtIn) {
    return true;
  }
  try {
    return page.visible === undefined || page.visible() !== false;
  } catch (err) {
    return false;
  }
}

// The tab a game should open on: the first one in the user's order that is shown for it.
function firstPageId(state) {
  const config = readConfig(state);
  for (const id of effectiveOrder(config.order)) {
    const page = catalog.get(id);
    if (page !== undefined && !config.hidden.includes(id) && isPageAvailable(page)) {
      return id;
    }
  }
  return undefined;
}

// --- hooking Vortex ---------------------------------------------------------------------------

function findExtensionManager() {
  const root = document.getElementById('content');
  if (root == null) {
    return undefined;
  }
  const containerKey = Object.keys(root).find(key => key.startsWith('__reactContainer$'));
  const start = containerKey !== undefined
    ? root[containerKey]
    : root._reactRootContainer?._internalRoot?.current;

  const stack = [start];
  for (let visited = 0; stack.length > 0 && visited < 10000; visited++) {
    const fiber = stack.pop();
    if (fiber == null) {
      continue;
    }
    const extensions = fiber.memoizedProps?.extensions;
    if (extensions != null && typeof extensions.apply === 'function' && typeof extensions.getApi === 'function') {
      return extensions;
    }
    stack.push(fiber.sibling, fiber.child);
  }
  return undefined;
}

// registerMainPage(icon, title, component, options), with extension info first when addExtInfo.
function splitArgs(args, addExtInfo) {
  const offset = addExtInfo ? 1 : 0;
  return { offset, title: args[offset + 1], options: args[offset + 3] };
}

function hookPages(api) {
  const extensions = findExtensionManager();
  if (extensions === undefined) {
    hookStatus = 'Inactive: could not find the Vortex extension manager. Vortex may have changed how it starts.';
    log('warn', 'game-menu-tabs: extension manager not found, menu left as it is');
    return;
  }

  // First pass: learn every per-game page, so the order can be worked out before Vortex
  // builds the pages.
  extensions.apply('registerMainPage', (...args) => {
    const { title, options } = splitArgs(args, true);
    if (options?.group !== 'per-game') {
      return;
    }
    const id = options.id || title;
    if (!catalog.has(id)) {
      catalog.set(id, {
        id,
        title: String(title),
        priority: options.priority !== undefined ? options.priority : 100,
        visible: options.visible,
        builtIn: false,
      });
    }
  }, true);
  for (const page of BUILT_IN_PAGES) {
    if (!catalog.has(page.id)) {
      catalog.set(page.id, { ...page, builtIn: true });
    }
  }

  const config = readConfig(api.getState());
  const priorityOf = priorities(effectiveOrder(config.order));

  const originalApply = extensions.apply;
  extensions.apply = function (funcName, func, addExtInfo) {
    if (funcName !== 'registerMainPage') {
      return originalApply.apply(this, arguments);
    }
    return originalApply.call(this, funcName, (...args) => {
      const { offset, title, options } = splitArgs(args, addExtInfo);
      if (options?.group === 'per-game') {
        const id = options.id || title;
        const originalVisible = options.visible;
        const patched = [...args];
        patched[offset + 3] = {
          ...options,
          priority: priorityOf[id] !== undefined ? priorityOf[id] : options.priority,
          visible: () => !readConfig(api.getState()).hidden.includes(id)
            && (originalVisible === undefined || originalVisible()),
        };
        return func(...patched);
      }
      return func(...args);
    }, addExtInfo);
  };

  hooked = true;
  hookStatus = 'Active.';
  log('info', 'game-menu-tabs: menu order applied', { order: effectiveOrder(config.order) });
}

// --- opening the first tab ------------------------------------------------------------------

function setupNavigation(api) {
  // Until this time, any per-game page Vortex opens is replaced with the first tab. Vortex
  // opens the page for a picked game from a React effect shortly after the switch, so a short
  // window catches it without getting in the way of the user's own clicks.
  let redirectUntil = 0;
  let pending; // { gameId, expires }: a game picked in the sidebar that isn't active yet.

  const isPerGamePage = pageId => catalog.has(pageId);

  const openFirst = () => {
    const state = api.getState();
    const first = firstPageId(state);
    if (first !== undefined && state.session?.base?.mainPage !== first) {
      api.store.dispatch(actions.setOpenMainPage(first, false));
    }
  };

  const arm = windowMs => {
    redirectUntil = Date.now() + windowMs;
    setTimeout(openFirst, 0);
  };

  api.onStateChange(['session', 'base', 'mainPage'], (previous, current) => {
    try {
      const state = api.getState();
      if (!isPerGamePage(current) || selectors.activeGameId(state) === undefined) {
        return;
      }
      const config = readConfig(state);
      const redirecting = config.alwaysFirst && Date.now() < redirectUntil;
      if (redirecting || config.hidden.includes(current)) {
        const first = firstPageId(state);
        if (first !== undefined && first !== current) {
          api.store.dispatch(actions.setOpenMainPage(first, false));
        }
      }
    } catch (err) {
      log('warn', 'game-menu-tabs: failed to redirect page', { error: err.message });
    }
  });

  api.onStateChange(['settings', 'profiles', 'activeProfileId'], () => {
    try {
      const gameId = selectors.activeGameId(api.getState());
      if (pending !== undefined && pending.gameId === gameId && Date.now() < pending.expires) {
        pending = undefined;
        arm(1000);
      }
    } catch (err) {
      log('warn', 'game-menu-tabs: failed to handle game switch', { error: err.message });
    }
  });

  // A click on a game in the far-left sidebar. Runs in the capture phase, before Vortex's
  // own handler, so the window is open when Vortex opens the game's page.
  document.addEventListener('click', event => {
    try {
      const state = api.getState();
      if (!readConfig(state).alwaysFirst) {
        return;
      }
      const button = event.target?.closest?.('[data-testid="spine"] button[aria-label]');
      if (button == null) {
        return;
      }
      const label = button.getAttribute('aria-label');
      const game = (state.session?.gameMode?.known ?? [])
        .find(iter => (iter?.name ?? '').replace(/\s+/g, ' ').trim() === label);
      if (game === undefined) {
        return;
      }
      if (selectors.activeGameId(state) === game.id) {
        pending = undefined;
        arm(500);
      } else {
        // A minute leaves time for the profile picker, if Vortex shows it.
        pending = { gameId: game.id, expires: Date.now() + 60000 };
      }
    } catch (err) {
      log('warn', 'game-menu-tabs: failed to handle game click', { error: err.message });
    }
  }, true);
}

// --- settings page --------------------------------------------------------------------------

const h = React.createElement;

const buttonStyle = {
  background: 'transparent',
  color: 'inherit',
  border: '1px solid currentColor',
  borderRadius: 4,
  padding: '2px 10px',
  cursor: 'pointer',
};

function useConfig(api) {
  const [config, setLocal] = React.useState(() => readConfig(api.getState()));
  React.useEffect(() => api.store.subscribe(() => {
    const next = readConfig(api.getState());
    setLocal(prev => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }), [api]);
  return config;
}

function TabsSettings({ api }) {
  const config = useConfig(api);
  const [changed, setChanged] = React.useState(false);
  const order = effectiveOrder(config.order);

  const save = patch => {
    api.store.dispatch(setConfig(patch));
    setChanged(true);
  };

  const move = (index, delta) => {
    const next = [...order];
    const target = index + delta;
    [next[index], next[target]] = [next[target], next[index]];
    save({ order: next });
  };

  // Tools and Game settings can't swap places.
  const canSwap = (a, b) => !(BUILT_IN_IDS.has(a) && BUILT_IN_IDS.has(b));

  const toggleHidden = id => {
    const hidden = config.hidden.includes(id)
      ? config.hidden.filter(iter => iter !== id)
      : [...config.hidden, id];
    save({ hidden });
  };

  const titleCounts = {};
  for (const id of order) {
    const title = catalog.get(id)?.title ?? id;
    titleCounts[title] = (titleCounts[title] ?? 0) + 1;
  }

  const rows = order.map((id, index) => {
    const page = catalog.get(id);
    const title = page?.title ?? id;
    const hidden = config.hidden.includes(id);
    const notes = [];
    if (titleCounts[title] > 1) {
      notes.push(id);
    }
    if (page?.builtIn) {
      notes.push('built into Vortex, always shown');
    } else if (page !== undefined && !hidden && !isPageAvailable(page)) {
      notes.push('not used by the current game');
    }
    return h('div', {
      key: id,
      style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', opacity: hidden ? 0.5 : 1 },
    },
      h('input', {
        type: 'checkbox',
        checked: !hidden,
        disabled: page?.builtIn,
        title: page?.builtIn ? 'Built into Vortex, can\'t be hidden' : 'Show this tab',
        onChange: () => toggleHidden(id),
      }),
      h('button', {
        style: buttonStyle,
        disabled: index === 0 || !canSwap(id, order[index - 1]),
        onClick: () => move(index, -1),
        title: 'Move up',
      }, '▲'),
      h('button', {
        style: buttonStyle,
        disabled: index === order.length - 1 || !canSwap(id, order[index + 1]),
        onClick: () => move(index, 1),
        title: 'Move down',
      }, '▼'),
      h('span', { style: { textDecoration: hidden ? 'line-through' : 'none' } }, title),
      notes.length > 0 ? h('span', { style: { opacity: 0.6, fontSize: '0.9em' } }, `(${notes.join(', ')})`) : null,
    );
  });

  const relaunch = window.api?.app?.relaunch;

  return h('div', { style: { padding: '8px 0', maxWidth: 640 } },
    h('h4', null, 'Game menu tabs'),
    h('p', { style: { opacity: 0.8 } },
      'Order and show or hide the tabs in the per-game menu. The game opens on the top tab that is shown. ',
      'Tabs added later by Vortex or other extensions go to the bottom.'),
    h('p', { style: { opacity: 0.8 } }, `Status: ${hookStatus}`),
    h('div', null, ...rows),
    h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 12 } },
      h('input', {
        type: 'checkbox',
        checked: config.alwaysFirst,
        onChange: () => save({ alwaysFirst: !config.alwaysFirst }),
      }),
      'Always open the top tab when you pick a game in the sidebar (otherwise Vortex returns to the tab you last used for that game)'),
    h('div', { style: { display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' } },
      h('button', {
        style: buttonStyle,
        onClick: () => save({ order: DEFAULTS.order, hidden: DEFAULTS.hidden, alwaysFirst: DEFAULTS.alwaysFirst }),
      }, 'Reset to defaults'),
      typeof relaunch === 'function'
        ? h('button', { style: buttonStyle, onClick: () => relaunch() }, 'Restart Vortex')
        : null,
      changed ? h('span', { style: { opacity: 0.8 } }, 'Restart Vortex to apply the new order.') : null,
    ),
  );
}

function main(context) {
  context.registerReducer(STATE_PATH, reducer);
  context.registerSettings('Game Menu', TabsSettings, () => ({ api: context.api }));

  context.once(() => {
    try {
      hookPages(context.api);
    } catch (err) {
      hookStatus = `Inactive: ${err.message}`;
      log('warn', 'game-menu-tabs: failed to apply menu order', { error: err.message });
    }
    if (hooked) {
      setupNavigation(context.api);
    }
  });

  return true;
}

module.exports = { default: main };
