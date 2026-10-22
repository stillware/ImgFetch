/*
 * ImgFetch - smart image downloader
 * Copyright (C) 2026 ImgFetch Developer
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/**
 * ImgFetch, tests/test-security.mjs
 * Phase E security tests. Hostile-input tables (at least 40 cases per
 * area) for the SVG sanitizer, filename building, the private-network URL
 * guard, settings validation and message validation; a static scan for
 * forbidden DOM APIs; and a seeded fuzz over the pure functions asserting
 * the safety invariants (never throws unhandled, output always safe).
 *
 * Runs with plain Node, no dependencies:
 *   node tests/test-security.mjs
 * The real-DOM section self-skips unless jsdom is importable, e.g.:
 *   NODE_PATH=$IMGFETCH_TESTDEPS/node_modules node tests/test-security.mjs
 */
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  sanitizeSvgDocument,
  isSafeSvgUrl,
  stripSvgDoctype,
} from '../core/svg.js';
import {
  sanitizeSegment,
  buildFilename,
  joinDownloadPath,
  safeExtension,
  parseSettingsImport,
} from '../core/filenames.js';
import { safeZipName } from '../core/zip.js';
import {
  normalizeUrl,
  isPrivateNetworkUrl,
  isPrivateNetworkFetchBlocked,
  isRedirectBlocked,
  DATA_URL_DOWNLOAD_MAX,
} from '../core/urls.js';
import { dataUrlToBytes } from '../core/data-url.js';
import { normalizeSettings, DEFAULT_SETTINGS } from '../core/settings.js';
import {
  isValidMessage,
  senderKind,
  SENDER_RULES,
  MESSAGE_TYPES,
  isValidCaptureId,
  isValidCaptureGroupId,
} from '../core/validation.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${extra ? `, ${extra}` : ''}`);
  }
}

// Deterministic PRNG (mulberry32), fixed seed, so the fuzz is reproducible.
function rng32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------ compact stub DOM */

function makeStubEl(tag, attrs = {}, children = []) {
  const el = {
    tagName: tag,
    attributes: Object.entries(attrs).map(([name, value]) => ({
      name,
      value: String(value),
    })),
    childNodes: children,
    removed: false,
    get textContent() {
      return this.childNodes
        .map((c) => (typeof c === 'string' ? c : c.textContent))
        .join('');
    },
    set textContent(v) {
      this.childNodes = [String(v)];
    },
    remove() {
      this.removed = true;
    },
    removeAttribute(name) {
      this.attributes = this.attributes.filter((a) => a.name !== name);
    },
    setAttribute(name, value) {
      const a = this.attributes.find((x) => x.name === name);
      if (a) a.value = String(value);
      else this.attributes.push({ name, value: String(value) });
    },
  };
  return el;
}

function makeStubDoc(els) {
  const all = [];
  const walk = (n) => {
    all.push(n);
    for (const c of n.childNodes) {
      if (typeof c !== 'string') walk(c);
    }
  };
  for (const e of els) walk(e);
  return {
    querySelectorAll: (sel) => (sel === '*' ? all.slice() : []),
    querySelector: () => null,
  };
}

function stubAttr(el, name) {
  const a = el.attributes.find((x) => String(x.name).toLowerCase() === name);
  return a ? a.value : null;
}

function hasStubAttr(el, name) {
  return el.attributes.some((x) => String(x.name).toLowerCase() === name);
}

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');

/* ================================================ 1. isSafeSvgUrl */

console.log('1. isSafeSvgUrl hostile table');
{
  const cases = [
    // [name, input, expected]
    ['javascript: plain', 'javascript:alert(1)', false],
    ['javascript: mixed case', 'JaVaScRiPt:alert(1)', false],
    ['javascript: tab inside scheme', 'java\tscript:alert(1)', false],
    ['javascript: newline inside scheme', 'java\nscript:alert(1)', false],
    ['javascript: CR inside scheme', 'java\rscript:alert(1)', false],
    ['javascript: NUL inside scheme', 'java\0script:alert(1)', false],
    ['javascript: tab mid scheme', 'jav\tascript:alert(1)', false],
    ['javascript: padded', '  javascript:alert(1)  ', false],
    ['javascript: uppercase with spaces', '  JAVASCRIPT:alert(1)', false],
    ['vbscript:', 'vbscript:msgbox(1)', false],
    ['data:text/html raw', 'data:text/html,<script>alert(1)</script>', false],
    ['data:text/html base64', 'data:text/html;base64,' + b64('<script>alert(1)</script>'), false],
    ['data:application/xhtml+xml', 'data:application/xhtml+xml,<x/>', false],
    ['data:image/svg raw script', 'data:image/svg+xml,<svg><script>alert(1)</script></svg>', false],
    ['data:image/svg encoded script', 'data:image/svg+xml,' + encodeURIComponent('<svg><script>alert(1)</script></svg>'), false],
    ['data:image/svg base64 script', 'data:image/svg+xml;base64,' + b64('<svg><script>alert(1)</script></svg>'), false],
    ['data:image/svg base64 script, uppercase meta', 'DATA:IMAGE/SVG+XML;BASE64,' + b64('<svg><script>alert(1)</script></svg>'), false],
    // An onload-only nested payload has no <script> and no javascript: URL.
    // It is allowed but inert: nested SVGs render scriptless in the image
    // and paint contexts where these URLs are used.
    ['data:image/svg base64 onload-only documented', 'data:image/svg+xml;base64,' + b64('<svg onload=alert(1)>'), true],
    ['data:image/svg base64 javascript: text', 'data:image/svg+xml;base64,' + b64('x javascript:alert(1)'), false],
    ['data:image/svg base64 with charset', 'data:image/svg+xml;charset=utf-8;base64,' + b64('<script>alert(1)</script>'), false],
    ['blob: rejected', 'blob:https://example.com/uuid-1', false],
    ['file: rejected', 'file:///etc/passwd', false],
    ['about:blank rejected', 'about:blank', false],
    ['ftp: rejected', 'ftp://example.com/x.png', false],
    ['mailto: rejected', 'mailto:x@y.z', false],
    ['tel: rejected', 'tel:123', false],
    ['data: empty rejected', 'data:,', false],
    ['empty string', '', false],
    ['whitespace only', '   ', false],
    ['null', null, false],
    ['undefined', undefined, false],
    ['number', 42, false],
    ['html entity in scheme', '&#106;avascript:alert(1)', false],
    ['hex entity in scheme', '&#x6A;avascript:alert(1)', false],
    ['fragment allowed', '#grad', true],
    ['bare hash allowed', '#', true],
    ['fragment with dashes', '#frag-ment_1', true],
    ['https allowed', 'https://example.com/a.png', true],
    ['http allowed', 'http://example.com/a.svg', true],
    ['https uppercase allowed', 'HTTPS://EXAMPLE.COM/A.PNG', true],
    ['https with port/query allowed', 'https://example.com:8080/p?a=b#c', true],
    ['external https documented as allowed', 'https://evil.example/track.png', true],
    ['data:image/png base64 allowed', 'data:image/png;base64,iVBORw0KGgo=', true],
    ['data:image/svg base64 clean allowed', 'data:image/svg+xml;base64,' + b64('<svg><rect width="1"/></svg>'), true],
    ['data:image/svg raw clean allowed', 'data:image/svg+xml,<svg></svg>', true],
    ['data:image/gif allowed', 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', true],
    // Double-encoded: the browser decodes percent-encoding once, so the
    // payload stays literal text, never a tag. Safe to allow.
    ['double-encoded stays literal', 'data:image/svg+xml,%253Cscript%253Ealert(1)%253C/script%253E', true],
    ['empty data:image tolerated', 'data:image/', true],
  ];
  for (const [name, input, expected] of cases) {
    let got;
    try {
      got = isSafeSvgUrl(input);
    } catch (err) {
      check(`isSafeSvgUrl: ${name}`, false, `threw ${err}`);
      continue;
    }
    check(`isSafeSvgUrl: ${name}`, got === expected, `got ${got}`);
  }
}

/* ================================================ 2. stripSvgDoctype */

console.log('2. stripSvgDoctype');
{
  const cases = [
    [
      'internal subset with entities removed',
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "x"><!ENTITY b "&a;&a;">]><svg><rect/></svg>',
      (out) => !/<!doctype|<!entity/i.test(out) && out.includes('<svg>'),
    ],
    [
      'billion-laughs shape removed',
      '<!DOCTYPE lolz [<!ENTITY lol "lollollollollollollollol"><!ENTITY lol2 "&lol;&lol;&lol;">]><svg/>',
      (out) => !/<!doctype|<!entity|&lol/i.test(out) && out.includes('<svg/>'),
    ],
    [
      'external DTD removed',
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg/>',
      (out) => !/doctype/i.test(out) && out.includes('<svg/>'),
    ],
    [
      'quoted > inside subset handled',
      '<!DOCTYPE svg [<!ENTITY gt ">">]><svg/>',
      (out) => !/doctype|entity/i.test(out) && out.includes('<svg/>'),
    ],
    [
      'double DOCTYPE both removed',
      '<!DOCTYPE svg><!DOCTYPE svg><svg/>',
      (out) => !/doctype/i.test(out) && out.includes('<svg/>'),
    ],
    [
      'case-insensitive marker',
      '<!doctype SVG><svg/>',
      (out) => !/doctype/i.test(out),
    ],
    [
      'unterminated dropped fail-closed',
      '<svg><!DOCTYPE xxx',
      (out) => out === '<svg>',
    ],
    [
      'no doctype untouched',
      '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
      (out, inp) => out === inp,
    ],
    [
      'empty input',
      '',
      (out) => out === '',
    ],
    [
      'non-string coerced',
      null,
      (out) => out === '',
    ],
    [
      'xxe system entity removed',
      '<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg><text>&xxe;</text></svg>',
      (out) => !/<!doctype|<!entity/i.test(out) && !/SYSTEM/i.test(out),
    ],
    [
      'predefined entities survive the cleanup',
      '<!DOCTYPE svg [<!ENTITY a "x">]><svg><text>&a; &amp; &lt;</text></svg>',
      (out) => !/&a;/.test(out) && /&amp;/.test(out) && /&lt;/.test(out),
    ],
    [
      'numeric character references survive',
      '<!DOCTYPE svg [<!ENTITY a "x">]><svg><text>&a;&#65;&#x41;</text></svg>',
      (out) => !/&a;/.test(out) && /&#65;/.test(out) && /&#x41;/.test(out),
    ],
    [
      'entity refs kept when no entities were defined',
      '<svg><text>&nosuch;</text></svg>',
      (out, inp) => out === inp,
    ],
    [
      'entityless doctype stripped without touching text',
      '<!DOCTYPE svg PUBLIC "-//X" "u"><svg><text>a &amp; b</text></svg>',
      (out) => out === '<svg><text>a &amp; b</text></svg>',
    ],
    [
      'output never longer than input',
      '<!DOCTYPE svg [<!ENTITY a "1">]><svg/>',
      (out, inp) => out.length < inp.length,
    ],
  ];
  for (const [name, input, pred] of cases) {
    let out;
    try {
      out = stripSvgDoctype(input);
    } catch (err) {
      check(`stripSvgDoctype: ${name}`, false, `threw ${err}`);
      continue;
    }
    check(`stripSvgDoctype: ${name}`, pred(out, input) === true, `got ${JSON.stringify(out).slice(0, 80)}`);
  }
}

