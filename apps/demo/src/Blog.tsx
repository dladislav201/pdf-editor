import { formatDate, type Post } from './posts';
import { Footer } from './Footer';
import { useI18n } from './i18n';
import { Icon } from './icons';
import { BrandLink } from './Logo';
import { blogPath, landingPath } from './site';

/** The guides' top bar: back to the editor, and the list of guides, in the page's language. */
function BlogTop() {
  const { locale, t } = useI18n();
  return (
    <div className="home__top">
      <nav className="bar" aria-label={t.home.sections}>
        <div className="group">
          <BrandLink href={landingPath('home', locale)} />
          <a className="pill" href={blogPath(locale)}>
            {t.blog.guides}
          </a>
        </div>
      </nav>
    </div>
  );
}

/** The guides in the page's language. */
export function BlogIndex({ posts }: { posts: Post[] }) {
  const { locale, t } = useI18n();
  return (
    <main className="home blog">
      <BlogTop />
      <section className="home__hero">
        <h1>{t.blog.guides}</h1>
        <p>{t.blog.lead}</p>
      </section>
      <ul className="posts">
        {posts.map((post) => (
          <li key={post.path}>
            <a href={post.path}>
              <strong>{post.title}</strong>
              <span>{post.description}</span>
              <time dateTime={post.date}>
                {post.draft ? `${t.blog.draft} · ` : ''}
                {formatDate(post.date, locale)}
              </time>
            </a>
          </li>
        ))}
      </ul>
      <Footer current="blog" />
    </main>
  );
}

export function BlogPost({ post }: { post: Post }) {
  const { locale, t } = useI18n();
  return (
    <main className="home blog">
      <BlogTop />
      <article className="article">
        <p className="article__meta">
          <a href={blogPath(locale)}>{t.blog.guides}</a> · <time dateTime={post.date}>{formatDate(post.date, locale)}</time>
          {post.draft && ` · ${t.blog.draft}`}
        </p>
        <h1>{post.title}</h1>
        <div className="article__body" dangerouslySetInnerHTML={{ __html: post.html }} />
        <a className="article__cta" href={post.tool}>
          <span>
            <strong>{post.toolName}</strong>
            {t.blog.cta}
          </span>
          <span className="pill pill--ink">
            {t.blog.open} <Icon name="arrowRight" size={14} />
          </span>
        </a>
      </article>
      <Footer />
    </main>
  );
}
