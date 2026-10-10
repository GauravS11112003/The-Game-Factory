/**
 * #/tree/:levelId Tree (PLAN.md section 10). Owned by lane D.
 *
 * GET /api/levels/{id}/tree rendered as a nested list with CSS connector
 * lines; each node shows thumbnail, title, author and a Play link.
 */
import { getTree, type TreeNode } from '../api';
import { el, errorBox, errorMessage, fmtDate, link, plural, setTitle, spinner } from '../ui/dom';
import type { Cleanup, RouteCtx } from '../ui/router';
import { thumbnailFor } from '../ui/thumbnails';

function countNodes(node: TreeNode): number {
  return 1 + node.children.reduce((n, c) => n + countNodes(c), 0);
}

function renderNode(node: TreeNode, current: string): HTMLElement {
  const id = encodeURIComponent(node.id);
  const card = el(
    'div',
    { className: `tree-node card${node.id === current ? ' current' : ''}` },
    el('a', { href: `#/play/${id}`, className: 'tree-thumb' }, thumbnailFor(node.level, 160)),
    el(
      'div',
      { className: 'tree-body' },
      el('h3', null, node.title),
      el('p', { className: 'muted small' }, 'by ', node.author, ' · ', fmtDate(node.created_at), ' · ♥ ', String(node.likes)),
      el('div', { className: 'row' }, link(`#/play/${id}`, 'Play', 'btn primary tool'), link(`#/remix/${id}`, 'Remix', 'btn tool')),
    ),
  );
  const li = el('li', null, card);
  if (node.children.length) li.append(el('ul', null, ...node.children.map((c) => renderNode(c, current))));
  return li;
}

export async function render(root: HTMLElement, ctx: RouteCtx): Promise<Cleanup> {
  const id = ctx.params.id ?? '';
  let alive = true;
  root.append(spinner('Loading tree…'));
  try {
    const tree = await getTree(id);
    if (!alive) return;
    setTitle(`Remix tree: ${tree.title}`);
    const total = countNodes(tree);
    root.replaceChildren(
      el('h1', null, 'Remix tree'),
      el(
        'p',
        { className: 'muted' },
        plural(total - 1, 'remix', 'remixes'),
        ' under “',
        tree.title,
        '” by ',
        tree.author,
        tree.parent_id ? [' · ', link(`#/tree/${encodeURIComponent(tree.parent_id)}`, 'up to its parent')] : null,
      ),
      el('ul', { className: 'tree' }, renderNode(tree, id)),
    );
  } catch (err) {
    if (alive) root.replaceChildren(errorBox(`Couldn’t load the tree: ${errorMessage(err)}`, link('#/', 'Home', 'btn')));
  }
  return () => {
    alive = false;
  };
}
