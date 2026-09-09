// ROOMTONE — audio-reactive room lighting for Windows.
// Copyright (C) 2026 Robin
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU General Public License as published by the Free
// Software Foundation, version 3.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
// FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for
// more details. You should have received a copy of the licence along with
// this program. If not, see <https://www.gnu.org/licenses/>.

// A very small template renderer.
//
// The design prototype was written for Claude Design's canvas runtime, whose
// template dialect this reimplements — just enough of it, and nothing more:
//
//   data-if="expr"                 keep this subtree only when expr is truthy
//   data-for="list" data-as="item" repeat the subtree once per list entry
//   {{ expr }}                     in text nodes and attribute values
//   data-on-click="handler"        bind a function from the render values
//   data-ref="name"                stash the element on the refs object
//
// Expressions are dotted paths and nothing else — no eval, no expression
// parser, no way for template text to execute anything.
//
// Rendering is deliberately naive: on any state change the whole tree is
// rebuilt from a pristine template and the app re-caches its nodes. That
// sounds expensive, and would be if it ran per frame — but it does not. State
// changes happen on clicks and keypresses. The 60 Hz work is direct style
// writes onto cached nodes, which never touch this file.

const BINDING = /\{\{\s*([\w.$]+)\s*\}\}/g;

/** Resolve a dotted path against the scope chain, innermost first. */
function resolve(path, scopes) {
  const [head, ...rest] = path.split('.');

  let value;
  let found = false;
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (scopes[i] && head in scopes[i]) {
      value = scopes[i][head];
      found = true;
      break;
    }
  }
  if (!found) return undefined;

  for (const key of rest) {
    if (value == null) return undefined;
    value = value[key];
  }
  return value;
}

function interpolate(text, scopes) {
  return text.replace(BINDING, (_, path) => {
    const v = resolve(path, scopes);
    return v == null ? '' : String(v);
  });
}

/**
 * Render `template` (an element) against `values`, returning a fresh tree.
 * `refs` is populated with any data-ref elements.
 */
export function render(template, values, refs = {}) {
  const root = template.cloneNode(true);
  // The root carries the app's own inline styles — the base text colour, the
  // font stack, the fixed full-screen frame. Bind it like any other element and
  // return it intact; unwrapping it here would silently strip all of that.
  bindElement(root, [values], refs);
  walk(root, [values], refs);
  return root;
}

function walk(node, scopes, refs) {
  // Children are collected first: the list mutates as we expand and remove.
  const children = Array.from(node.childNodes);

  for (const child of children) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.nodeValue.includes('{{')) {
        child.nodeValue = interpolate(child.nodeValue, scopes);
      }
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    // -- data-if ---------------------------------------------------------
    if (child.hasAttribute('data-if')) {
      const keep = resolve(child.getAttribute('data-if'), scopes);
      if (!keep) {
        child.remove();
        continue;
      }
      child.removeAttribute('data-if');
    }

    // -- data-for --------------------------------------------------------
    if (child.hasAttribute('data-for')) {
      const list = resolve(child.getAttribute('data-for'), scopes) || [];
      const as = child.getAttribute('data-as') || 'item';

      const pattern = child.cloneNode(true);
      pattern.removeAttribute('data-for');
      pattern.removeAttribute('data-as');

      const fragment = document.createDocumentFragment();
      for (const item of list) {
        const instance = pattern.cloneNode(true);
        walk(instance, [...scopes, { [as]: item }], refs);
        // The wrapper is display:contents, so unwrap into the fragment.
        while (instance.firstChild) fragment.appendChild(instance.firstChild);
      }

      child.replaceWith(fragment);
      continue;
    }

    bindElement(child, scopes, refs);
    walk(child, scopes, refs);
  }
}

function bindElement(el, scopes, refs) {
  for (const attr of Array.from(el.attributes)) {
    const { name, value } = attr;

    if (name === 'data-ref') {
      refs[value] = el;
      el.removeAttribute('data-ref');
      continue;
    }

    if (name.startsWith('data-on-')) {
      const handler = resolve(value, scopes);
      const event = name.slice('data-on-'.length);
      if (typeof handler === 'function') el.addEventListener(event, handler);
      el.removeAttribute(name);
      continue;
    }

    if (value.includes('{{')) {
      const resolved = interpolate(value, scopes);
      el.setAttribute(name, resolved);
      // Range inputs ignore the attribute once they have a live value.
      if (name === 'value' && 'value' in el) el.value = resolved;
    }
  }
}
