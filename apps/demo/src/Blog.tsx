import { formatDate, type Post } from './posts';
import { Footer } from './Footer';
import { Icon } from './icons';

/** The guides' top bar: back to the editor, and the list of guides. */
function BlogTop() {
  return (
    <div className="home__top">
      <nav className="bar" aria-label="Sections">
        <div className="group">
          <a className="pill pill--icon" href="/" aria-label="Home">
            <Icon name="home" />
          </a>
          <a className="pill" href="/blog">
            Guides
          </a>
        </div>
      </nav>
    </div>
  );
}

export function BlogIndex({ posts }: { posts: Post[] }) {
  return (
    <main className="home blog">
      <BlogTop />
      <section className="home__hero">
        <h1>Guides</h1>
        <p>How to get everyday PDF jobs done in your browser, step by step.</p>
      </section>
      <ul className="posts">
        {posts.map((post) => (
          <li key={post.slug}>
            <a href={`/blog/${post.slug}`}>
              <strong>{post.title}</strong>
              <span>{post.description}</span>
              <time dateTime={post.date}>{post.draft ? 'Draft · ' : ''}{formatDate(post.date)}</time>
            </a>
          </li>
        ))}
      </ul>
      <Footer current="blog" />
    </main>
  );
}

export function BlogPost({ post }: { post: Post }) {
  return (
    <main className="home blog">
      <BlogTop />
      <article className="article">
        <p className="article__meta">
          <a href="/blog">Guides</a> · <time dateTime={post.date}>{formatDate(post.date)}</time>
          {post.draft && ' · Draft'}
        </p>
        <h1>{post.title}</h1>
        <div className="article__body" dangerouslySetInnerHTML={{ __html: post.html }} />
        <a className="article__cta" href={post.tool}>
          <span>
            <strong>{post.toolName}</strong>
            Free, in your browser. Your file never leaves your device.
          </span>
          <span className="pill pill--ink">
            Open <Icon name="arrowRight" size={14} />
          </span>
        </a>
      </article>
      <Footer />
    </main>
  );
}
