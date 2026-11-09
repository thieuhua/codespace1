import { selectorSteps } from '../../../shared/content/mapping.js';
import { parseMarkup, descendants, textOf } from './markup.js';
export const parseHTML = source => parseMarkup(source);
export function extractHTML(root, selector, attribute) {
  const steps = selectorSteps(selector);
  // Scan in document order without duplicating descendants of overlapping parents.
  // Repeated ancestor selectors must not create combinatorial intermediate lists.
  const nodes = descendants(root);
  let parents = new Set([root]);
  for (const step of steps) {
    parents = new Set(nodes.filter(node => {
      if (!step.matches(node)) return false;
      for (let parent = node.parent; parent; parent = step.direct ? null : parent.parent) if (parents.has(parent)) return true;
      return false;
    }));
  }
  const node = parents.values().next().value;
  return node ? attribute ? node.attrs[attribute] || '' : textOf(node) : '';
}