/* ================================================ 3. sanitizeSvgDocument (stub DOM) */

console.log('3. sanitizeSvgDocument hostile table');
{
  let n = 0;
  const t = (name, fn) => {
    n += 1;
    try {
      fn();
      pass += 1;
    } catch (err) {
      fail += 1;
      console.log(`  FAIL sanitizeSvgDocument: ${name}, ${err.message}`);
    }
  };
  const docWith = (el) => makeStubDoc([el]);
  const single = (tag, attrs = {}, children = []) => makeStubEl(tag, attrs, children);

  // Dangerous elements are removed outright.
  for (const tag of ['script', 'foreignObject', 'iframe', 'embed', 'object', 'link', 'meta', 'base', 'marquee', 'handler', 'noscript', 'html', 'body']) {
    t(`<${tag}> removed`, () => {
      const el = single(tag, { id: 'x' });
      sanitizeSvgDocument(docWith(el));
      assert.ok(el.removed, 'element must be removed');
    });
  }
  t('script nested in defs removed', () => {
    const s = single('script', {}, ['alert(1)']);
    const defs = single('defs', {}, [s]);
    sanitizeSvgDocument(docWith(defs));
    assert.ok(s.removed);
    assert.ok(!defs.removed, 'defs itself must survive');
  });
  t('xhtml-namespaced script still removed', () => {
    const el = single('script', { xmlns: 'http://www.w3.org/1999/xhtml' });
    el.tagName = 'script';
    sanitizeSvgDocument(docWith(el));
    assert.ok(el.removed);
  });
  t('foreignObject subtree removed with children', () => {
    const kid = single('div', {});
    const el = single('foreignObject', { width: '10', height: '10' }, [kid]);
    sanitizeSvgDocument(docWith(el));
    assert.ok(el.removed);
  });

  // Event handler attributes are removed (any case).
  for (const attr of ['onclick', 'ONCLICK', 'onload', 'onmouseover', 'onerror', 'onfocus', 'onbegin', 'OnMouseMove']) {
    t(`event attribute ${attr} removed`, () => {
      const el = single('rect', { [attr]: 'alert(1)', width: '10' });
      sanitizeSvgDocument(docWith(el));
      assert.ok(!el.removed, 'rect must survive');
      assert.ok(!hasStubAttr(el, attr), 'handler must be gone');
      assert.equal(stubAttr(el, 'width'), '10', 'safe attr kept');
    });
  }

  // URL attributes: javascript: and obfuscations rejected, safe ones kept.
  const urlCases = [
    ['javascript: href rejected', 'a', 'href', 'javascript:alert(1)', false],
    ['javascript: tab rejected', 'a', 'href', 'java\tscript:alert(1)', false],
    ['javascript: newline rejected', 'a', 'href', 'java\nscript:alert(1)', false],
    ['javascript: mixed case rejected', 'a', 'href', 'JaVaScRiPt:alert(1)', false],
    ['xlink:href javascript: rejected', 'a', 'xlink:href', 'javascript:alert(1)', false],
    ['src javascript: rejected', 'image', 'src', 'javascript:alert(1)', false],
    ['data:text/html rejected', 'a', 'href', 'data:text/html,<b>x</b>', false],
    ['data:image/svg script rejected', 'image', 'href', 'data:image/svg+xml,' + encodeURIComponent('<svg><script>alert(1)</script></svg>'), false],
    ['data:image/svg base64 script rejected', 'image', 'href', 'data:image/svg+xml;base64,' + b64('<svg><script>alert(1)</script></svg>'), false],
    ['vbscript: rejected', 'a', 'href', 'vbscript:x', false],
    ['fragment kept', 'use', 'href', '#grad', true],
    ['https kept', 'image', 'href', 'https://example.com/a.png', true],
    ['data:image/png kept', 'image', 'href', 'data:image/png;base64,iVBORw0KGgo=', true],
    ['data:image/svg clean base64 kept', 'image', 'href', 'data:image/svg+xml;base64,' + b64('<svg/>'), true],
  ];
  for (const [name, tag, attrName, value, keep] of urlCases) {
    t(name, () => {
      const el = single(tag, { [attrName]: value });
      sanitizeSvgDocument(docWith(el));
      assert.ok(!el.removed, `${tag} must survive`);
      assert.equal(hasStubAttr(el, attrName), keep, `attr kept=${keep}`);
    });
  }

  // SMIL href retargeting.
  t('<set attributeName=href removed', () => {
    const el = single('set', { attributeName: 'href', to: '#x' });
    sanitizeSvgDocument(docWith(el));
    assert.ok(el.removed);
  });
  t('<set attributeName=xlink:href removed', () => {
    const el = single('set', { attributeName: 'xlink:href', to: '#x' });
    sanitizeSvgDocument(docWith(el));
    assert.ok(el.removed);
  });
  t('<set attributeName=HREF (case) removed', () => {
    const el = single('set', { attributeName: 'HREF', to: '#x' });
    sanitizeSvgDocument(docWith(el));
    assert.ok(el.removed);
  });
  t('<animate attributeName=href removed', () => {
    const el = single('animate', { attributeName: 'href', values: '#x', dur: '1s' });
    sanitizeSvgDocument(docWith(el));
    assert.ok(el.removed);
  });
  t('<set to=javascript: removed', () => {
    const el = single('set', { attributeName: 'opacity', to: 'javascript:alert(1)' });
    sanitizeSvgDocument(docWith(el));
    assert.ok(el.removed);
  });
  t('<animate values with javascript: removed', () => {
    const el = single('animate', { attributeName: 'opacity', values: '0;javascript:alert(1)' });
    sanitizeSvgDocument(docWith(el));
    assert.ok(el.removed);
  });
  t('innocent <animate> kept', () => {
    const el = single('animate', { attributeName: 'opacity', values: '0;1', dur: '1s' });
    sanitizeSvgDocument(docWith(el));
    assert.ok(!el.removed);
  });
  t('innocent <set> kept', () => {
    const el = single('set', { attributeName: 'fill', to: 'red' });
    sanitizeSvgDocument(docWith(el));
    assert.ok(!el.removed);
  });
  t('<mpath> href javascript: rejected', () => {
    const el = single('mpath', { href: 'javascript:alert(1)' });
    sanitizeSvgDocument(docWith(el));
    assert.ok(!el.removed);
    assert.ok(!hasStubAttr(el, 'href'));
  });

  // CSS: @import stripped, external url() neutralized, fragments kept.
  t('<style> @import stripped', () => {
    const el = single('style', {}, ['@import url("https://evil.example/x.css"); .a{fill:red}']);
    sanitizeSvgDocument(docWith(el));
    assert.ok(!el.removed);
    assert.ok(!/@import/i.test(el.textContent), '@import must be gone');
    assert.ok(!/evil\.example/.test(el.textContent), 'external host must be gone');
    assert.ok(/fill:red/.test(el.textContent), 'safe CSS kept');
  });
  t('<style> external url() stripped, fragment kept', () => {
    const el = single('style', {}, ['.a{fill:url(https://evil.example/x.svg)} .b{fill:url(#grad)}']);
    sanitizeSvgDocument(docWith(el));
    assert.ok(!/evil\.example/.test(el.textContent));
    assert.ok(/url\(#grad\)/.test(el.textContent), 'fragment url kept');
  });
  t('style attribute @import stripped', () => {
    const el = single('rect', { style: '@import "https://evil.example/x.css"; fill: red' });
    sanitizeSvgDocument(docWith(el));
    const v = stubAttr(el, 'style') || '';
    assert.ok(!/@import/i.test(v));
    assert.ok(!/evil\.example/.test(v));
  });
  t('style attribute javascript: url neutralized', () => {
    const el = single('rect', { style: 'fill:url(javascript:alert(1))' });
    sanitizeSvgDocument(docWith(el));
    assert.ok(!/javascript:/i.test(stubAttr(el, 'style') || ''));
  });
  t('fill=url(https://evil) becomes none', () => {
    const el = single('rect', { fill: 'url(https://evil.example/g)' });
    sanitizeSvgDocument(docWith(el));
    assert.ok(!/evil\.example/.test(stubAttr(el, 'fill') || ''));
  });
  t('fill=url(#g) kept', () => {
    const el = single('rect', { fill: 'url(#g)' });
    sanitizeSvgDocument(docWith(el));
    assert.equal(stubAttr(el, 'fill'), 'url(#g)');
  });

  // Attribute allowlist.
  t('unknown attributes removed', () => {
    const el = single('rect', { 'data-x': '1', formaction: 'https://evil.example/', autofocus: '' });
    sanitizeSvgDocument(docWith(el));
    assert.ok(!hasStubAttr(el, 'data-x'));
    assert.ok(!hasStubAttr(el, 'formaction'));
    assert.ok(!hasStubAttr(el, 'autofocus'));
  });
  t('safe attributes kept', () => {
    const el = single('path', { id: 'p1', d: 'M0 0L10 10', fill: 'red', tabindex: '0' });
    sanitizeSvgDocument(docWith(el));
    assert.ok(!el.removed);
    assert.equal(stubAttr(el, 'd'), 'M0 0L10 10');
    assert.equal(stubAttr(el, 'id'), 'p1');
  });
  t('style element keeps only id/media', () => {
    const el = single('style', { id: 's1', fill: 'red', media: 'screen' }, ['.a{fill:red}']);
    sanitizeSvgDocument(docWith(el));
    assert.ok(!el.removed);
    assert.equal(stubAttr(el, 'id'), 's1');
    assert.equal(stubAttr(el, 'media'), 'screen');
    assert.ok(!hasStubAttr(el, 'fill'));
  });
  t('innocent artwork survives', () => {
    const els = [
      single('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 10 10' }),
      single('defs', {}),
      single('linearGradient', { id: 'g' }),
      single('rect', { width: '10', height: '10', fill: 'url(#g)' }),
      single('circle', { cx: '5', cy: '5', r: '4' }),
      single('text', { 'font-size': '12' }, ['hi']),
    ];
    const removed = sanitizeSvgDocument(makeStubDoc(els));
    assert.equal(removed, 0);
    for (const el of els) assert.ok(!el.removed, `${el.tagName} must survive`);
  });
  console.log(`  (3) ${n} stub-DOM sanitizer cases`);
}

/* ================================================ 4. real DOM (jsdom, optional) */

console.log('4. sanitizeSvgDocument against a real DOMParser');
{
  const require = createRequire(import.meta.url);
  let JSDOM = null;
  try {
    ({ JSDOM } = require('jsdom'));
  } catch {
    console.log('  SKIPPED: jsdom not importable');
  }
  if (JSDOM) {
    let n = 0;
    const dom = new JSDOM('', { contentType: 'text/html' });
    const parser = new dom.window.DOMParser();
    const serializer = new dom.window.XMLSerializer();
    const clean = (svgText) => {
      const doc = parser.parseFromString(stripSvgDoctype(svgText), 'image/svg+xml');
      sanitizeSvgDocument(doc);
      return serializer.serializeToString(doc);
    };
    const t = (name, fn) => {
      n += 1;
      try {
        fn();
        pass += 1;
      } catch (err) {
        fail += 1;
        console.log(`  FAIL real-DOM: ${name}, ${err.message}`);
      }
    };
    const SVG = (inner) => `<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
    const inert = (out) => {
      assert.ok(!/<script/i.test(out), 'no script element');
      assert.ok(!/javascript:/i.test(out), 'no javascript: URL');
      assert.ok(!/\son\w+\s*=/i.test(out), 'no event handler');
      assert.ok(!/<foreignObject/i.test(out), 'no foreignObject');
    };

    t('entity-encoded javascript: href neutralized', () => {
      const out = clean(SVG('<a href="&#106;avascript:alert(1)"><text>x</text></a>'));
      inert(out);
      assert.ok(!/href/i.test(out) || !/alert/i.test(out), 'dangerous href gone');
    });
    t('uppercase SCRIPT removed by real parser', () => {
      inert(clean(SVG('<SCRIPT>alert(1)</SCRIPT><rect width="1"/>')));
    });
    t('tab/newline javascript: neutralized', () => {
      inert(clean(SVG('<a href="java\tscript:alert(1)"><text>x</text></a>')));
      inert(clean(SVG('<a href="java\nscript:alert(1)"><text>x</text></a>')));
    });
    t('style @import and external url gone', () => {
      const out = clean(SVG('<style>@import url("https://evil.example/x.css"); .a{background:url(https://evil.example/t.png)}</style>'));
      assert.ok(!/@import/i.test(out));
      assert.ok(!/evil\.example/.test(out));
    });
    t('entity DoS shape no longer reaches the parser', () => {
      const evil = '<!DOCTYPE svg [<!ENTITY a "xxxxxxxxxx"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]>' +
        SVG('<text>&b;</text>');
      const stripped = stripSvgDoctype(evil);
      assert.ok(!/<!entity/i.test(stripped), 'entities never reach DOMParser');
      const out = clean(evil);
      assert.ok(!/&b;|xxxxxxxxxx/.test(out), 'entity not expanded');
    });
    t('xxe doctype stripped before parse', () => {
      const out = clean('<!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>' + SVG('<text>&xxe;</text>'));
      assert.ok(!/xxe|passwd/.test(out));
    });
    t('base64 script href removed', () => {
      const href = 'data:image/svg+xml;base64,' + b64('<svg><script>alert(1)</script></svg>');
      inert(clean(SVG(`<image href="${href}" width="5" height="5"/>`)));
    });
    t('foreignObject with HTML script removed', () => {
      inert(clean(SVG('<foreignObject width="10" height="10"><body xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></body></foreignObject>')));
    });
    t('innocent svg keeps rendering', () => {
      const out = clean(SVG('<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="10" height="10" fill="url(#g)"/><text>hi</text>'));
      assert.ok(/linearGradient/.test(out), 'gradient kept');
      assert.ok(/url\(#g\)/.test(out), 'paint reference kept');
      assert.ok(/>hi</.test(out), 'text kept');
    });
    t('animate without href retarget kept', () => {
      const out = clean(SVG('<rect width="10" height="10"><animate attributeName="opacity" values="0;1" dur="1s"/></rect>'));
      assert.ok(/<animate/.test(out), 'innocent animate kept');
    });
    t('set retargeting href removed', () => {
      const out = clean(SVG('<rect width="1" height="1"/><set attributeName="href" to="javascript:alert(9)"/>'));
      assert.ok(!/<set/.test(out), 'retargeting set removed');
      assert.ok(/<rect/.test(out), 'rect kept');
    });
    console.log(`  (4) ${n} real-DOM cases`);
  }
}

/* ================================================ 5. filename building */

console.log('5. filename hostile table');
{
  const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/;
  const segCases = [
    // [name, input, predicate]
    ['path traversal unix', '../../etc/passwd', (s) => !s.includes('/') && !s.includes('..')],
    ['path traversal windows', '..\\..\\windows\\system32', (s) => !/[\\]/.test(s) && !s.includes('..')],
    ['percent-encoded traversal', '%2e%2e%2fsecret', (s) => !s.includes('/') && s !== '..'],
    ['double-encoded stays literal', '%252e%252e', (s) => s === '%2e%2e'],
    ['reserved CON', 'CON', (s) => s === '_CON'],
    ['reserved con lower', 'con', (s) => s === '_con'],
    ['reserved NUL.txt', 'NUL.txt', (s) => s === '_NUL.txt'],
    ['reserved com1', 'com1', (s) => s === '_com1'],
    ['reserved LPT9.doc', 'LPT9.doc', (s) => s === '_LPT9.doc'],
    ['console not reserved', 'console', (s) => s === 'console'],
    ['contact not reserved', 'contact', (s) => s === 'contact'],
    ['control chars stripped', 'a\x00b\x1fc', (s) => s === 'abc'],
    ['newline stripped', 'a\nb', (s) => s === 'ab'],
    ['tab stripped as control char', 'a\tb', (s) => s === 'ab'],
    ['empty', '', (s) => s === ''],
    ['only dots', '...', (s) => s === ''],
    ['only spaces', '   ', (s) => s === ''],
    ['leading dots stripped', '...file', (s) => s === 'file'],
    ['trailing dots stripped', 'file...', (s) => s === 'file'],
    ['very long truncated', 'x'.repeat(500), (s) => s.length <= 96],
    ['unicode kept', 'caf\u00e9 \u4e2d\u6587', (s) => s === 'caf\u00e9 \u4e2d\u6587'],
    ['double spaces collapsed', 'my  file', (s) => s === 'my file'],
    ['nbsp collapsed', 'a\u00a0b', (s) => s === 'a b'],
    ['repeated dots collapsed', 'a....b', (s) => !/\.{2,}/.test(s)],
    ['repeated dashes collapsed', 'a----b', (s) => !/-{2,}/.test(s)],
    ['illegal chars gone', 'a<b>c:d"e/f\\g|h?i*j', (s) => !ILLEGAL.test(s)],
    ['null input', null, (s) => s === ''],
    ['undefined input', undefined, (s) => s === ''],
    ['number coerced', 42, (s) => s === '42'],
    ['dash edges kept', '-x-', (s) => s === '-x-'],
    ['emoji kept', 'pic\ud83d\ude00', (s) => s.includes('\ud83d\ude00')],
  ];
  for (const [name, input, pred] of segCases) {
    let out;
    try {
      out = sanitizeSegment(input);
    } catch (err) {
      check(`sanitizeSegment: ${name}`, false, `threw ${err}`);
      continue;
    }
    check(`sanitizeSegment: ${name}`, pred(out) === true, `got ${JSON.stringify(out).slice(0, 60)}`);
  }

  const extCases = [
    ['exe blocked', 'exe', 'png'],
    ['bat blocked', 'bat', 'png'],
    ['js blocked', 'js', 'png'],
    ['html blocked', 'html', 'png'],
    ['svgz blocked', 'svgz', 'png'],
    ['ps1 blocked', 'ps1', 'png'],
    ['jpg kept', 'jpg', 'jpg'],
    ['JPEG normalized', 'JPEG', 'jpg'],
    ['jpeg mapped', 'jpeg', 'jpg'],
    ['svg kept', 'svg', 'svg'],
    ['empty falls back', '', 'png'],
    ['spaces stripped', 'p n g', 'png'],
    ['custom fallback', 'exe', 'jpg', 'jpg'],
  ];
  for (const [name, input, expected, fallback] of extCases) {
    check(`safeExtension: ${name}`, safeExtension(input, fallback) === expected);
  }

  const fixedDate = new Date('2026-01-02T03:04:05');
  const fnCases = [
    ['traversal in name', { name: '../../etc/passwd' }, (f) => !f.includes('/') && !f.includes('..')],
    ['reserved name', { name: 'CON' }, (f) => f.startsWith('_CON.')],
    ['blocked ext', { name: 'x', ext: 'exe' }, (f) => f.endsWith('.png')],
    ['html ext blocked', { name: 'x', ext: 'html' }, (f) => f.endsWith('.png')],
    ['long name capped', { name: 'y'.repeat(500), ext: 'png' }, (f) => f.length <= 180],
    ['empty name falls back', { name: '' }, (f) => f.startsWith('image.')],
    ['dots only name', { name: '...' }, (f) => f.startsWith('image.')],
    ['custom template traversal', { custom: '{name}', name: '../a' }, (f) => !f.includes('/')],
    ['site mode', { site: 'example.com', num: 7 }, (f, mode) => mode === 'site' && /example\.com/.test(f) && /007/.test(f)],
  ];
  for (const [name, ctx, pred] of fnCases) {
    const mode = name === 'site mode' ? 'site' : ctx.custom ? 'custom' : 'original';
    let out;
    try {
      out = buildFilename(mode, { ...ctx, date: fixedDate, ext: ctx.ext || 'png' });
    } catch (err) {
      check(`buildFilename: ${name}`, false, `threw ${err}`);
      continue;
    }
    check(`buildFilename: ${name}`, pred(out, mode) === true && !ILLEGAL.test(out), `got ${out.slice(0, 60)}`);
  }

  const joinCases = [
    ['folder traversal', '../../secret', 'x.png', (p) => p === 'secret/x.png'],
    ['folder backslash', '..\\..\\s', 'x.png', (p) => !p.includes('..')],
    ['folder depth capped', 'a/b/c/d/e', 'x.png', (p) => p === 'a/b/c/x.png'],
    ['empty folder', '', 'x.png', (p) => p === 'x.png'],
    ['filename traversal', '', '../x.png', (p) => p === 'x.png'],
    ['filename reserved', '', 'CON.png', (p) => p === '_CON.png'],
    ['exe renamed to png', '', 'x.exe', (p) => p === 'x.png'],
    ['zip kept with extraExts', '', 'a.zip', (p) => p === 'a.zip', ['zip']],
    ['zip blocked without extraExts', '', 'a.zip', (p) => p === 'a.png', []],
  ];
  for (const [name, folder, filename, pred, extra] of joinCases) {
    let out;
    try {
      out = joinDownloadPath(folder, filename, extra || []);
    } catch (err) {
      check(`joinDownloadPath: ${name}`, false, `threw ${err}`);
      continue;
    }
    check(`joinDownloadPath: ${name}`, pred(out) === true, `got ${out}`);
  }

  const zipCases = [
    ['unix traversal', 'a/b/c.png', 'c.png'],
    ['windows traversal', 'a\\b\\c.png', 'c.png'],
    ['dotdot', '../../x.png', 'x.png'],
    ['leading dots', '...png', 'png'],
    ['empty', '', 'file'],
    ['long capped', 'n'.repeat(300) + '.png', (s) => s.length <= 120],
    ['illegal replaced', 'a<b>.png', (s) => !/[<>]/.test(s)],
    ['control chars', 'a\x00b.png', (s) => !/\x00/.test(s)],
  ];
  for (const [name, input, expected] of zipCases) {
    let out;
    try {
      out = safeZipName(input);
    } catch (err) {
      check(`safeZipName: ${name}`, false, `threw ${err}`);
      continue;
    }
    const ok = typeof expected === 'function' ? expected(out) : out === expected;
    check(`safeZipName: ${name}`, ok === true && !/[/\\]/.test(out), `got ${out.slice(0, 40)}`);
  }
  console.log('  (5) filename cases done');
}

/* ================================================ 6. URL guard */

console.log('6. private-network URL guard hostile table');
{
  const privCases = [
    // [name, url, expectedIsPrivate]
    ['loopback', 'http://127.0.0.1/', true],
    ['loopback decimal form', 'http://2130706433/', true],
    ['loopback hex form', 'http://0x7f.0.0.1/', true],
    ['loopback hex int form', 'http://0x7f000001/', true],
    ['loopback octal form', 'http://0177.0.0.1/', true],
    ['loopback mixed form', 'http://0x7f.0.0.1/', true],
    ['10/8', 'http://10.0.0.5/', true],
    ['172.16/12 low', 'http://172.16.0.1/', true],
    ['172.16/12 high', 'http://172.31.255.255/', true],
    ['172.15 not private', 'http://172.15.0.1/', false],
    ['172.32 not private', 'http://172.32.0.1/', false],
    ['192.168/16', 'http://192.168.1.1/', true],
    ['link-local', 'http://169.254.169.254/', true],
    ['cgnat low', 'http://100.64.0.1/', true],
    ['cgnat high', 'http://100.127.255.255/', true],
    ['100.128 not cgnat', 'http://100.128.0.1/', false],
    ['unspecified', 'http://0.0.0.0/', true],
    ['localhost', 'http://localhost/', true],
    ['sub.localhost', 'http://x.localhost/', true],
    ['dot-local', 'http://printer.local/', true],
    ['dot-lan', 'http://router.lan/', true],
    ['dot-internal', 'http://x.internal/', true],
    ['home.arpa', 'http://x.home.arpa/', true],
    ['single label', 'http://printer/', true],
    ['single label 2', 'http://intranet/', true],
    ['ipv6 loopback', 'http://[::1]/', true],
    ['ipv6 unspecified', 'http://[::]/', true],
    ['ipv6 mapped loopback', 'http://[::ffff:127.0.0.1]/', true],
    ['ipv6 mapped hex', 'http://[::ffff:7f00:1]/', true],
    ['ipv6 mapped long form', 'http://[0:0:0:0:0:ffff:127.0.0.1]/', true],
    ['ipv6 mapped 10/8', 'http://[::ffff:0a00:001]/', true],
    ['ipv6 compatible', 'http://[::7f00:1]/', true],
    ['ipv6 link-local', 'http://[fe80::1]/', true],
    ['ipv6 unique-local', 'http://[fc00::1]/', true],
    ['ipv6 nat64 loopback', 'http://[64:ff9b::7f00:1]/', true],
    ['ipv6 6to4 loopback', 'http://[2002:7f00:1::]/', true],
    ['ipv6 documentation not private', 'http://[2001:db8::1]/', false],
    ['ipv6 public', 'http://[2606:4700:4700::1111]/', false],
    ['public v4', 'http://8.8.8.8/', false],
    ['public host', 'http://example.com/', false],
    ['private-looking public suffix', 'https://192.168.1.1.evil.example/', false],
    ['trailing dot loopback', 'http://127.0.0.1./', true],
    ['uppercase localhost', 'http://LOCALHOST/', true],
    ['credentials with private host', 'http://u:p@127.0.0.1/', true],
    ['non-http scheme ignored', 'ftp://127.0.0.1/', false],
    ['file scheme ignored', 'file:///etc/passwd', false],
    ['data url ignored', 'data:image/png;base64,xx', false],
    ['garbage url', 'http://[::ffff::1]/', false],
    ['empty', '', false],
  ];
  for (const [name, url, expected] of privCases) {
    let got;
    try {
      got = isPrivateNetworkUrl(url);
    } catch (err) {
      check(`isPrivateNetworkUrl: ${name}`, false, `threw ${err}`);
      continue;
    }
    check(`isPrivateNetworkUrl: ${name}`, got === expected, `got ${got}`);
  }

  const blockCases = [
    ['cross host private blocked', 'http://127.0.0.1/a', 'https://example.com/', true],
    ['same private host allowed', 'http://127.0.0.1/a', 'http://127.0.0.1/b', false],
    ['same 192.168 host allowed', 'http://192.168.1.5/x', 'http://192.168.1.5/y', false],
    ['different private hosts blocked', 'http://192.168.1.5/x', 'http://192.168.1.6/y', true],
    ['public never blocked', 'https://example.com/a.png', 'https://example.com/', false],
    ['no page url blocks private', 'http://127.0.0.1/', '', true],
    ['ipv6 mapped blocked', 'http://[::ffff:127.0.0.1]/x', 'https://example.com/', true],
  ];
  for (const [name, url, pageUrl, expected] of blockCases) {
    check(`isPrivateNetworkFetchBlocked: ${name}`, isPrivateNetworkFetchBlocked(url, pageUrl) === expected);
  }

  const normCases = [
    ['javascript: rejected', 'javascript:alert(1)', 'https://example.com/', null],
    ['data:text/html rejected', 'data:text/html,x', null, null],
    ['credentials rejected', 'https://u:p@example.com/', null, null],
    ['too long rejected', 'https://example.com/' + 'a'.repeat(8192), null, null],
    ['non-string rejected', 42, null, null],
    ['empty rejected', '', null, null],
    ['blob passthrough', 'blob:https://example.com/1', null, 'blob:https://example.com/1'],
    ['relative resolved', '/a.png', 'https://example.com/p/', 'https://example.com/a.png'],
    ['hash stripped', 'https://example.com/a.png#frag', null, 'https://example.com/a.png'],
    ['host lowercased', 'https://EXAMPLE.com/a.png', null, 'https://example.com/a.png'],
    ['data:image small kept', 'data:image/png;base64,iVBORw0KGgo=', null, 'data:image/png;base64,iVBORw0KGgo='],
  ];
  for (const [name, raw, base, expected] of normCases) {
    let got;
    try {
      got = normalizeUrl(raw, base);
    } catch (err) {
      check(`normalizeUrl: ${name}`, false, `threw ${err}`);
      continue;
    }
    check(`normalizeUrl: ${name}`, got === expected, `got ${String(got).slice(0, 60)}`);
  }
  // Data URL download cap: over the limit is rejected, at the limit kept.
  {
    const over = 'data:image/png;base64,' + 'A'.repeat(DATA_URL_DOWNLOAD_MAX);
    check('normalizeUrl: oversized data URL rejected', normalizeUrl(over, null) === null);
    const under = 'data:image/png;base64,' + 'A'.repeat(1000);
    check('normalizeUrl: small data URL kept', normalizeUrl(under, null) === under);
  }
  console.log('  (6) URL guard cases done');
}

/* ================================================ 7. settings validation */

console.log('7. settings validation hostile table');
{
  let n = 0;
  const t = (name, fn) => {
    n += 1;
    try {
      fn();
      pass += 1;
    } catch (err) {
      fail += 1;
      console.log(`  FAIL settings: ${name}, ${err.message}`);
    }
  };
  const validSettings = (s) => {
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
      assert.ok(k in s, `missing key ${k}`);
    }
    assert.ok(['system', 'light', 'dark'].includes(s.theme));
    assert.ok(Number.isFinite(s.jpgQuality) && s.jpgQuality >= 0.1 && s.jpgQuality <= 1);
    assert.ok(Number.isInteger(s.maxConcurrent) && s.maxConcurrent >= 1 && s.maxConcurrent <= 6);
    assert.ok(typeof s.sitePrefs === 'object' && s.sitePrefs !== null);
    assert.equal(s.version, 1);
  };

  t('null input gives defaults', () => validSettings(normalizeSettings(null)));
  t('undefined input gives defaults', () => validSettings(normalizeSettings(undefined)));
  t('array input gives defaults', () => validSettings(normalizeSettings([])));
  t('string input gives defaults', () => validSettings(normalizeSettings('nope')));
  t('number input gives defaults', () => validSettings(normalizeSettings(42)));

  // Prototype pollution keys: parsed from JSON so they are own properties.
  t('__proto__ key does not pollute', () => {
    const s = normalizeSettings(JSON.parse('{"__proto__":{"polluted":true},"theme":"dark"}'));
    assert.equal({}.polluted, undefined);
    assert.equal(s.theme, 'dark');
  });
  t('constructor/prototype does not pollute', () => {
    normalizeSettings(JSON.parse('{"constructor":{"prototype":{"pwned":1}}}'));
    assert.equal({}.pwned, undefined);
  });
  t('__proto__ inside sitePrefs is not stored', () => {
    const s = normalizeSettings(JSON.parse('{"sitePrefs":{"__proto__":"smart","example.com":"disabled"}}'));
    assert.deepEqual(Object.keys(s.sitePrefs), ['example.com']);
    assert.equal({}.polluted, undefined);
  });
  t('constructor key in sitePrefs is inert', () => {
    const s = normalizeSettings({ sitePrefs: { constructor: 'smart' } });
    assert.equal(Object.getPrototypeOf(s.sitePrefs), Object.prototype);
    assert.equal({}.polluted, undefined);
    assert.equal(typeof s.sitePrefs.constructor, 'string');
  });

  // Wrong types coerced.
  t('numeric theme resets', () => assert.equal(normalizeSettings({ theme: 123 }).theme, 'system'));
  t('unknown enum resets', () => assert.equal(normalizeSettings({ filenameMode: 'weird' }).filenameMode, 'original'));
  t('bad language resets to auto', () => assert.equal(normalizeSettings({ language: 'xx' }).language, 'auto'));
  t('good language kept', () => assert.equal(normalizeSettings({ language: 'ar' }).language, 'ar'));
  t('non-numeric quality falls back', () => assert.equal(normalizeSettings({ jpgQuality: 'zzz' }).jpgQuality, 1));
  t('quality above 1 clamped', () => assert.equal(normalizeSettings({ jpgQuality: 5 }).jpgQuality, 1));
  t('quality below 0.1 clamped', () => assert.equal(normalizeSettings({ jpgQuality: 0 }).jpgQuality, 0.1));
  t('NaN quality falls back', () => assert.ok(Number.isFinite(normalizeSettings({ jpgQuality: NaN }).jpgQuality)));
  t('maxConcurrent 99 clamped to 6', () => assert.equal(normalizeSettings({ maxConcurrent: 99 }).maxConcurrent, 6));
  t('maxConcurrent 0 clamped to 1', () => assert.equal(normalizeSettings({ maxConcurrent: 0 }).maxConcurrent, 1));
  t('maxConcurrent 2.7 rounded', () => assert.equal(normalizeSettings({ maxConcurrent: 2.7 }).maxConcurrent, 3));
  t('retention 9999 clamped to 365', () => assert.equal(normalizeSettings({ historyRetentionDays: 9999 }).historyRetentionDays, 365));
  t('truthy non-boolean is false', () => assert.equal(normalizeSettings({ saveAsDialog: 1 }).saveAsDialog, false));
  t('string boolean is false', () => assert.equal(normalizeSettings({ saveAsDialog: 'yes' }).saveAsDialog, false));
  t('real true kept', () => assert.equal(normalizeSettings({ saveAsDialog: true }).saveAsDialog, true));

  // Huge values capped.
  t('customTemplate capped at 160', () => assert.ok(normalizeSettings({ customTemplate: 'x'.repeat(100000) }).customTemplate.length <= 160));
  t('subfolder capped at 120', () => assert.ok(normalizeSettings({ subfolder: 'y'.repeat(100000) }).subfolder.length <= 120));
  t('sitePrefs host sliced to 253 chars', () => {
    const s = normalizeSettings({ sitePrefs: { ['h'.repeat(500)]: 'smart' } });
    const keys = Object.keys(s.sitePrefs);
    assert.equal(keys.length, 1);
    assert.ok(keys[0].length <= 253);
  });

  // sitePrefs validation.
  t('sitePrefs host lowercased', () => {
    const s = normalizeSettings({ sitePrefs: { 'EXAMPLE.com': 'smart' } });
    assert.deepEqual(s.sitePrefs, { 'example.com': 'smart' });
  });
  t('sitePrefs bad host dropped', () => {
    const s = normalizeSettings({ sitePrefs: { 'bad host!': 'smart' } });
    assert.deepEqual(s.sitePrefs, {});
  });
  t('sitePrefs bad mode dropped', () => {
    const s = normalizeSettings({ sitePrefs: { 'example.com': 'evil' } });
    assert.deepEqual(s.sitePrefs, {});
  });
  t('sitePrefs non-object ignored', () => {
    assert.deepEqual(normalizeSettings({ sitePrefs: 'nope' }).sitePrefs, {});
    assert.deepEqual(normalizeSettings({ sitePrefs: ['x'] }).sitePrefs, {});
  });

  // Legacy keys and migration.
  t('avifQuality dropped', () => assert.ok(!('avifQuality' in normalizeSettings({ avifQuality: 0.5 }))));
  t('defaultAction dropped', () => assert.ok(!('defaultAction' in normalizeSettings({ defaultAction: 'x' }))));
  t('old 0.92 quality migrates to 1', () => assert.equal(normalizeSettings({ jpgQuality: 0.92 }).jpgQuality, 1));
  t('user-chosen 0.5 quality kept', () => assert.equal(normalizeSettings({ jpgQuality: 0.5 }).jpgQuality, 0.5));
  t('organizeBySite alias maps to site', () => assert.equal(normalizeSettings({ organizeBySite: true, folderMode: 'flat' }).folderMode, 'site'));

  // Unknown keys are preserved (forward-compat) but inert.
  t('unknown key preserved and inert', () => {
    const s = normalizeSettings({ nope: 1, theme: 'dark' });
    assert.equal(s.nope, 1);
    assert.equal(s.theme, 'dark');
    validSettings(s);
  });

  // Settings import parsing.
  t('import: bad JSON throws', () => assert.throws(() => parseSettingsImport('not json')));
  t('import: array throws', () => assert.throws(() => parseSettingsImport('[]')));
  t('import: string throws', () => assert.throws(() => parseSettingsImport('"x"')));
  t('import: null throws', () => assert.throws(() => parseSettingsImport('null')));
  t('import: object ok', () => assert.deepEqual(parseSettingsImport('{"a":1}'), { a: 1 }));
  t('import: huge JSON still parses (bounded later)', () => {
    const big = JSON.stringify({ subfolder: 'z'.repeat(200000) });
    const s = normalizeSettings(parseSettingsImport(big));
    assert.ok(s.subfolder.length <= 120);
  });
  console.log(`  (7) ${n} settings cases`);
}

/* ================================================ 8. message validation */

console.log('8. message validation hostile table');
{
  let n = 0;
  const t = (name, fn) => {
    n += 1;
    try {
      fn();
      pass += 1;
    } catch (err) {
      fail += 1;
      console.log(`  FAIL messages: ${name}, ${err.message}`);
    }
  };

  t('null rejected', () => assert.equal(isValidMessage(null), false));
  t('false rejected', () => assert.equal(isValidMessage(false), false));
  t('string rejected', () => assert.equal(isValidMessage('x'), false));
  t('array rejected', () => assert.equal(isValidMessage([]), false));
  t('empty object rejected', () => assert.equal(isValidMessage({}), false));
  t('numeric type rejected', () => assert.equal(isValidMessage({ type: 42 }), false));
  t('unknown type rejected', () => assert.equal(isValidMessage({ type: 'PWN' }), false));
  t('offscreen type rejected by worker router', () => assert.equal(isValidMessage({ target: 'offscreen', type: 'CONVERT_IMAGE' }), false));
  t('broadcast types rejected as inbound worker messages', () => assert.equal(isValidMessage({ type: 'NOTICE', code: 'x' }), false));
  t('GET_SETTINGS accepted', () => assert.equal(isValidMessage({ type: 'GET_SETTINGS' }), true));
  t('SAVE_SETTINGS accepted', () => assert.equal(isValidMessage({ type: 'SAVE_SETTINGS', settings: {} }), true));
  t('DOWNLOAD_IMAGE accepted', () => assert.equal(isValidMessage({ type: 'DOWNLOAD_IMAGE', srcUrl: 'https://e.com/a.png' }), true));
  t('DOWNLOAD_IMAGE wrong field type rejected', () => assert.equal(isValidMessage({ type: 'DOWNLOAD_IMAGE', srcUrl: 123 }), false));
  t('DOWNLOAD_IMAGE null field rejected', () => assert.equal(isValidMessage({ type: 'DOWNLOAD_IMAGE', mode: null }), false));
  t('GET_CAPTURE id number rejected', () => assert.equal(isValidMessage({ type: 'GET_CAPTURE', id: 7 }), false));
  t('GET_CAPTURE id string accepted', () => assert.equal(isValidMessage({ type: 'GET_CAPTURE', id: 'cap-1' }), true));
  t('SAVE_ANNOTATED dataUrl string accepted', () => assert.equal(isValidMessage({ type: 'SAVE_ANNOTATED', id: 'a', dataUrl: 'data:image/png;base64,xx' }), true));
  t('SAVE_ANNOTATED dataUrl number rejected', () => assert.equal(isValidMessage({ type: 'SAVE_ANNOTATED', id: 'a', dataUrl: 9 }), false));
  t('oversized GET_SETTINGS rejected', () => assert.equal(isValidMessage({ type: 'GET_SETTINGS', pad: 'x'.repeat(2_000_000) }), false));
  t('SAVE_ANNOTATED allows multi-MB payload', () => assert.equal(isValidMessage({ type: 'SAVE_ANNOTATED', id: 'a', dataUrl: 'x'.repeat(2_000_000) }), true));
  t('circular object rejected safely', () => {
    const m = { type: 'GET_SETTINGS' };
    m.self = m;
    assert.equal(isValidMessage(m), false);
  });
  t('__proto__ key in message is inert', () => {
    const m = JSON.parse('{"type":"GET_SETTINGS","__proto__":{"x":1}}');
    assert.equal(isValidMessage(m), true);
    assert.equal({}.x, undefined);
  });
  t('extra unknown fields tolerated', () => assert.equal(isValidMessage({ type: 'SCAN_PAGE', whatever: 1 }), true));
  t('SCAN_PROGRESS shape accepted', () => assert.equal(isValidMessage({ type: 'SCAN_PROGRESS', done: 1, total: 2 }), true));

  // DISCARD_CAPTURE (Parts overview): strict shape + minted-id formats.
  t('DISCARD_CAPTURE well-formed accepted', () => assert.equal(isValidMessage({ type: 'DISCARD_CAPTURE', id: 'cap-1700000000000-123', groupId: 'grp-1700000000000-456' }), true));
  t('DISCARD_CAPTURE numeric id rejected', () => assert.equal(isValidMessage({ type: 'DISCARD_CAPTURE', id: 7, groupId: 'grp-1700000000000-456' }), false));
  t('DISCARD_CAPTURE numeric groupId rejected', () => assert.equal(isValidMessage({ type: 'DISCARD_CAPTURE', id: 'cap-1700000000000-123', groupId: 9 }), false));
  t('DISCARD_CAPTURE is a known message type', () => assert.ok(MESSAGE_TYPES.has('DISCARD_CAPTURE')));
  t('isValidCaptureId accepts a minted id', () => assert.equal(isValidCaptureId('cap-1700000000000-123456'), true));
  t('isValidCaptureId rejects a short epoch', () => assert.equal(isValidCaptureId('cap-1-2'), false));
  t('isValidCaptureId rejects the group prefix', () => assert.equal(isValidCaptureId('grp-1700000000000-123'), false));
  t('isValidCaptureId rejects an over-long random part', () => assert.equal(isValidCaptureId('cap-1700000000000-1234567'), false));
  t('isValidCaptureId rejects non-strings', () => assert.equal(isValidCaptureId(42), false));
  t('isValidCaptureGroupId accepts a minted group id', () => assert.equal(isValidCaptureGroupId('grp-1700000000000-42'), true));
  t('isValidCaptureGroupId rejects the capture prefix', () => assert.equal(isValidCaptureGroupId('cap-1700000000000-42'), false));
  t('isValidCaptureGroupId rejects traversal text', () => assert.equal(isValidCaptureGroupId('../../etc/passwd'), false));


  // senderKind
  t('extension page classified', () => assert.equal(senderKind({ url: 'chrome-extension://abc/popup.html' }), 'extension'));
  t('extension tab classified as extension', () => assert.equal(senderKind({ url: 'chrome-extension://abc/pages/info.html?x=1', tab: { id: 3 } }), 'extension'));
  t('content script classified', () => assert.equal(senderKind({ url: 'https://example.com/', tab: { id: 5 } }), 'content'));
  t('no url no tab unknown', () => assert.equal(senderKind({}), 'unknown'));
  t('null sender unknown', () => assert.equal(senderKind(null), 'unknown'));
  t('undefined sender unknown', () => assert.equal(senderKind(undefined), 'unknown'));
  t('tab without url unknown', () => assert.equal(senderKind({ tab: {} }), 'unknown'));
  t('http url without tab unknown', () => assert.equal(senderKind({ url: 'https://example.com/' }), 'unknown'));

  // SENDER_RULES least privilege
  t('SCAN_PROGRESS content-only', () => assert.deepEqual(SENDER_RULES.SCAN_PROGRESS, ['content']));
  for (const [type, kinds] of Object.entries(SENDER_RULES)) {
    if (type === 'SCAN_PROGRESS') continue;
    t(`${type} extension-only`, () => assert.deepEqual(kinds, ['extension']));
  }
  t('every rule names a known message type', () => {
    for (const type of Object.keys(SENDER_RULES)) assert.ok(MESSAGE_TYPES.has(type), type);
  });
  t('broadcast types are outbound-only (no inbound rule)', () => {
    for (const type of ['QUEUE_UPDATE', 'SCAN_DONE', 'NOTICE', 'NOTICE_TEXT']) {
      assert.ok(!(type in SENDER_RULES), type);
    }
  });
  console.log(`  (8) ${n} message cases`);
}

/* ================================================ 9. static forbidden-API scan */

console.log('9. static scan for forbidden APIs');
{
  const DIRS = ['background', 'content', 'core', 'offscreen', 'options', 'pages', 'popup', 'shared'];
  const jsFiles = [];
  const htmlFiles = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) jsFiles.push(p);
      else if (e.name.endsWith('.html')) htmlFiles.push(p);
    }
  };
  for (const d of DIRS) walk(path.join(ROOT, d));

  const jsPatterns = [
    [/\.innerHTML\s*=/, 'innerHTML assignment'],
    [/\.outerHTML\s*=/, 'outerHTML assignment'],
    [/insertAdjacentHTML\s*\(/, 'insertAdjacentHTML'],
    [/document\.write\s*\(/, 'document.write'],
    [/\beval\s*\(/, 'eval()'],
    [/new Function\s*\(/, 'new Function()'],
    [/setTimeout\s*\(\s*['"`]/, 'string setTimeout'],
    [/setInterval\s*\(\s*['"`]/, 'string setInterval'],
  ];
  let scanned = 0;
  for (const f of jsFiles) {
    const text = fs.readFileSync(f, 'utf8');
    scanned += 1;
    for (const [re, name] of jsPatterns) {
      // Skip matches inside comments: strip line/block comments first.
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^\S:])\/\/[^\n]*/g, '$1');
      if (re.test(code)) {
        check(`static scan ${path.relative(ROOT, f)}: no ${name}`, false, 'pattern found');
      }
    }
  }
  check('static scan: JS files scanned', scanned > 30, `${scanned} files`);

  // HTML: no inline event handlers, no inline scripts, no remote src.
  let htmlScanned = 0;
  for (const f of htmlFiles) {
    const text = fs.readFileSync(f, 'utf8');
    htmlScanned += 1;
    const rel = path.relative(ROOT, f);
    check(`static scan ${rel}: no inline event handler`, !/<[^>]+\s+on\w+\s*=/i.test(text));
    check(`static scan ${rel}: no inline script body`, !/<script(?![^>]*\bsrc\s*=)[^>]*>/i.test(text));
    check(`static scan ${rel}: no remote src/href`, !/\s(?:src|href)\s*=\s*["']https?:\/\//i.test(text));
  }
  check('static scan: HTML files scanned', htmlScanned > 5, `${htmlScanned} files`);
}

/* ================================================ 10. seeded fuzz */

console.log('10. seeded fuzz over pure functions');
{
  const rand = rng32(20261019);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const FRAGMENTS = [
    '<script>', '</script>', 'javascript:', 'JaVaScRiPt:', 'java\tscript:', 'data:image/svg+xml;base64,',
    'data:text/html,', '../', '..\\', '%2e%2e%2f', '%252e', '\x00', '\n', '\t', '__proto__', 'constructor',
    'prototype', 'http://127.0.0.1/', 'http://[::ffff:127.0.0.1]/', 'https://example.com/', '"><img src=x onerror=alert(1)>',
    '{{', '${', '\u202e', 'CON', 'NUL', '.exe', '#', '?', '&', '=', ';', ':', '@', '!', '*', '|', '<', '>',
    '"', "'", '\\', '/', ' ', '\u00a0', '\u4e2d', '\ud83d\ude00', 'a'.repeat(50), '\x7f', '\x01',
  ];
  const mutate = (s) => {
    const ops = Math.floor(rand() * 3) + 1;
    let out = String(s);
    for (let k = 0; k < ops; k += 1) {
      const op = rand();
      if (op < 0.3 && out.length > 0) {
        const i = Math.floor(rand() * out.length);
        out = out.slice(0, i) + pick(FRAGMENTS) + out.slice(i);
      } else if (op < 0.5 && out.length > 0) {
        const i = Math.floor(rand() * out.length);
        out = out.slice(0, i) + out.slice(i + 1);
      } else if (op < 0.7 && out.length > 0) {
        const i = Math.floor(rand() * out.length);
        out = out.slice(0, i) + pick(FRAGMENTS) + out.slice(i + 1);
      } else if (op < 0.85) {
        out += pick(FRAGMENTS);
      } else {
        out = out.slice(0, Math.floor(rand() * (out.length + 1)));
      }
    }
    return out;
  };
  const fuzzInput = () => {
    let s = '';
    const parts = Math.floor(rand() * 4) + 1;
    for (let i = 0; i < parts; i += 1) s += pick(FRAGMENTS);
    return mutate(s);
  };

  const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/;
  let fuzzFails = 0;
  const fuzzFail = (fn, input, why) => {
    fuzzFails += 1;
    if (fuzzFails <= 5) console.log(`  FUZZ ${fn}: ${why}, input=${JSON.stringify(String(input)).slice(0, 90)}`);
  };
  const N = 600;

  for (let i = 0; i < N; i += 1) {
    const s = fuzzInput();
    try {
      const out = sanitizeSegment(s);
      if (typeof out !== 'string') fuzzFail('sanitizeSegment', s, 'not a string');
      else if (ILLEGAL.test(out)) fuzzFail('sanitizeSegment', s, 'illegal chars survive');
      else if (out.length > 96) fuzzFail('sanitizeSegment', s, 'over length cap');
      else if (/^[.\s]/.test(out) || /[.\s]$/.test(out)) fuzzFail('sanitizeSegment', s, 'bad edges');
    } catch (err) {
      fuzzFail('sanitizeSegment', s, `threw ${err}`);
    }
    try {
      const out = safeZipName(s);
      if (typeof out !== 'string' || !out) fuzzFail('safeZipName', s, 'empty/non-string');
      else if (/[/\\]/.test(out)) fuzzFail('safeZipName', s, 'separator survives');
      else if (out.length > 120) fuzzFail('safeZipName', s, 'over length cap');
    } catch (err) {
      fuzzFail('safeZipName', s, `threw ${err}`);
    }
    try {
      const out = isSafeSvgUrl(s);
      if (typeof out !== 'boolean') fuzzFail('isSafeSvgUrl', s, 'not a boolean');
    } catch (err) {
      fuzzFail('isSafeSvgUrl', s, `threw ${err}`);
    }
    try {
      const out = stripSvgDoctype(s);
      if (typeof out !== 'string') fuzzFail('stripSvgDoctype', s, 'not a string');
      else if (out.length > s.length) fuzzFail('stripSvgDoctype', s, 'grew');
      else if (/<!doctype/i.test(out)) fuzzFail('stripSvgDoctype', s, 'doctype survives');
    } catch (err) {
      fuzzFail('stripSvgDoctype', s, `threw ${err}`);
    }
    try {
      const out = normalizeUrl(s, rand() < 0.5 ? 'https://example.com/' : undefined);
      if (out !== null && typeof out !== 'string') fuzzFail('normalizeUrl', s, 'not null/string');
    } catch (err) {
      fuzzFail('normalizeUrl', s, `threw ${err}`);
    }
    try {
      const out = isPrivateNetworkUrl(s);
      if (typeof out !== 'boolean') fuzzFail('isPrivateNetworkUrl', s, 'not a boolean');
    } catch (err) {
      fuzzFail('isPrivateNetworkUrl', s, `threw ${err}`);
    }
    try {
      const out = isValidMessage({ type: pick(['GET_SETTINGS', 'DOWNLOAD_IMAGE', 'NOPE', 'SCAN_PROGRESS']), extra: s });
      if (typeof out !== 'boolean') fuzzFail('isValidMessage', s, 'not a boolean');
    } catch (err) {
      fuzzFail('isValidMessage', s, `threw ${err}`);
    }
  }

  // normalizeSettings fuzz: random hostile objects, including own __proto__.
  for (let i = 0; i < N; i += 1) {
    let obj;
    try {
      const raw = {};
      const keys = Math.floor(rand() * 6);
      for (let k = 0; k < keys; k += 1) {
        raw[pick(['theme', 'jpgQuality', 'maxConcurrent', 'sitePrefs', 'customTemplate', 'subfolder', 'language', 'filenameMode', '__proto__', 'constructor', 'unknown_x'])] =
          pick([pick(FRAGMENTS), 42, -1, 1e9, NaN, Infinity, true, false, null, { a: 1 }, [1, 2], fuzzInput()]);
      }
      obj = JSON.parse(JSON.stringify(raw));
      if (rand() < 0.3) obj.sitePrefs = { [fuzzInput().slice(0, 20)]: pick(['smart', 'evil', 42]) };
    } catch {
      continue;
    }
    try {
      const s = normalizeSettings(obj);
      for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (!(k in s)) {
          fuzzFail('normalizeSettings', JSON.stringify(obj).slice(0, 60), `missing key ${k}`);
          break;
        }
      }
      if ({}.polluted !== undefined || {}.pwned !== undefined) fuzzFail('normalizeSettings', '', 'prototype polluted');
    } catch (err) {
      fuzzFail('normalizeSettings', JSON.stringify(obj).slice(0, 60), `threw ${err}`);
    }
  }

  // buildFilename fuzz: hostile context values.
  const fixedDate = new Date('2026-01-02T03:04:05');
  for (let i = 0; i < N; i += 1) {
    const ctx = {
      site: fuzzInput(),
      name: fuzzInput(),
      ext: fuzzInput(),
      custom: fuzzInput(),
      date: fixedDate,
      num: Math.floor(rand() * 1000),
    };
    try {
      const out = buildFilename(pick(['original', 'site', 'custom', 'bogus']), ctx);
      if (typeof out !== 'string' || !out) fuzzFail('buildFilename', '', 'empty/non-string');
      else if (ILLEGAL.test(out)) fuzzFail('buildFilename', '', 'illegal chars survive');
      else if (out.length > 180) fuzzFail('buildFilename', '', 'over length cap');
      else if (out.includes('..')) fuzzFail('buildFilename', '', 'dotdot survives');
    } catch (err) {
      fuzzFail('buildFilename', '', `threw ${err}`);
    }
  }

  check('fuzz: all invariants hold over seeded inputs', fuzzFails === 0, `${fuzzFails} failures`);
  console.log(`  (10) fuzzed ${N * 9} inputs across 9 functions`);
}

