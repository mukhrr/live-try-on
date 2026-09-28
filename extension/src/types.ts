export type Product = {
  /** Highest-resolution candidate; may fail to load. */
  src: string;
  /** What the page was displaying; the fallback for src. */
  shownSrc: string;
  alt: string;
  /** alt, title, og:title, h1 and page title joined, most specific first. */
  name: string;
  pageUrl: string;
};
