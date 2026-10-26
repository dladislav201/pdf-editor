import { BlogIndex, BlogPost } from './Blog';
import { POSTS } from './posts';

/** The guides drawn in the browser: only while developing, since the build serves them as static pages. */
export default function BlogRoute({ path }: { path: string }) {
  const slug = path.replace(/^\/blog\/?/, '').replace(/\/$/, '');
  const post = slug && POSTS.find((p) => p.slug === slug);
  return post ? <BlogPost post={post} /> : <BlogIndex posts={POSTS} />;
}
