// Build-time rendering of the start page, every tool page and the guides to
// static HTML (see scripts/prerender.mjs), so search engines and link
// previews see the words without running the app.
import { renderToString } from 'react-dom/server';
import { BlogIndex, BlogPost } from './Blog';
import { Home } from './Home';
import type { Post } from './posts';
import type { Landing } from './site';

export { POSTS } from './posts';
export { LANDINGS, SITE } from './site';

const nothing = () => undefined;

export function renderPage(page: Landing): string {
  return renderToString(
    <Home page={page} onOpen={nothing} onPictures={nothing} onSample={nothing} theme="light" onToggleTheme={nothing} />,
  );
}

export const renderBlogIndex = (posts: Post[]) => renderToString(<BlogIndex posts={posts} />);
export const renderPost = (post: Post) => renderToString(<BlogPost post={post} />);