/* ================================================ 11. round-4 leftovers (F1, F4, F5, F6) */

console.log('11. round-4 leftovers: redirect re-check, popup sender, dead crop, data-url decoder');
{
  const PAGE = 'https://example.com/page';

  // F1: the redirect final-URL rule (pure logic in core/urls.js).
  check('F1: redirect to 127.0.0.1 blocked', isRedirectBlocked('http://127.0.0.1/x.png', PAGE) === true);
  check('F1: redirect to localhost blocked', isRedirectBlocked('http://localhost/x.png', PAGE) === true);
  check('F1: redirect to 192.168 blocked', isRedirectBlocked('http://192.168.1.5/x.png', PAGE) === true);
  check('F1: redirect to [::1] blocked', isRedirectBlocked('http://[::1]/x.png', PAGE) === true);
  check('F1: redirect to .local host blocked', isRedirectBlocked('http://printer.local/x.png', PAGE) === true);
  check('F1: redirect to a public URL allowed', isRedirectBlocked('https://cdn.example.com/x.png', PAGE) === false);
  check('F1: same private host as page allowed', isRedirectBlocked('http://127.0.0.1/x.png', 'http://127.0.0.1/gallery') === false);
  check('F1: localhost final vs 127.0.0.1 page still blocked', isRedirectBlocked('http://localhost/x.png', 'http://127.0.0.1/gallery') === true);
  check('F1: data: final URL is not a network redirect', isRedirectBlocked('data:image/png;base64,xx', PAGE) === false);
  check('F1: blob: final URL is not a network redirect', isRedirectBlocked('blob:chrome-extension://abc/1', PAGE) === false);
  check('F1: extension final URL passes', isRedirectBlocked('chrome-extension://abc/x.png', PAGE) === false);
  check('F1: empty final URL passes', isRedirectBlocked('', PAGE) === false);
  check('F1: null final URL passes', isRedirectBlocked(null, PAGE) === false);
  check('F1: undefined final URL passes', isRedirectBlocked(undefined, PAGE) === false);

  // F1 placement: every offscreen fetch site is guarded.
  const offSrc = fs.readFileSync(path.join(ROOT, 'offscreen', 'offscreen.js'), 'utf8');
  check('F1: offscreen defines the redirect guard', offSrc.includes('function throwIfRedirectBlocked'));
  const guardHits = offSrc.match(/(?:throwIfRedirectBlocked|isRedirectBlocked)\(res/g) || [];
  check('F1: all 7 offscreen fetch sites re-check the final URL', guardHits.length >= 7, `${guardHits.length} guards`);

  // F6: the chunked decoder is what the screenshot paths use.
  const cropSrc = fs.readFileSync(path.join(ROOT, 'core', 'crop-image.js'), 'utf8');
  check('F6: in-worker crop decodes via core/data-url.js', cropSrc.includes('dataUrlToBlob'));
  check('F6: in-worker crop has no fetch(dataUrl)', !/fetch\(\s*dataUrl/.test(cropSrc));
  check('F6: offscreen loadBitmap decodes data URLs via core/data-url.js', offSrc.includes('dataUrlToBlob(src)'));
  const captureIoSrc = fs.readFileSync(path.join(ROOT, 'shared', 'capture-io.js'), 'utf8');
  check('F6: capture bitmap path decodes via core/data-url.js', captureIoSrc.includes('dataUrlToBlob'));
  {
    const src = new Uint8Array(1024);
    for (let i = 0; i < src.length; i += 1) src[i] = (i * 17 + 3) & 0xff;
    const url = `data:image/png;base64,${Buffer.from(src).toString('base64')}`;
    const out = dataUrlToBytes(url);
    let same = out.length === src.length;
    for (let i = 0; same && i < src.length; i += 1) same = out[i] === src[i];
    check('F6: decoder round-trips a payload byte-exact', same);
  }

  // F4: the popup ignores runtime messages from foreign senders.
  const popupSrc = fs.readFileSync(path.join(ROOT, 'popup', 'popup.js'), 'utf8');
  check('F4: popup message handler receives the sender', /function onRuntimeMessage\(msg, sender\)/.test(popupSrc));
  check('F4: popup drops foreign senders', popupSrc.includes('sender.id !== chrome.runtime.id'));

  // F5: the dead offscreen crop handler is gone from shipped code.
  check('F5: offscreen has no CROP_IMAGE handler left', !offSrc.includes('CROP_IMAGE') && !offSrc.includes('cropImage'));
  {
    const DIRS = ['background', 'content', 'core', 'offscreen', 'options', 'pages', 'popup', 'shared'];
    let hits = 0;
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js') && fs.readFileSync(p, 'utf8').includes('CROP_IMAGE')) hits += 1;
      }
    };
    for (const d of DIRS) walk(path.join(ROOT, d));
    check('F5: no shipped JS references CROP_IMAGE', hits === 0, `${hits} files`);
  }
}

/* ================================================ summary */

console.log(`\nsecurity: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
