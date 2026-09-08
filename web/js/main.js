/** Bootstrap: hash routing between the gallery and the detail view. */
import { loadRegistry, byId } from './registry.js';
import { Gallery } from './gallery.js';
import { Detail } from './detail.js';
import { applyChrome, detectLang, setLang, lang, t, pageTitle, LANGS } from './i18n.js';
import { paintIcons } from './icons.js';
import { theme, toggleTheme } from './theme.js';
import { applyCustomLang, customEntry, setupCustomPicker } from './custom.js';
import { Compare } from './compare.js';

const views = {
  gallery: document.getElementById('view-gallery'),
  detail: document.getElementById('view-detail'),
  compare: document.getElementById('view-compare'),
};

function parseHash() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return {
    robot: params.get('robot'),
    // Which of a machine's upstream URDFs the stage is on. Absent means its
    // default, so the plain `#robot=g1` a card links to keeps working and only
    // a version someone actually chose ends up in the address.
    variant: params.get('v'),
    // The model the visitor picked off their own disk. It has no id worth
    // putting in the address — the files behind it live in this tab and
    // nowhere else — so the address only records that the stage is on it.
    custom: params.has('custom'),
    // Several robots at once rather than one: the category they are compared
    // in, and which of them — `ids=g1.g1_23dof,h1` names a version of a model
    // after a dot, so a comparison is a link someone can send.
    compare: params.has('compare'),
    compareCategory: params.get('cat') || '',
    compareIds: (params.get('ids') || '').split(',').filter(Boolean),
    category: params.get('category') || 'all',
    q: params.get('q') || '',
  };
}

/** The address for a state: a robot, a comparison, or the gallery at a section. */
function hashFor({ robot, variant, custom, compare, compareCategory, compareIds, category, q }) {
  // Written by hand rather than through URLSearchParams: the selection reads as
  // a comma-separated list of ids, and percent-encoding the commas would only
  // make a link nobody can read at a glance.
  if (compare) {
    return [
      'compare=1',
      compareCategory ? `cat=${compareCategory}` : '',
      compareIds?.length ? `ids=${compareIds.join(',')}` : '',
    ]
      .filter(Boolean)
      .join('&');
  }
  const params = new URLSearchParams();
  if (custom) params.set('custom', '1');
  else if (robot) {
    params.set('robot', robot);
    if (variant) params.set('v', variant);
  } else {
    if (category && category !== 'all') params.set('category', category);
    if (q) params.set('q', q);
  }
  return params.toString();
}

function writeHash(state) {
  const hash = hashFor(state);
  const next = hash ? `#${hash}` : location.pathname;
  if (next !== location.hash && !(hash === '' && location.hash === '')) {
    history.replaceState(null, '', next);
  }
}

/**
 * Theme is stamped on <html> before first paint by js/theme-init.js; this only
 * handles the toggle. js/theme.js owns the switch itself, so the 3D stage can
 * hear about it without knowing this button exists.
 */
function setupTheme() {
  const button = document.getElementById('theme-toggle');
  const render = () => {
    // Show the theme you would switch *to*, with the reference site's glyphs.
    button.textContent = theme() === 'light' ? '🌙' : '☀️';
  };
  render();
  button.addEventListener('click', () => {
    toggleTheme();
    render();
  });
}

/**
 * The coffee cup in the header: one <dialog> holding the WeChat code, so the
 * browser owns the backdrop, the focus trap and Escape. Its text is marked up
 * with `data-i18n`, so switching language needs nothing from here.
 */
function setupSponsor() {
  const button = document.getElementById('sponsor-toggle');
  const dialog = document.getElementById('sponsor-dialog');
  if (!button || !dialog) return;
  button.addEventListener('click', () => {
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  });
  document.getElementById('sponsor-close')?.addEventListener('click', () => {
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  });
  // Clicking the backdrop closes it. The backdrop is not a node of its own, so
  // the test is the pointer against the dialog's box — `event.target === dialog`
  // would also fire on the dialog's own padding and close it from the inside.
  dialog.addEventListener('click', (event) => {
    const box = dialog.getBoundingClientRect();
    const outside =
      event.clientX < box.left || event.clientX > box.right ||
      event.clientY < box.top || event.clientY > box.bottom;
    // A keyboard-driven click reports (0, 0) and is never the backdrop.
    if (outside && (event.clientX || event.clientY)) dialog.close();
  });
}

/**
 * One button that names the language you would switch *to*, as on
 * Humanoid_Robot_Learning_Paper_Notebooks. Switching applies in place —
 * a reload would paint the other language's HTML for a frame, and would
 * drop a model the visitor had just picked off disk.
 */
