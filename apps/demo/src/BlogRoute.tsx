import { BlogIndex, BlogPost } from './Blog';
import { POSTS } from './posts';
import { blogRouteOf } from './site';

/** The guides drawn in the browser: only while developing, since the build serves them as static pages. */
export default function BlogRoute({ path }: { path: string }) {
  const { locale, slug } = blogRouteOf(path) ?? { locale: 'en', slug: '' };
  const posts = POSTS.filter((p) => p.locale === locale);
  const post = slug && posts.find((p) => p.slug === slug);
  return post ? <BlogPost post={post} /> : <BlogIndex posts={posts} />;
}
