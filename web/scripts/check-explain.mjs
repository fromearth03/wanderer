#!/usr/bin/env node
// Fails if any interactive JSX element in src/**/*.tsx has no data-explain
// (or an `explain` prop on our own wrapper components), and if any user-facing
// source contains an em-dash or en-dash.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('..', import.meta.url));
const srcDir = join(root, 'src');

const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary', 'Link', 'NavLink', 'details']);
// Our wrappers must receive an `explain` prop (they forward it as data-explain).
const WRAPPERS = new Set(['Chip', 'IconButton', 'Toggle', 'Segmented', 'Slider', 'Select']);
const HANDLER_ATTRS = ['onClick', 'onPointerDown', 'onMouseDown', 'onKeyDown', 'onTouchStart', 'onWheel'];
const ROLES = new Set(['button', 'tab', 'slider', 'switch', 'link', 'checkbox', 'radio', 'menuitem', 'option']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const problems = [];
const files = walk(srcDir);

for (const file of files.filter((f) => f.endsWith('.tsx'))) {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(sf);
      const attrs = new Map();
      let hasSpread = false;
      for (const a of node.attributes.properties) {
        if (ts.isJsxAttribute(a)) {
          const name = a.name.getText(sf);
          let val = null;
          if (a.initializer && ts.isStringLiteral(a.initializer)) val = a.initializer.text;
          attrs.set(name, val);
        } else hasSpread = true;
      }
      const role = attrs.get('role');
      const interactive =
        INTERACTIVE_TAGS.has(tag) ||
        WRAPPERS.has(tag) ||
        HANDLER_ATTRS.some((h) => attrs.has(h)) ||
        (role && ROLES.has(role)) ||
        attrs.has('tabIndex');
      // A hidden decorative input or a label-less passthrough is still interactive; no exemptions
      // except inputs of type hidden.
      const hidden = tag === 'input' && attrs.get('type') === 'hidden';
      if (interactive && !hidden) {
        // Segmented renders one button per option; its SegOption type makes `explain` required on
        // every option, so TypeScript enforces those and the tag itself passes when it has options.
        const ok =
          attrs.has('data-explain') ||
          (WRAPPERS.has(tag) && attrs.has('explain')) ||
          (tag === 'Segmented' && attrs.has('options'));
        if (!ok) {
          const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          problems.push(`${relative(root, file)}:${line + 1}:${character + 1}  <${tag}> has no data-explain${hasSpread ? ' (spread props are not counted)' : ''}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// No em-dashes or en-dashes in anything a visitor can read.
const dashFiles = [...files.filter((f) => /\.(tsx?|css|html|md)$/.test(f)), join(root, 'index.html')];
for (const f of dashFiles) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((l, i) => {
    if (/[—–]/.test(l)) problems.push(`${relative(root, f)}:${i + 1}  contains an em-dash or en-dash`);
  });
}

const count = files.filter((f) => f.endsWith('.tsx')).length;
if (problems.length) {
  console.error(`check:explain FAILED (${problems.length} problem${problems.length > 1 ? 's' : ''}):`);
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log(`check:explain OK: every interactive element in ${count} .tsx files has data-explain, and no dashes found.`);