function setupLang(onChange) {
  const button = document.getElementById('lang-toggle');
  button.addEventListener('click', () => {
    setLang(lang() === 'zh' ? 'en' : 'zh');
    applyChrome();
    onChange();
  });
}

function syncDocumentTitle() {
  const at = parseHash();
  if (at.compare) document.title = pageTitle(t('compare.title'));
  else if (at.robot || at.custom) {
    const name = document.getElementById('d-name')?.textContent;
    document.title = name && name !== '—' ? pageTitle(name) : pageTitle();
  } else document.title = pageTitle();
}

async function main() {
  setupTheme();
  setupSponsor();
  // Language is already on the static nodes: js/i18n-boot.js ran first.
  if (document.documentElement.classList.contains('i18n-pending')) {
    setLang(detectLang());
    applyChrome();
    document.documentElement.classList.remove('i18n-pending');
  }
  paintIcons();
  let gallery = null;
  let detail = null;
  let compare = null;
  setupLang(() => {
    gallery?.render();
    applyCustomLang();
    detail?.applyLang();
    compare?.applyLang();
    syncDocumentTitle();
  });
  for (const el of document.querySelectorAll('[data-year]')) {
    el.textContent = String(new Date().getFullYear());
  }

  let data;
  try {
    data = await loadRegistry();
  } catch (err) {
    document.getElementById('grid').innerHTML =
      `<p class="empty">Could not load data/robots.json — run <code>npm run registry</code>.<br><small>${err.message}</small></p>`;
    return;
  }

  gallery = new Gallery(data, (id) => {
    location.hash = `robot=${id}`;
  });

  /** The compare view, built the first time it is asked for. */
  function comparison() {
    if (!compare) {
      compare = new Compare(data, (state) =>
        writeHash({ compare: true, compareCategory: state.category, compareIds: state.ids }),
      );
    }
    return compare;
  }

  const initial = parseHash();
  gallery.state.query = initial.q;
  document.getElementById('search').value = initial.q;
  gallery.renderStats();
  gallery.render();
  gallery.onStateChange = (state) => {
    // The search box is in the header, so it is reachable from a stage too —
    // and writing the gallery's address while one is open would close it.
    const at = parseHash();
    if (!at.robot && !at.custom && !at.compare) {
      writeHash({ category: state.category, q: state.query });
    }
  };
  // The gallery is long now that every category is on it at once, so coming
  // back from a detail page returns to the card that was clicked, not the top.
  let galleryScroll = 0;
  // Which machine the stage is already on, so that swapping between two of its
  // versions is not mistaken for arriving at a new robot.
  let stagedId = null;

  async function route() {
    const at = parseHash();
    const { robot: id, variant, category, custom } = at;
    if (at.compare) {
      if (detail?.isFullscreen()) detail.exitFullscreen();
      if (!views.gallery.hidden) galleryScroll = window.scrollY;
      const arriving = views.compare.hidden;
      views.gallery.hidden = true;
      views.detail.hidden = true;
      views.compare.hidden = false;
      document.title = pageTitle(t('compare.title'));
      if (arriving) window.scrollTo({ top: 0 });
      await comparison().show({ category: at.compareCategory, ids: at.compareIds });
      return;
    }
    // Its 3D stage stays loaded — coming back from a robot's detail page and
    // waiting for six sets of meshes again would be its own punishment — but
    // it cannot be left covering the screen.
    if (compare?.stage.isFullscreen()) compare.stage.exitFullscreen();
    views.compare.hidden = true;
    // Nothing is stored for a picked model: a reload, or this address opened on
    // another machine, has no files behind it and belongs back at the gallery.
    const picked = custom ? customEntry() : null;
    if (custom && !picked) {
      location.hash = '';
      return;
    }
    if (!id && !picked) {
      // The gallery cannot be read through a stage that covers the screen —
      // reachable through the browser's back button, since the detail view's
      // own way out is off screen in fullscreen.
      if (detail?.isFullscreen()) detail.exitFullscreen();
      views.detail.hidden = true;
      views.gallery.hidden = false;
      // The card grid measures itself, and a hidden view has nothing to measure:
      // a search run from a stage re-renders the gallery behind it, so the way
      // back is where those spans are worked out.
      gallery.relayout();
      document.title = pageTitle();
      // `#category=quadruped` is a link to a section of the page: honour it on
      // the first load and whenever the address bar names a section other than
      // the one being read. Coming back from a robot it names that same
      // section, and then the remembered scroll is the better answer — it
      // returns to the card that was clicked rather than the section's top.
      if (category !== gallery.state.category) gallery.jumpTo(category, { smooth: false });
      else window.scrollTo({ top: galleryScroll });
      writeHash(gallery.state);
      return;
    }
    const robot = picked || byId(data, id);
    if (!robot) {
      location.hash = '';
      return;
    }
    if (!views.gallery.hidden) galleryScroll = window.scrollY;
    views.gallery.hidden = true;
    views.detail.hidden = false;
    // A new robot starts at the top of its page; picking another version of the
    // one already open leaves the reader where they were, since the version row
    // they just used is halfway down a long page on a phone.
    if (stagedId !== robot.id) window.scrollTo({ top: 0 });
    stagedId = robot.id;
    if (!detail) {
      detail = new Detail(data);
      detail.onPickVersion = (v) => {
        location.hash = hashFor({ robot: detail.model.id, variant: v });
      };
    }
    detail.relayout();
    if (!picked) setupNeighbours(robot);
    await detail.show(robot, variant);
  }

  function setupNeighbours(robot) {
    const list = gallery.visible();
    const index = list.findIndex((r) => r.id === robot.id);
    const pool = index === -1 ? data.robots : list;
    const at = index === -1 ? pool.findIndex((r) => r.id === robot.id) : index;
    const prev = pool[(at - 1 + pool.length) % pool.length];
    const next = pool[(at + 1) % pool.length];
    const prevBtn = document.getElementById('prev-robot');
    const nextBtn = document.getElementById('next-robot');
    prevBtn.onclick = () => (location.hash = `robot=${prev.id}`);
    nextBtn.onclick = () => (location.hash = `robot=${next.id}`);
    prevBtn.title = prev.name;
    nextBtn.title = next.name;
  }

  // Leaving a robot returns to the gallery as it was — same section, same
  // search — rather than to a bare address that reads as "start from the top".
  const toGallery = () => {
    location.hash = hashFor(gallery.state);
  };
  document.getElementById('back-btn').addEventListener('click', toGallery);
  document.getElementById('compare-back').addEventListener('click', toGallery);

  // From a robot to a comparison it is part of. The version on the stage is the
  // one that goes in: on the G1 that is a choice between twenty-one files, and
  // the one being looked at is the one meant.
  document.getElementById('add-compare').addEventListener('click', () => {
    const state = parseHash();
    // Or from the model the visitor picked off their own disk, which joins
    // whichever comparison is open rather than bringing a category of its own.
    const robot = state.custom ? customEntry() : state.robot ? byId(data, state.robot) : null;
    if (!robot) return;
    comparison().add(robot, state.variant || null);
    location.hash = hashFor({
      compare: true,
      compareCategory: comparison().category,
      compareIds: comparison().ids,
    });
  });

  setupCustomPicker({
    onPreview: () => {
      // Picking a second file without leaving the stage lands on the address
      // already showing, and an unchanged hash fires no `hashchange`.
      if (parseHash().custom) route();
      else location.hash = 'custom=1';
    },
  });

  /** Both kinds of stage: a gallery robot, and the visitor's own file. */
  const onStage = () => {
    const state = parseHash();
    return !!(state.robot || state.custom);
  };

  window.addEventListener('hashchange', route);
  window.addEventListener('keydown', (event) => {
    // Escape leaves the fullscreen stage from wherever the focus is, the joint
    // sliders included — in fullscreen they are what the visitor is holding
    // when they want out, and the guard below would swallow it. Only once the
    // stage is back in the page does Escape mean "leave this robot".
    // (Where the browser runs a native fullscreen it closes that on Escape
    // itself; `fullscreenchange` then brings the class down.)
    if (event.key === 'Escape' && detail?.isFullscreen()) {
      detail.exitFullscreen();
      return;
    }
    // The compare page's shared stage goes fullscreen the same way, and leaves
    // it the same way — before Escape is read as "leave this comparison".
    if (event.key === 'Escape' && compare?.stage.isFullscreen()) {
      compare.stage.exitFullscreen();
      return;
    }
    if (event.target.matches('input, textarea')) return;
    if (event.key === 'Escape' && (onStage() || parseHash().compare)) toGallery();
    // Prev/next walk the gallery, so they are for a gallery robot: the picked
    // model has no neighbours, and the buttons still hold the last robot's.
    if (parseHash().robot) {
      if (event.key === 'ArrowLeft') document.getElementById('prev-robot')?.click();
      if (event.key === 'ArrowRight') document.getElementById('next-robot')?.click();
    }
    // `f` for the stage, as every video player has it — bare, so the browser
    // keeps Ctrl/⌘-F for its own find bar.
    if (event.key === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (onStage()) detail?.toggleFullscreen();
      else if (parseHash().compare && compare?.stage.open) compare.stage.toggleFullscreen();
    }
    if (event.key === '/') {
      event.preventDefault();
      document.getElementById('search').focus();
    }
  });

  await route();
}

main();

// Expose the language list for the console / debugging.
window.__rug = { LANGS };
